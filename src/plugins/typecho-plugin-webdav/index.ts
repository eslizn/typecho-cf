import type { Database } from '@/db';
import { schema } from '@/db';
import type { PluginInitContext, PluginRouteResult } from '@/lib/plugin';
import { hasPermission, verifyPassword } from '@/lib/auth';
import { eq } from 'drizzle-orm';

type StorageProvider = 's3' | 'r2';

export interface WebDavConfig {
  routePath: string;
  mounts: StorageMount[];
  failBanEnabled: boolean;
  failBanMaxFailures: number;
  failBanWindowSeconds: number;
  failBanSeconds: number;
}

export interface StorageMount {
  mount: string;
  provider: StorageProvider;
  bindingName: string;
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  pathStyle: boolean;
}

interface WebDavRouteExtra {
  request?: Request;
  url?: URL;
  path?: string;
  db?: Database;
  options?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

interface ConfigValidationResult {
  success: boolean;
  settings?: Record<string, unknown>;
  error?: string;
}

interface S3Object {
  key: string;
  size: number;
  etag: string;
  lastModified: string;
}

interface S3ListResult {
  objects: S3Object[];
  prefixes: string[];
}

interface AuthFailureState {
  failures: number;
  windowStartedAt: number;
  bannedUntil: number;
}

const PLUGIN_ID = 'typecho-plugin-webdav';
const DEFAULT_ROUTE = '/webdav';
const LEGACY_DEFAULT_ROUTE = '/dav';
const DEFAULT_FAIL_BAN_ENABLED = true;
const DEFAULT_FAIL_BAN_MAX_FAILURES = 5;
const DEFAULT_FAIL_BAN_WINDOW_SECONDS = 300;
const DEFAULT_FAIL_BAN_SECONDS = 900;
const ALLOWED_METHODS = 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE';
const XML_HEADERS = { 'Content-Type': 'application/xml; charset=utf-8' };
const authFailureStates = new Map<string, AuthFailureState>();

const DEFAULT_MOUNTS = `[
  {
    "mount": "",
    "provider": "r2",
    "bindingName": "BUCKET",
    "prefix": ""
  }
]`;

function readObject(value: unknown): Record<string, unknown> {
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

function readPluginSettings(options?: Record<string, unknown>): Record<string, unknown> {
  return readObject(options?.[`plugin:${PLUGIN_ID}`]);
}

export function normalizeRoutePath(value: unknown): string {
  const raw = String(value || DEFAULT_ROUTE).trim();
  if (!raw || raw === '/') return DEFAULT_ROUTE;
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, '') || DEFAULT_ROUTE;
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
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

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
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
    const provider = String(record.provider || 's3').toLowerCase() as StorageProvider;
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

    if (!['s3', 'r2'].includes(provider)) {
      throw new Error(`挂载 ${mount} 的 provider 仅支持 s3 或 r2`);
    }

    if (provider === 'r2') {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bindingName)) {
        throw new Error(`挂载 ${mount} 的 R2 绑定名格式不正确`);
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

    return {
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
    };
  });
}

export function resolveWebDavTarget(
  config: WebDavConfig,
  relativePath: string,
): { mount: StorageMount; key: string; rootMount: boolean } | null {
  const rootMount = config.mounts.find(item => item.mount === '');
  if (rootMount) {
    return {
      mount: rootMount,
      key: splitPath(relativePath).join('/'),
      rootMount: true,
    };
  }

  const parts = splitPath(relativePath);
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
    mounts: parseMounts(settings?.mounts),
    failBanEnabled: parseBoolean(settings?.failBanEnabled, DEFAULT_FAIL_BAN_ENABLED),
    failBanMaxFailures: normalizeInteger(settings?.failBanMaxFailures, DEFAULT_FAIL_BAN_MAX_FAILURES, 1, 100),
    failBanWindowSeconds: normalizeInteger(settings?.failBanWindowSeconds, DEFAULT_FAIL_BAN_WINDOW_SECONDS, 10, 86_400),
    failBanSeconds: normalizeInteger(settings?.failBanSeconds, DEFAULT_FAIL_BAN_SECONDS, 10, 86_400),
  };
}

