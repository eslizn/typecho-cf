import { getClientIp, hasPermission, verifyPassword } from 'typecho/plugin-sdk';
import type { Database } from 'typecho/db';
import { schema } from 'typecho/db';
import { eq } from 'drizzle-orm';
import { PLUGIN_ID } from './types';
import type { StorageMount, WebDavConfig, S3Object, S3ListResult } from './types';

// Re-export types that dependents need
export type { WebDavConfig, StorageMount, S3Object, S3ListResult };

// --- Internals used by other modules ---

interface AuthFailureState {
  failures: number;
  windowStartedAt: number;
  bannedUntil: number;
  expiresAt: number;
}

export const DEFAULT_ROUTE = '/webdav';
export const LEGACY_DEFAULT_ROUTE = '/dav';
const DEFAULT_FAIL_BAN_ENABLED = true;
const DEFAULT_FAIL_BAN_MAX_FAILURES = 5;
const DEFAULT_FAIL_BAN_WINDOW_SECONDS = 300;
const DEFAULT_FAIL_BAN_SECONDS = 900;
export const MAX_AUTH_FAILURE_STATES = 2_048;
const AUTH_FAILURE_SWEEP_INTERVAL = 64;

const DEFAULT_MOUNTS = `[
  {
    "mount": "/",
    "provider": "r2",
    "bindingName": "BUCKET",
    "prefix": ""
  }
]`;

const authFailureStates = new Map<string, AuthFailureState>();
let authFailureOperations = 0;

function pruneAuthFailureStates(now: number): void {
  for (const [ip, state] of authFailureStates) {
    if (state.expiresAt <= now) authFailureStates.delete(ip);
  }
}

function sweepExpiredAuthFailureStates(now: number): void {
  authFailureOperations += 1;
  if (authFailureOperations % AUTH_FAILURE_SWEEP_INTERVAL === 0) {
    pruneAuthFailureStates(now);
  }
}

// Mounts whose sessionCookie came from the plugin config (not a password
// login). User-supplied cookies must never be silently cleared to fall back
// to password login, which can hang when the login host is unreachable.
const explicitCookieMounts = new WeakSet<StorageMount>();

export function hasExplicitSessionCookie(mount: StorageMount): boolean {
  return explicitCookieMounts.has(mount);
}

// --- Config helpers ---

export function readObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function readPluginSettings(options?: Record<string, unknown>): Record<string, unknown> {
  return readObject(options?.[`plugin:${PLUGIN_ID}`]);
}

export function normalizeRoutePath(value: unknown): string {
  const raw = String(value || DEFAULT_ROUTE).trim();
  if (!raw || raw === '/') return DEFAULT_ROUTE;
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, '') || DEFAULT_ROUTE;
}

export function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function normalizePrefix(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

export function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
    if (value === '1') return true;
    if (value === '0') return false;
  }
  return fallback;
}

export function parseMounts(value: unknown): StorageMount[] {
  const source = value === undefined || value === null || (typeof value === 'string' && !value.trim())
    ? DEFAULT_MOUNTS
    : value;
  let parsed: unknown;
  if (typeof source === 'string') {
    parsed = JSON.parse(source);
  } else {
    parsed = source;
  }

  if (!Array.isArray(parsed)) {
    throw new Error('后端存储挂载必须是 JSON 数组');
  }
  if (parsed.length === 0) {
    throw new Error('至少配置一个后端存储挂载');
  }

  const seen = new Set<string>();
  return parsed.map((item, index): StorageMount => {
    if (!item || typeof item !== 'object') {
      throw new Error(`第 ${index + 1} 个挂载配置不是对象`);
    }

    const record = item as Record<string, unknown>;
    const rawMount = String(record.mount ?? '').trim();
    const mount = rawMount === '/' ? '' : rawMount.replace(/^\/+|\/+$/g, '');
    const provider = String(record.provider || 's3').toLowerCase() as StorageMount['provider'];
    const bindingName = String(record.bindingName || record.binding || 'BUCKET').trim();
    const endpoint = String(record.endpoint || '').trim().replace(/\/+$/, '');
    const bucket = String(record.bucket || '').trim();
    const region = String(record.region || (provider === 'r2' ? 'auto' : 'us-east-1')).trim();
    const accessKeyId = String(record.accessKeyId || '').trim();
    const secretAccessKey = String(record.secretAccessKey || '');
    const prefix = normalizePrefix(record.prefix);
    const pathStyle = parseBoolean(record.pathStyle, provider === 'r2');

    if (mount === '' && parsed.length > 1) {
      throw new Error('根目录挂载不能与其他挂载共存');
    }
    if (mount && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(mount)) {
      throw new Error(`第 ${index + 1} 个挂载 mount 只能包含字母、数字、点、下划线和连字符`);
    }
    if (seen.has(mount)) {
      throw new Error(`挂载目录重复：${mount}`);
    }
    seen.add(mount);

    if (!['s3', 'r2', 'tianyi'].includes(provider)) {
      throw new Error(`挂载 ${mount} 的 provider 仅支持 s3、r2 或 tianyi`);
    }

    const username = String(record.username || '').trim();
    const password = String(record.password || '');
    const rootDir = String(record.rootDir || '-11').trim();
    const sessionCookie = String(record.sessionCookie || '').trim();

    if (provider === 'r2') {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bindingName)) {
        throw new Error(`挂载 ${mount} 的 R2 绑定名格式不正确`);
      }
    } else if (provider === 'tianyi') {
      if (!username && !sessionCookie) {
        throw new Error(`挂载 ${mount} 的天翼云盘需要填写用户名和密码，或填写已登录的 Cookie`);
      }
    } else {
      try {
        const url = new URL(endpoint);
        if (!['https:', 'http:'].includes(url.protocol)) {
          throw new Error('invalid protocol');
        }
      } catch {
        throw new Error(`挂载 ${mount} 的 endpoint 格式不正确`);
      }
      if (!bucket || !region || !accessKeyId || !secretAccessKey) {
        throw new Error(`挂载 ${mount} 需要填写 bucket、region、accessKeyId 和 secretAccessKey`);
      }
    }

    const mountConfig: StorageMount = {
      mount,
      provider,
      bindingName,
      endpoint,
      bucket,
      region,
      accessKeyId,
      secretAccessKey,
      prefix,
      pathStyle,
      username,
      password,
      rootDir,
      sessionCookie,
    };
    if (sessionCookie) explicitCookieMounts.add(mountConfig);
    return mountConfig;
  });
}