export function getWebDavClientIp(request: Request): string {
  const forwarded = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-real-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]
    || '';
  const ip = forwarded.trim();
  return ip || 'unknown';
}

export function isWebDavClientBanned(config: WebDavConfig, ip: string, now = Date.now()): boolean {
  if (!config.failBanEnabled) return false;
  const state = authFailureStates.get(ip);
  if (!state) return false;
  if (state.bannedUntil > now) return true;
  if (state.bannedUntil > 0) {
    authFailureStates.delete(ip);
  }
  return false;
}

export function recordWebDavAuthFailure(config: WebDavConfig, ip: string, now = Date.now()): void {
  if (!config.failBanEnabled) return;
  const windowMs = config.failBanWindowSeconds * 1000;
  const banMs = config.failBanSeconds * 1000;
  const current = authFailureStates.get(ip);
  const state = !current || now - current.windowStartedAt > windowMs
    ? { failures: 0, windowStartedAt: now, bannedUntil: 0 }
    : current;

  state.failures += 1;
  if (state.failures >= config.failBanMaxFailures) {
    state.bannedUntil = now + banMs;
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

function matchConfiguredWebDavRoute(
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

function unauthorized(message = 'Unauthorized'): Response {
  return new Response(message, {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Typecho WebDAV", charset="UTF-8"',
      'Cache-Control': 'no-store',
    },
  });
}

async function authenticate(
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

function splitPath(path: string): string[] {
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

function withMountPrefix(mount: StorageMount, key: string): string {
  const cleanKey = key.replace(/^\/+/, '');
  return [mount.prefix, cleanKey].filter(Boolean).join('/');
}

function stripMountPrefix(mount: StorageMount, key: string): string {
  if (!mount.prefix) return key;
  return key.startsWith(`${mount.prefix}/`) ? key.slice(mount.prefix.length + 1) : key;
}

function isCollectionPath(path: string): boolean {
  return path === '' || path.endsWith('/');
}

function href(routePath: string, parts: string[], collection = false): string {
  const base = normalizeRoutePath(routePath);
  const encoded = parts
    .filter(Boolean)
    .map(part => encodeURIComponent(part))
    .join('/');
  const path = encoded ? `${base}/${encoded}` : base;
  return collection && !path.endsWith('/') ? `${path}/` : path;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function responseXml(
  itemHref: string,
  displayName: string,
  collection: boolean,
  object?: Partial<S3Object>,
): string {
  const props = [
    `<d:displayname>${escapeXml(displayName)}</d:displayname>`,
    collection ? '<d:resourcetype><d:collection /></d:resourcetype>' : '<d:resourcetype />',
    object?.lastModified ? `<d:getlastmodified>${escapeXml(new Date(object.lastModified).toUTCString())}</d:getlastmodified>` : '',
    object?.etag ? `<d:getetag>${escapeXml(object.etag)}</d:getetag>` : '',
    !collection ? `<d:getcontentlength>${Number(object?.size || 0)}</d:getcontentlength>` : '',
  ].filter(Boolean).join('');

  return [
    '<d:response>',
    `<d:href>${escapeXml(itemHref)}</d:href>`,
    '<d:propstat>',
    `<d:prop>${props}</d:prop>`,
    '<d:status>HTTP/1.1 200 OK</d:status>',
    '</d:propstat>',
    '</d:response>',
  ].join('');
}

function multistatus(responses: string[]): Response {
  return new Response(`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`, {
    status: 207,
    headers: XML_HEADERS,
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function htmlPage(title: string, items: string[]): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeXml(title)}</title>`,
    '<style>',
    'body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:2rem;line-height:1.5;color:#1f2933;background:#fff}',
    'main{max-width:860px}',
    'h1{font-size:1.4rem;margin:0 0 1rem}',
    'ul{list-style:none;padding:0;margin:0;border-top:1px solid #d8dee4}',
    'li{border-bottom:1px solid #d8dee4}',
    'a{display:block;padding:.55rem 0;color:#0b5cad;text-decoration:none}',
    'a:hover{text-decoration:underline}',
    'p{color:#536471}',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeXml(title)}</h1>`,
    items.length > 0
      ? `<ul>${items.join('')}</ul>`
      : '<p>This WebDAV collection is empty.</p>',
    '</main>',
    '</body>',
    '</html>',
  ].join('');
}

function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: ALLOWED_METHODS,
      DAV: '1, 2',
      'MS-Author-Via': 'DAV',
      'Cache-Control': 'no-store',
    },
  });
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeKeyPath(key: string): string {
  return key.split('/').map(encodePathSegment).join('/');
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function shortDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const rawKey = key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value));
  return new Uint8Array(signature);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodePathSegment(key)}=${encodePathSegment(value)}`)
    .join('&');
}

function buildS3Url(mount: StorageMount, key: string, query: Record<string, string>): { url: string; host: string; canonicalUri: string; canonicalQuery: string } {
  const endpoint = new URL(mount.endpoint);
  if (!mount.pathStyle) {
    endpoint.hostname = `${mount.bucket}.${endpoint.hostname}`;
  }

  const encodedKey = encodeKeyPath(key);
  const canonicalUri = mount.pathStyle
    ? `/${encodePathSegment(mount.bucket)}${encodedKey ? `/${encodedKey}` : ''}`
    : `/${encodedKey}`;
  const queryString = canonicalQuery(query);
  const url = `${endpoint.protocol}//${endpoint.host}${canonicalUri}${queryString ? `?${queryString}` : ''}`;

  return {
    url,
    host: endpoint.host,
    canonicalUri,
    canonicalQuery: queryString,
  };
}

async function signS3Headers(
  mount: StorageMount,
  method: string,
  key: string,
  query: Record<string, string>,
  headers: Record<string, string>,
): Promise<{ url: string; headers: Headers }> {
  const now = new Date();
  const date = shortDate(now);
  const timestamp = amzDate(now);
  const urlParts = buildS3Url(mount, key, query);
  const normalizedHeaders: Record<string, string> = {
    ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.trim()])),
    host: urlParts.host,
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-amz-date': timestamp,
  };

  const signedHeaderNames = Object.keys(normalizedHeaders).sort();
  const canonicalHeaders = signedHeaderNames
    .map(name => `${name}:${normalizedHeaders[name]}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    method,
    urlParts.canonicalUri,
    urlParts.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const credentialScope = `${date}/${mount.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const encoder = new TextEncoder();
  const kDate = await hmac(encoder.encode(`AWS4${mount.secretAccessKey}`), date);
  const kRegion = await hmac(kDate, mount.region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  normalizedHeaders.authorization = [
    `AWS4-HMAC-SHA256 Credential=${mount.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ');

  return {
    url: urlParts.url,
    headers: new Headers(normalizedHeaders),
  };
}

async function s3Fetch(
  mount: StorageMount,
  method: string,
  key = '',
  query: Record<string, string> = {},
  headers: Record<string, string> = {},
  body?: BodyInit | null,
): Promise<Response> {
  const signed = await signS3Headers(mount, method, key, query, headers);
  return fetch(signed.url, {
    method,
    headers: signed.headers,
    body,
  });
}

function isR2BucketBinding(value: unknown): value is R2Bucket {
  return !!value
    && typeof value === 'object'
    && typeof (value as R2Bucket).get === 'function'
    && typeof (value as R2Bucket).put === 'function'
    && typeof (value as R2Bucket).delete === 'function'
    && typeof (value as R2Bucket).head === 'function'
    && typeof (value as R2Bucket).list === 'function';
}

function getR2Bucket(mount: StorageMount, workerEnv?: Record<string, unknown>): R2Bucket {
  const bucket = workerEnv?.[mount.bindingName || 'BUCKET'];
  if (!isR2BucketBinding(bucket)) {
    throw new Error(`R2 binding not found: ${mount.bindingName || 'BUCKET'}`);
  }
  return bucket;
}

async function listR2Objects(mount: StorageMount, prefix: string, workerEnv?: Record<string, unknown>): Promise<S3ListResult> {
  const bucket = getR2Bucket(mount, workerEnv);
  const objects: S3Object[] = [];
  const prefixes: string[] = [];
  let cursor: string | undefined;

  do {
    const result = await bucket.list({
      prefix,
      delimiter: '/',
      limit: 1000,
      cursor,
    });
    prefixes.push(...(result.delimitedPrefixes || []));
    objects.push(...(result.objects || []).map(object => ({
      key: object.key,
      size: object.size,
      etag: object.httpEtag || object.etag,
      lastModified: object.uploaded instanceof Date ? object.uploaded.toISOString() : String(object.uploaded || ''),
    })));
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  return { prefixes, objects };
}

async function listObjects(mount: StorageMount, prefix: string, workerEnv?: Record<string, unknown>): Promise<S3ListResult> {
  if (mount.provider === 'r2') {
    return listR2Objects(mount, prefix, workerEnv);
  }

  const response = await s3Fetch(mount, 'GET', '', {
    'delimiter': '/',
    'list-type': '2',
    'max-keys': '1000',
    'prefix': prefix,
  });
  if (!response.ok) {
    throw new Error(`List storage failed (${response.status})`);
  }

  const xml = await response.text();
  const prefixes = Array.from(xml.matchAll(/<CommonPrefixes>[\s\S]*?<Prefix>([\s\S]*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g))
    .map(match => decodeXml(match[1] || ''));
  const objects = Array.from(xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g))
    .map((match): S3Object => {
      const block = match[1] || '';
      return {
        key: decodeXml(block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] || ''),
        size: Number(block.match(/<Size>([\s\S]*?)<\/Size>/)?.[1] || 0),
        etag: decodeXml(block.match(/<ETag>([\s\S]*?)<\/ETag>/)?.[1] || ''),
        lastModified: decodeXml(block.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1] || ''),
      };
    });

  return { prefixes, objects };
}

async function objectMeta(mount: StorageMount, key: string, workerEnv?: Record<string, unknown>): Promise<S3Object | null> {
  if (mount.provider === 'r2') {
    const object = await getR2Bucket(mount, workerEnv).head(key);
    if (!object) return null;
    return {
      key: object.key,
      size: object.size,
      etag: object.httpEtag || object.etag,
      lastModified: object.uploaded instanceof Date ? object.uploaded.toISOString() : String(object.uploaded || ''),
    };
  }

  const response = await s3Fetch(mount, 'HEAD', key);
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) {
    throw new Error(`Read storage metadata failed (${response.status})`);
  }

  return {
    key,
    size: Number(response.headers.get('content-length') || 0),
    etag: response.headers.get('etag') || '',
    lastModified: response.headers.get('last-modified') || '',
  };
}

async function collectionExists(mount: StorageMount, prefix: string, workerEnv?: Record<string, unknown>): Promise<boolean> {
  const normalizedPrefix = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
  const listing = await listObjects(mount, normalizedPrefix, workerEnv);
  return listing.prefixes.length > 0 || listing.objects.length > 0;
}

async function propfindRoot(config: WebDavConfig, depth: string): Promise<Response> {
  const responses = [
    responseXml(href(config.routePath, [], true), 'WebDAV', true),
  ];

  if (depth !== '0') {
    for (const mount of config.mounts) {
      responses.push(responseXml(href(config.routePath, [mount.mount], true), mount.mount, true));
    }
  }

  return multistatus(responses);
}

async function browserRootListing(config: WebDavConfig, method: string): Promise<Response> {
  if (method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  const items = config.mounts.map(mount => {
    const label = mount.mount || 'Root storage';
    return `<li><a href="${escapeXml(href(config.routePath, [mount.mount], true))}">${escapeXml(label)}/</a></li>`;
  });
  return htmlResponse(htmlPage('WebDAV', items));
}

async function browserMountListing(
  config: WebDavConfig,
  mount: StorageMount,
  key: string,
  method: string,
  workerEnv?: Record<string, unknown>,
): Promise<Response> {
  if (method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  const cleanKey = key.replace(/^\/+|\/+$/g, '');
  const fullKey = withMountPrefix(mount, cleanKey);
  const prefix = fullKey && !fullKey.endsWith('/') ? `${fullKey}/` : fullKey;
  const listing = await listObjects(mount, prefix, workerEnv);
  const baseParts = [
    ...(mount.mount ? [mount.mount] : []),
    ...cleanKey.split('/').filter(Boolean),
  ];
  const items: string[] = [];
  const emittedCollections = new Set<string>();

  for (const itemPrefix of listing.prefixes) {
    const relative = stripMountPrefix(mount, itemPrefix).replace(/\/+$/, '');
    emittedCollections.add(relative);
    const display = relative.split('/').pop() || relative;
    items.push(`<li><a href="${escapeXml(href(config.routePath, [
      ...(mount.mount ? [mount.mount] : []),
      ...relative.split('/').filter(Boolean),
    ], true))}">${escapeXml(display)}/</a></li>`);
  }

  for (const object of listing.objects) {
    if (object.key === prefix) continue;
    const relative = stripMountPrefix(mount, object.key);
    if (object.key.endsWith('/')) {
      const collectionRelative = relative.replace(/\/+$/, '');
      if (!collectionRelative || emittedCollections.has(collectionRelative)) continue;
      emittedCollections.add(collectionRelative);
      const display = collectionRelative.split('/').pop() || collectionRelative;
      items.push(`<li><a href="${escapeXml(href(config.routePath, [
        ...(mount.mount ? [mount.mount] : []),
        ...collectionRelative.split('/').filter(Boolean),
      ], true))}">${escapeXml(display)}/</a></li>`);
      continue;
    }
    const normalizedCleanKey = cleanKey ? `${cleanKey}/` : '';
    if (relative.includes('/') && !relative.startsWith(normalizedCleanKey)) continue;
    const display = relative.split('/').pop() || relative;
    items.push(`<li><a href="${escapeXml(href(config.routePath, [
      ...(mount.mount ? [mount.mount] : []),
      ...relative.split('/').filter(Boolean),
    ], false))}">${escapeXml(display)}</a></li>`);
  }

  return htmlResponse(htmlPage(baseParts.length > 0 ? `WebDAV / ${baseParts.join('/')}` : 'WebDAV', items));
}