// --- Path utilities ---

export function splitPath(path: string): string[] {
  return path
    .split('/')
    .filter(Boolean)
    .map(segment => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

export function hasPathTraversal(segments: string[]): boolean {
  return segments.some(s => s === '..' || s === '.' || s.includes('\0'));
}

export function withMountPrefix(mount: StorageMount, key: string): string {
  const cleanKey = key.replace(/^\/+/, '');
  return [mount.prefix, cleanKey].filter(Boolean).join('/');
}

export function stripMountPrefix(mount: StorageMount, key: string): string {
  if (!mount.prefix) return key;
  return key.startsWith(`${mount.prefix}/`) ? key.slice(mount.prefix.length + 1) : key;
}

export function isCollectionPath(path: string): boolean {
  return path === '' || path.endsWith('/');
}

export function href(routePath: string, parts: string[], collection = false): string {
  const base = normalizeRoutePath(routePath);
  const encoded = parts
    .filter(Boolean)
    .map(part => encodeURIComponent(part))
    .join('/');
  const path = encoded ? `${base}/${encoded}` : base;
  return collection && !path.endsWith('/') ? `${path}/` : path;
}

// --- Target resolution ---

export function resolveWebDavTarget(
  config: WebDavConfig,
  relativePath: string,
): { mount: StorageMount; key: string; rootMount: boolean } | null {
  const rootMount = config.mounts.find(item => item.mount === '');
  if (rootMount) {
    const segments = splitPath(relativePath);
    if (hasPathTraversal(segments)) return null;
    return {
      mount: rootMount,
      key: segments.join('/'),
      rootMount: true,
    };
  }

  const parts = splitPath(relativePath);
  if (hasPathTraversal(parts)) return null;
  const mountName = parts.shift() || '';
  if (!mountName) return null;

  const mount = config.mounts.find(item => item.mount === mountName);
  if (!mount) return null;

  return {
    mount,
    key: parts.join('/'),
    rootMount: false,
  };
}

export function normalizeConfig(settings?: Record<string, unknown>): WebDavConfig {
  return {
    routePath: normalizeRoutePath(settings?.routePath),
    protocolEnabled: parseBoolean(settings?.protocolEnabled, true),
    mounts: parseMounts(settings?.mounts),
    failBanEnabled: parseBoolean(settings?.failBanEnabled, DEFAULT_FAIL_BAN_ENABLED),
    failBanMaxFailures: normalizeInteger(settings?.failBanMaxFailures, DEFAULT_FAIL_BAN_MAX_FAILURES, 1, 100),
    failBanWindowSeconds: normalizeInteger(settings?.failBanWindowSeconds, DEFAULT_FAIL_BAN_WINDOW_SECONDS, 10, 86_400),
    failBanSeconds: normalizeInteger(settings?.failBanSeconds, DEFAULT_FAIL_BAN_SECONDS, 10, 86_400),
    fileListPageSize: normalizeInteger(settings?.fileListPageSize, 50, 1, 200),
  };
}

// --- Auth / Fail-ban ---

export function getWebDavClientIp(request: Request): string {
  return getClientIp(request) || 'unknown';
}

export function isWebDavClientBanned(config: WebDavConfig, ip: string, now = Date.now()): boolean {
  if (!config.failBanEnabled) return false;
  sweepExpiredAuthFailureStates(now);
  const state = authFailureStates.get(ip);
  if (!state) return false;
  if (state.expiresAt <= now) {
    authFailureStates.delete(ip);
    return false;
  }
  if (state.bannedUntil > now) return true;
  if (state.bannedUntil > 0) authFailureStates.delete(ip);
  return false;
}

export function recordWebDavAuthFailure(config: WebDavConfig, ip: string, now = Date.now()): void {
  if (!config.failBanEnabled) return;
  const windowMs = config.failBanWindowSeconds * 1000;
  const banMs = config.failBanSeconds * 1000;
  sweepExpiredAuthFailureStates(now);
  const current = authFailureStates.get(ip);
  if (current && current.expiresAt <= now) authFailureStates.delete(ip);
  const usableCurrent = current && current.expiresAt > now ? current : undefined;
  const state = !usableCurrent || now - usableCurrent.windowStartedAt > windowMs
    ? { failures: 0, windowStartedAt: now, bannedUntil: 0, expiresAt: now + windowMs }
    : usableCurrent;

  state.failures += 1;
  if (state.failures >= config.failBanMaxFailures) {
    state.bannedUntil = now + banMs;
  }
  state.expiresAt = Math.max(state.windowStartedAt + windowMs, state.bannedUntil);
  authFailureStates.delete(ip);
  if (!usableCurrent && authFailureStates.size >= MAX_AUTH_FAILURE_STATES) {
    pruneAuthFailureStates(now);
    if (authFailureStates.size >= MAX_AUTH_FAILURE_STATES) {
      // Preserve active bans. At capacity, new untracked IPs fail open until
      // space is reclaimed; the map remains bounded and current bans survive.
      const oldestUnbanned = [...authFailureStates].find(([, existing]) => existing.bannedUntil <= now);
      if (oldestUnbanned) authFailureStates.delete(oldestUnbanned[0]);
      else return;
    }
  }
  authFailureStates.set(ip, state);
}

export function clearWebDavAuthFailures(ip: string): void {
  authFailureStates.delete(ip);
}

export function matchWebDavRoute(routePath: string, pathname: string): string | null {
  const normalized = normalizeRoutePath(routePath);
  if (pathname === normalized) return '';
  if (pathname.startsWith(`${normalized}/`)) {
    return pathname.slice(normalized.length + 1);
  }
  return null;
}

export function matchConfiguredWebDavRoute(
  settings: Record<string, unknown>,
  pathname: string,
): { routePath: string; relativePath: string } | null {
  const configuredRoutePath = normalizeRoutePath(settings.routePath);
  const configuredRelative = matchWebDavRoute(configuredRoutePath, pathname);
  if (configuredRelative !== null) {
    return { routePath: configuredRoutePath, relativePath: configuredRelative };
  }

  if (configuredRoutePath === LEGACY_DEFAULT_ROUTE) {
    const defaultRelative = matchWebDavRoute(DEFAULT_ROUTE, pathname);
    if (defaultRelative !== null) {
      return { routePath: DEFAULT_ROUTE, relativePath: defaultRelative };
    }
  }

  return null;
}

export function parseBasicCredentials(header: string | null): { username: string; password: string } | null {
  const match = (header || '').match(/^Basic\s+(.+)$/i);
  if (!match) return null;

  try {
    const binary = atob(match[1]);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

export function unauthorized(message = 'Unauthorized'): Response {
  return new Response(message, {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Typecho WebDAV", charset="UTF-8"',
      'Cache-Control': 'no-store',
    },
  });
}

export async function authenticate(
  request: Request,
  db: Database,
): Promise<Response | true> {
  const credentials = parseBasicCredentials(request.headers.get('authorization'));
  if (!credentials?.username || !credentials.password) {
    return unauthorized();
  }

  const user = await db.query.users.findFirst({
    where: eq(schema.users.name, credentials.username),
  });
  if (!user || !user.password) {
    return unauthorized();
  }

  const passwordResult = await verifyPassword(credentials.password, user.password);
  if (passwordResult === 'needs_reset') {
    return unauthorized('Password reset required');
  }
  if (passwordResult !== true) {
    return unauthorized();
  }
  if (!hasPermission(user.group || 'visitor', 'administrator')) {
    return unauthorized('Administrator account required');
  }

  return true;
}

// --- URL encoding helpers ---

export function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function encodeKeyPath(key: string): string {
  return key.split('/').map(encodePathSegment).join('/');
}