async function propfindMount(
  config: WebDavConfig,
  mount: StorageMount,
  key: string,
  depth: string,
  workerEnv?: Record<string, unknown>,
): Promise<Response> {
  const cleanKey = key.replace(/^\/+/, '');
  const fullKey = withMountPrefix(mount, cleanKey);
  const mountParts = [
    ...(mount.mount ? [mount.mount] : []),
    ...cleanKey.split('/').filter(Boolean),
  ];
  const responses: string[] = [];

  if (cleanKey === '' || isCollectionPath(key)) {
    const prefix = fullKey && !fullKey.endsWith('/') ? `${fullKey}/` : fullKey;
    const listing = await listObjects(mount, prefix, workerEnv);
    responses.push(responseXml(href(config.routePath, mountParts, true), mountParts.at(-1) || mount.mount || 'WebDAV', true));

    if (depth !== '0') {
      const emittedCollections = new Set<string>();
      for (const itemPrefix of listing.prefixes) {
        const relative = stripMountPrefix(mount, itemPrefix).replace(/\/+$/, '');
        emittedCollections.add(relative);
        const display = relative.split('/').pop() || relative;
        responses.push(responseXml(href(config.routePath, [
          ...(mount.mount ? [mount.mount] : []),
          ...relative.split('/').filter(Boolean),
        ], true), display, true));
      }
      for (const object of listing.objects) {
        if (object.key === prefix) continue;
        const relative = stripMountPrefix(mount, object.key);
        if (object.key.endsWith('/')) {
          const collectionRelative = relative.replace(/\/+$/, '');
          if (!collectionRelative || emittedCollections.has(collectionRelative)) continue;
          emittedCollections.add(collectionRelative);
          const display = collectionRelative.split('/').pop() || collectionRelative;
          responses.push(responseXml(href(config.routePath, [
            ...(mount.mount ? [mount.mount] : []),
            ...collectionRelative.split('/').filter(Boolean),
          ], true), display, true));
          continue;
        }
        if (relative.includes('/') && !relative.startsWith(cleanKey ? `${cleanKey.replace(/\/+$/, '')}/` : '')) continue;
        const display = relative.split('/').pop() || relative;
        responses.push(responseXml(href(config.routePath, [
          ...(mount.mount ? [mount.mount] : []),
          ...relative.split('/').filter(Boolean),
        ], false), display, false, object));
      }
    }
    return multistatus(responses);
  }

  const meta = await objectMeta(mount, fullKey, workerEnv);
  if (meta) {
    return multistatus([
      responseXml(href(config.routePath, mountParts, false), mountParts.at(-1) || cleanKey, false, meta),
    ]);
  }

  const existsAsCollection = await collectionExists(mount, fullKey, workerEnv);
  if (!existsAsCollection) return new Response('Not Found', { status: 404 });
  if (depth !== '0') {
    return propfindMount(config, mount, `${cleanKey}/`, depth, workerEnv);
  }
  return multistatus([
    responseXml(href(config.routePath, mountParts, true), mountParts.at(-1) || cleanKey, true),
  ]);
}

async function handleRead(
  method: string,
  mount: StorageMount,
  key: string,
  workerEnv?: Record<string, unknown>,
): Promise<Response> {
  const fullKey = withMountPrefix(mount, key);
  if (mount.provider === 'r2') {
    const object = await getR2Bucket(mount, workerEnv).get(fullKey);
    if (!object) return new Response('Not Found', { status: 404 });
    const headers = new Headers();
    if (object.size != null) headers.set('Content-Length', String(object.size));
    if (object.httpEtag || object.etag) headers.set('ETag', object.httpEtag || object.etag || '');
    if (object.uploaded) headers.set('Last-Modified', object.uploaded.toUTCString());
    if (object.httpMetadata?.contentType) headers.set('Content-Type', object.httpMetadata.contentType);
    return new Response(method === 'HEAD' ? null : object.body, { status: 200, headers });
  }

  const response = await s3Fetch(mount, method, fullKey);
  if (response.status === 404 || response.status === 403) {
    return new Response('Not Found', { status: 404 });
  }
  return response;
}

async function handlePut(
  request: Request,
  mount: StorageMount,
  key: string,
  workerEnv?: Record<string, unknown>,
): Promise<Response> {
  if (!key || key.endsWith('/')) return new Response('Invalid target', { status: 409 });
  const headers: Record<string, string> = {};
  const contentType = request.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;

  if (mount.provider === 'r2') {
    await getR2Bucket(mount, workerEnv).put(withMountPrefix(mount, key), request.body || '', {
      httpMetadata: contentType ? { contentType } : undefined,
    });
    return new Response(null, { status: 201 });
  }

  const response = await s3Fetch(mount, 'PUT', withMountPrefix(mount, key), {}, headers, request.body);
  if (!response.ok) return new Response('Storage write failed', { status: 502 });
  return new Response(null, { status: 201 });
}

async function handleMkcol(mount: StorageMount, key: string, workerEnv?: Record<string, unknown>): Promise<Response> {
  if (!key) return new Response('Method Not Allowed', { status: 405 });
  const dirKey = withMountPrefix(mount, key.endsWith('/') ? key : `${key}/`);
  if (mount.provider === 'r2') {
    await getR2Bucket(mount, workerEnv).put(dirKey, '', {
      httpMetadata: { contentType: 'application/x-directory' },
    });
    return new Response(null, { status: 201 });
  }

  const response = await s3Fetch(mount, 'PUT', dirKey, {}, { 'content-type': 'application/x-directory' }, '');
  if (!response.ok) return new Response('Storage write failed', { status: 502 });
  return new Response(null, { status: 201 });
}

async function handleDelete(mount: StorageMount, key: string, workerEnv?: Record<string, unknown>): Promise<Response> {
  if (!key) return new Response('Cannot delete mount root', { status: 409 });

  if (key.endsWith('/')) {
    const prefix = withMountPrefix(mount, key);
    const listing = await listObjects(mount, prefix, workerEnv);
    if (listing.prefixes.length > 0 || listing.objects.some(object => object.key !== prefix)) {
      return new Response('Directory is not empty', { status: 409 });
    }
  }

  if (mount.provider === 'r2') {
    await getR2Bucket(mount, workerEnv).delete(withMountPrefix(mount, key));
    return new Response(null, { status: 204 });
  }

  const response = await s3Fetch(mount, 'DELETE', withMountPrefix(mount, key));
  if (!response.ok && response.status !== 404) return new Response('Storage delete failed', { status: 502 });
  return new Response(null, { status: 204 });
}

function resolveDestination(config: WebDavConfig, destinationHeader: string | null): { mountName: string; key: string } | null {
  if (!destinationHeader) return null;
  let pathname = destinationHeader;
  try {
    pathname = new URL(destinationHeader).pathname;
  } catch {
    // Relative Destination headers are allowed by some clients.
  }

  const relative = matchWebDavRoute(config.routePath, pathname);
  if (relative === null) return null;
  const target = resolveWebDavTarget(config, relative);
  if (!target) return null;
  return { mountName: target.mount.mount, key: target.key };
}

async function handleCopyMove(
  request: Request,
  config: WebDavConfig,
  sourceMount: StorageMount,
  sourceKey: string,
  move: boolean,
  workerEnv?: Record<string, unknown>,
): Promise<Response> {
  if (!sourceKey || sourceKey.endsWith('/')) return new Response('Collection copy is not supported', { status: 409 });

  const destination = resolveDestination(config, request.headers.get('destination'));
  if (!destination) return new Response('Invalid Destination', { status: 400 });
  if (destination.mountName !== sourceMount.mount || !destination.key || destination.key.endsWith('/')) {
    return new Response('Cross-mount or collection copy is not supported', { status: 409 });
  }

  const overwrite = (request.headers.get('overwrite') || 'T').toUpperCase() !== 'F';
  if (!overwrite) {
    const existing = await objectMeta(sourceMount, withMountPrefix(sourceMount, destination.key), workerEnv);
    if (existing) return new Response('Precondition Failed', { status: 412 });
  }

  if (sourceMount.provider === 'r2') {
    const bucket = getR2Bucket(sourceMount, workerEnv);
    const sourceObject = await bucket.get(withMountPrefix(sourceMount, sourceKey));
    if (!sourceObject) return new Response('Not Found', { status: 404 });

    await bucket.put(withMountPrefix(sourceMount, destination.key), sourceObject.body, {
      httpMetadata: sourceObject.httpMetadata,
    });
    if (move) {
      await bucket.delete(withMountPrefix(sourceMount, sourceKey));
    }
    return new Response(null, { status: 201 });
  }

  const copySource = `/${encodePathSegment(sourceMount.bucket)}/${encodeKeyPath(withMountPrefix(sourceMount, sourceKey))}`;
  const copyResponse = await s3Fetch(
    sourceMount,
    'PUT',
    withMountPrefix(sourceMount, destination.key),
    {},
    { 'x-amz-copy-source': copySource },
  );
  if (!copyResponse.ok) return new Response('Storage copy failed', { status: 502 });

  if (move) {
    const deleteResponse = await s3Fetch(sourceMount, 'DELETE', withMountPrefix(sourceMount, sourceKey));
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      return new Response('Storage move cleanup failed', { status: 502 });
    }
  }

  return new Response(null, { status: 201 });
}

async function handleWebDavRequest(config: WebDavConfig, relativePath: string, extra: WebDavRouteExtra): Promise<Response> {
  const request = extra.request!;
  if (request.method === 'OPTIONS') return optionsResponse();

  if (!extra.db) return new Response('Database unavailable', { status: 503 });
  const clientIp = getWebDavClientIp(request);
  const hasBasicAuthAttempt = /^Basic\s+/i.test(request.headers.get('authorization') || '');
  if (hasBasicAuthAttempt && isWebDavClientBanned(config, clientIp)) {
    return new Response('Too many failed login attempts', {
      status: 429,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(config.failBanSeconds),
      },
    });
  }

  const authResult = await authenticate(request, extra.db);
  if (authResult instanceof Response) {
    if (hasBasicAuthAttempt && authResult.status === 401) {
      recordWebDavAuthFailure(config, clientIp);
    }
    return authResult;
  }
  if (hasBasicAuthAttempt) {
    clearWebDavAuthFailures(clientIp);
  }

  const depthHeader = (request.headers.get('depth') || '1').toLowerCase();
  const depth = depthHeader === 'infinity' ? '1' : depthHeader;
  if (request.method === 'PROPFIND' && !['0', '1'].includes(depth)) {
    return new Response('Unsupported Depth', { status: 400 });
  }

  const target = resolveWebDavTarget(config, relativePath);
  if (!target) {
    if (request.method === 'PROPFIND') return propfindRoot(config, depth);
    if (request.method === 'GET' || request.method === 'HEAD') return browserRootListing(config, request.method);
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'OPTIONS, PROPFIND' } });
  }

  const { mount, key } = target;
  const workerEnv = extra.env;
  const propfindKey = relativePath.endsWith('/') && key ? `${key}/` : key || (relativePath.endsWith('/') ? '/' : '');
  switch (request.method) {
    case 'PROPFIND':
      return propfindMount(config, mount, propfindKey, depth, workerEnv);
    case 'GET':
    case 'HEAD':
      if (!key || relativePath.endsWith('/')) {
        return browserMountListing(config, mount, key, request.method, workerEnv);
      }
      {
        const readResponse = await handleRead(request.method, mount, key, workerEnv);
        if (readResponse.status !== 404) return readResponse;
        if (await collectionExists(mount, withMountPrefix(mount, key), workerEnv)) {
          return browserMountListing(config, mount, key, request.method, workerEnv);
        }
        return readResponse;
      }
    case 'PUT':
      return handlePut(request, mount, key, workerEnv);
    case 'MKCOL':
      return handleMkcol(mount, key, workerEnv);
    case 'DELETE':
      return handleDelete(mount, key, workerEnv);
    case 'COPY':
      return handleCopyMove(request, config, mount, key, false, workerEnv);
    case 'MOVE':
      return handleCopyMove(request, config, mount, key, true, workerEnv);
    default:
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: ALLOWED_METHODS } });
  }
}

export default function init({ addHook, pluginId }: PluginInitContext): void {
  addHook(
    'plugin:config:beforeSave',
    pluginId,
    (result: ConfigValidationResult, extra?: { pluginId?: string; settings?: Record<string, unknown> }) => {
      if (extra?.pluginId !== pluginId) return result;

      try {
        const config = normalizeConfig(extra.settings || {});
        return {
          success: true,
          settings: {
            routePath: config.routePath,
            mounts: config.mounts,
            failBanEnabled: config.failBanEnabled,
            failBanMaxFailures: config.failBanMaxFailures,
            failBanWindowSeconds: config.failBanWindowSeconds,
            failBanSeconds: config.failBanSeconds,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'WebDAV 配置校验失败',
        };
      }
    },
  );

  addHook(
    'route:request',
    pluginId,
    async (result: PluginRouteResult, extra?: WebDavRouteExtra) => {
      if (result?.handled || !extra?.request || !extra.path) return result;

      const settings = readPluginSettings(extra.options);
      const routeMatch = matchConfiguredWebDavRoute(settings, extra.path);
      if (!routeMatch) return result;

      let config: WebDavConfig;
      try {
        config = normalizeConfig(settings);
        config.routePath = routeMatch.routePath;
      } catch (error) {
        console.error('[webdav] Invalid configuration:', error);
        return {
          handled: true,
          response: new Response('WebDAV plugin is not configured', { status: 503 }),
        };
      }

      try {
        return {
          handled: true,
          response: await handleWebDavRequest(config, routeMatch.relativePath, extra),
        };
      } catch (error) {
        console.error('[webdav] Request failed:', error);
        return {
          handled: true,
          response: new Response('WebDAV storage error', { status: 502 }),
        };
      }
    },
  );
}
