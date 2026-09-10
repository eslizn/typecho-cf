import { encodePathSegment, encodeKeyPath, withMountPrefix, hasExplicitSessionCookie } from './config';
import type { StorageMount, S3Object, S3ListResult } from './types';
import { fetchWithTimeout } from 'typecho/plugin-sdk';

// --- Constants ---

export const TIANYI_API_BASE = 'https://cloud.189.cn';
export const TIANYI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TIANYI_ROOT_FOLDERS: Record<string, string> = {
  '同步盘': '-14',
};

const TIANYI_LIST_PARAMS: Record<string, string> = {
  pageSize: '60', mediaType: '0', iconOption: '5',
  orderBy: 'lastOpTime', descending: 'true',
};

// Generated Tianyi cookies are safe to reuse across requests in one Worker
// isolate. Store only a credential hash as the key, bound memory usage, and
// coalesce concurrent logins so a burst does not authenticate repeatedly.
const TIANYI_SESSION_CACHE_TTL_MS = 30 * 60 * 1000;
const TIANYI_SESSION_CACHE_MAX_ENTRIES = 64;
interface TianyiSessionCacheEntry {
  cookie: string;
  expiresAt: number;
}
const tianyiSessionCache = new Map<string, TianyiSessionCacheEntry>();
const pendingTianyiLogins = new Map<string, Promise<string>>();
let tianyiSessionCacheGeneration = 0;

async function tianyiCredentialKey(mount: StorageMount): Promise<string> {
  const credentialBytes = new TextEncoder().encode(`${mount.username}\0${mount.password}`);
  const digest = await crypto.subtle.digest('SHA-256', credentialBytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function readCachedTianyiSession(key: string, now = Date.now()): string | null {
  const cached = tianyiSessionCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    tianyiSessionCache.delete(key);
    return null;
  }
  // Refresh insertion order to approximate LRU eviction.
  tianyiSessionCache.delete(key);
  tianyiSessionCache.set(key, cached);
  return cached.cookie;
}

function cacheTianyiSession(key: string, cookie: string, generation: number): void {
  if (!cookie || generation !== tianyiSessionCacheGeneration) return;
  const now = Date.now();
  for (const [cachedKey, entry] of tianyiSessionCache) {
    if (entry.expiresAt <= now) tianyiSessionCache.delete(cachedKey);
  }
  tianyiSessionCache.delete(key);
  while (tianyiSessionCache.size >= TIANYI_SESSION_CACHE_MAX_ENTRIES) {
    const oldestKey = tianyiSessionCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    tianyiSessionCache.delete(oldestKey);
  }
  tianyiSessionCache.set(key, { cookie, expiresAt: now + TIANYI_SESSION_CACHE_TTL_MS });
}

async function invalidateGeneratedTianyiSession(mount: StorageMount): Promise<void> {
  if (!mount.username || !mount.password) return;
  tianyiSessionCache.delete(await tianyiCredentialKey(mount));
}

/** Clear generated sessions after configuration changes and in tests. */
export function clearTianyiSessionCache(): void {
  tianyiSessionCacheGeneration += 1;
  tianyiSessionCache.clear();
  pendingTianyiLogins.clear();
}

// --- RSA Encryption (PKCS#1 v1.5, manual implementation for CF Workers) ---

function base64UrlToBigInt(b64url: string): bigint {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  const padded = pad ? b64 + '='.repeat(4 - pad) : b64;
  const bytes = atob(padded);
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes.charCodeAt(i));
  }
  return result;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

async function rsaEncrypt(data: string, pubKeyBody: string): Promise<string> {
  const raw = atob(pubKeyBody);
  const der = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) der[i] = raw.charCodeAt(i);

  const cryptoKey = await crypto.subtle.importKey(
    'spki',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', cryptoKey);
  const n = base64UrlToBigInt(jwk.n!);
  const e = base64UrlToBigInt(jwk.e!);

  const k = Math.ceil(n.toString(16).length / 2);
  const msgBytes = new TextEncoder().encode(data);
  const psLen = k - msgBytes.length - 3;
  if (psLen < 8) throw new Error('RSA encrypt: message too long');

  const block = new Uint8Array(k);
  block[0] = 0x00;
  block[1] = 0x02;
  crypto.getRandomValues(block.subarray(2, 2 + psLen));
  for (let i = 2; i < 2 + psLen; i++) {
    while (block[i] === 0) block[i] = (Math.random() * 255 + 1) | 0;
  }
  block[2 + psLen] = 0x00;
  block.set(msgBytes, 2 + psLen + 1);

  let m = 0n;
  for (let i = 0; i < block.length; i++) {
    m = (m << 8n) | BigInt(block[i]);
  }

  const c = modPow(m, e, n);
  return c.toString(16).padStart(k * 2, '0');
}

// --- Tianyi Cloud Disk Login ---

function collectCookie(cookies: string[], headers: Headers): void {
  const setCookieValues = headers.getSetCookie();
  for (const setCookie of setCookieValues) {
    const semi = setCookie.indexOf(';');
    const pair = semi >= 0 ? setCookie.slice(0, semi).trim() : setCookie.trim();
    if (pair && pair.includes('=') && !cookies.includes(pair)) {
      cookies.push(pair);
    }
  }
}

async function followRedirects(url: string, cookies: string[], referer?: string): Promise<{ finalUrl: string; cookies: string[] }> {
  const collected = [...cookies];
  let currentUrl = url;
  let currentReferer = referer || 'https://cloud.189.cn/';

  for (let i = 0; i < 10; i++) {
    const resp = await fetchWithTimeout(
      currentUrl,
      {
        redirect: 'manual',
        headers: {
          Cookie: collected.join('; '),
          Referer: currentReferer,
          'User-Agent': TIANYI_UA,
        },
      },
      10_000,
      '天翼云盘登录请求超时：cloud.189.cn 无法从当前网络访问，请在插件配置中改用已登录的 Cookie',
    );

    collectCookie(collected, resp.headers);

    const location = resp.headers.get('Location');
    if (resp.status >= 300 && resp.status < 400 && location) {
      currentReferer = currentUrl;
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return { finalUrl: currentUrl, cookies: collected };
  }

  return { finalUrl: currentUrl, cookies: collected };
}

async function tianyiLogin(username: string, password: string): Promise<string> {
  const cookies: string[] = [];

  const { finalUrl, cookies: redirectCookies } = await followRedirects(
    'https://cloud.189.cn/api/portal/loginUrl.action?redirectURL=https%3A%2F%2Fcloud.189.cn%2Fmain.action',
    cookies
  );
  for (const c of redirectCookies) {
    if (!cookies.includes(c)) cookies.push(c);
  }
  if (finalUrl === 'https://cloud.189.cn/web/main') {
    return cookies.join('; ');
  }

  const redirectUrl = new URL(finalUrl);
  const lt = redirectUrl.searchParams.get('lt') || '';
  const reqId = redirectUrl.searchParams.get('reqId') || '';
  const appId = redirectUrl.searchParams.get('appId') || '';

  const stepHeaders: Record<string, string> = {
    'lt': lt,
    'reqid': reqId,
    'referer': finalUrl,
    'origin': 'https://open.e.189.cn',
    'User-Agent': TIANYI_UA,
    'Accept': 'application/json;charset=UTF-8',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cookie': cookies.join('; '),
  };

  const appConfResp = await fetchWithTimeout('https://open.e.189.cn/api/logbox/oauth2/appConf.do', {
    method: 'POST',
    headers: stepHeaders,
    body: new URLSearchParams({ version: '2.0', appKey: appId }).toString(),
  });
  collectCookie(cookies, appConfResp.headers);
  stepHeaders['Cookie'] = cookies.join('; ');

  const appConf = await appConfResp.json() as Record<string, unknown>;
  if (appConf.result !== 0 && appConf.result !== '0') {
    throw new Error(`天翼云盘获取应用配置失败: ${appConf.msg || appConf.result}`);
  }
  const appData = (appConf.data || {}) as Record<string, unknown>;

  const encResp = await fetchWithTimeout('https://open.e.189.cn/api/logbox/config/encryptConf.do', {
    method: 'POST',
    headers: stepHeaders,
    body: new URLSearchParams({ appId }).toString(),
  });
  collectCookie(cookies, encResp.headers);
  stepHeaders['Cookie'] = cookies.join('; ');

  const encConf = await encResp.json() as Record<string, unknown>;
  if (encConf.result !== 0) {
    throw new Error(`天翼云盘获取加密配置失败: ${encConf.msg || encConf.result}`);
  }
  const encData = (encConf.data || {}) as Record<string, unknown>;
  const pubKey = String(encData.pubKey || '');
  const pre = String(encData.pre || '');

  const encUsername = pre + await rsaEncrypt(username, pubKey);
  const encPassword = pre + await rsaEncrypt(password, pubKey);

  const loginData: Record<string, string> = {
    version: 'v2.0',
    apToken: '',
    appKey: appId,
    accountType: String(appData.accountType || ''),
    userName: encUsername,
    epd: encPassword,
    captchaType: '',
    validateCode: '',
    smsValidateCode: '',
    captchaToken: '',
    returnUrl: String(appData.returnUrl || ''),
    mailSuffix: String(appData.mailSuffix || ''),
    dynamicCheck: 'FALSE',
    clientType: String(appData.clientType || ''),
    cb_SaveName: '3',
    isOauth2: String(appData.isOauth2 || 'false'),
    state: '',
    paramId: String(appData.paramId || ''),
  };

  const loginResp = await fetchWithTimeout('https://open.e.189.cn/api/logbox/oauth2/loginSubmit.do', {
    method: 'POST',
    headers: stepHeaders,
    body: new URLSearchParams(loginData).toString(),
  });
  const loginResult = await loginResp.json() as Record<string, unknown>;
  if (loginResult.result !== 0 && loginResult.result !== '0') {
    throw new Error(`天翼云盘登录失败: ${loginResult.msg || loginResult.result}`);
  }

  collectCookie(cookies, loginResp.headers);

  const toUrl = String(loginResult.toUrl || 'https://cloud.189.cn/web/main');
  const { cookies: mainCookies } = await followRedirects(toUrl, cookies, 'https://open.e.189.cn/');
  for (const c of mainCookies) {
    if (!cookies.includes(c)) cookies.push(c);
  }

  return cookies.join('; ');
}

// --- Tianyi Session Management ---

export async function tianyiEnsureSession(mount: StorageMount): Promise<string> {
  if (mount.sessionCookie) return mount.sessionCookie;
  if (!mount.username || !mount.password) {
    throw new Error('天翼云盘未配置用户名和密码，也未提供已登录的 Cookie');
  }

  const cacheKey = await tianyiCredentialKey(mount);
  const cachedCookie = readCachedTianyiSession(cacheKey);
  if (cachedCookie) {
    mount.sessionCookie = cachedCookie;
    return cachedCookie;
  }

  const pendingLogin = pendingTianyiLogins.get(cacheKey);
  if (pendingLogin) {
    const cookie = await pendingLogin;
    mount.sessionCookie = cookie;
    return cookie;
  }

  const generation = tianyiSessionCacheGeneration;
  const loginPromise = loginAndValidateTianyiSession(mount, cacheKey, generation);
  pendingTianyiLogins.set(cacheKey, loginPromise);
  try {
    return await loginPromise;
  } finally {
    if (pendingTianyiLogins.get(cacheKey) === loginPromise) {
      pendingTianyiLogins.delete(cacheKey);
    }
  }
}

async function loginAndValidateTianyiSession(
  mount: StorageMount,
  cacheKey: string,
  generation: number,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cookie = await tianyiLogin(mount.username, mount.password);
    if (!cookie) throw new Error('天翼云盘登录未返回有效 Cookie');
    mount.sessionCookie = cookie;

    try {
      await tianyiApiCall(mount, '/api/open/file/listFiles.action', {
        folderId: mount.rootDir || '-11',
        pageNum: '1',
        pageSize: '1',
        mediaType: '0',
        iconOption: '5',
        orderBy: 'lastOpTime',
        descending: 'true',
      }, 'GET', undefined, 0);
      cacheTianyiSession(cacheKey, cookie, generation);
      return cookie;
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('InvalidSessionKey') || msg.includes('check ip error')) {
        mount.sessionCookie = '';
        continue;
      }
      if (msg.includes('FileNotFound') || msg.includes('file not found')) {
        cacheTianyiSession(cacheKey, cookie, generation);
        return cookie;
      }
      cacheTianyiSession(cacheKey, cookie, generation);
      return cookie;
    }
  }

  throw new Error('天翼云盘登录验证失败：出口IP不稳定，连续3次尝试均因IP变化导致会话失效，请稍后重试');
}

// --- Tianyi API Client ---

export function safeParseJSON(text: string): Record<string, unknown> {
  const fixed = text.replace(/([:\[,]\s*)(-?\d{16,})(\s*[,}\]])/g, '$1"$2"$3');
  return JSON.parse(fixed);
}

async function tianyiApiCall(mount: StorageMount, endpoint: string, params: Record<string, string>, method = 'GET', body?: BodyInit, retriesLeft = 3): Promise<Record<string, unknown>> {
  const cookie = await tianyiEnsureSession(mount);
  const url = new URL(endpoint, TIANYI_API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {
    'Cookie': cookie,
    'Accept': 'application/json;charset=UTF-8',
    'Referer': 'https://cloud.189.cn/',
    'User-Agent': TIANYI_UA,
  };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  url.searchParams.set('noCache', String(Math.random()));

  const response = await fetchWithTimeout(
    url.toString(),
    { method, headers, body },
    15_000,
    '天翼云盘 API 请求超时，请检查网络或改用已登录的 Cookie',
  );

  let json: Record<string, unknown> = {};
  let rawText = '';
  try { rawText = await response.text(); json = safeParseJSON(rawText); } catch (ex) {
    if (!response.ok) throw new Error(`天翼云盘 API 请求失败 (${response.status})${rawText ? ': ' + rawText.slice(0, 200) : ''}`);
    return json;
  }

  const errorCode = json.errorCode;
  if (errorCode === 'InvalidSessionKey') {
    if (hasExplicitSessionCookie(mount)) {
      throw new Error('天翼云盘 Cookie 已失效，请在插件配置中更新已登录的 Cookie');
    }
    await invalidateGeneratedTianyiSession(mount);
    mount.sessionCookie = '';
    if (retriesLeft > 0) {
      return tianyiApiCall(mount, endpoint, params, method, body, retriesLeft - 1);
    }
    throw new Error('InvalidSessionKey');
  }

  const resCode = json.res_code;
  if (resCode !== undefined && resCode !== 0 && resCode !== '0') {
    throw new Error(`天翼云盘 API 错误: ${json.res_message || resCode}`);
  }
  if (json.code !== undefined && json.code !== 0 && json.code !== '0') {
    throw new Error(`天翼云盘 API 错误: ${json.message || json.code}`);
  }

  if (!response.ok) {
    throw new Error(`天翼云盘 API 请求失败 (${response.status})${rawText ? ': ' + rawText.slice(0, 200) : ''}`);
  }

  return json;
}

// --- Tianyi File Operations ---

export async function tianyiListFiles(mount: StorageMount, folderId: string, limit = 0, offset = 0): Promise<S3ListResult> {
  const objects: S3Object[] = [];
  const prefixes: string[] = [];
  let pageNum = 1;
  let totalCount = 0;
  let collected = 0;
  const needed = limit > 0 ? offset + limit : Infinity;

  if (!mount._folderCache) mount._folderCache = new Map();

  do {
    const result = await tianyiApiCall(mount, '/api/open/file/listFiles.action', {
      folderId,
      pageNum: String(pageNum),
      ...TIANYI_LIST_PARAMS,
    });

    const fileListAO = (result.fileListAO || {}) as Record<string, unknown>;
    const folders = (fileListAO.folderList || []) as Array<Record<string, unknown>>;
    const files = (fileListAO.fileList || []) as Array<Record<string, unknown>>;
    totalCount = Number(fileListAO.count || 0);

    for (const folder of folders) {
      const folderName = String(folder.name || '');
      const childId = String(folder.id || '');
      mount._folderCache.set(`${folderId}::${folderName}`, childId);
      collected++;
      if (limit <= 0 || (collected > offset && collected <= offset + limit)) {
        prefixes.push(folderName + '/');
      }
    }
    for (const file of files) {
      collected++;
      if (limit <= 0 || (collected > offset && collected <= offset + limit)) {
        objects.push({
          key: String(file.name || ''),
          size: Number(file.size || 0),
          etag: String(file.id || ''),
          lastModified: String(file.lastOpTime || ''),
        });
      }
    }
    pageNum++;

    if (limit > 0 && collected >= needed) break;
  } while ((pageNum - 1) * 60 < totalCount);

  return { objects, prefixes, total: totalCount };
}

export async function tianyiResolvePath(mount: StorageMount, targetPath: string): Promise<{ id: string; isFolder: boolean; name: string } | null> {
  if (!targetPath || targetPath === '/' || targetPath === '') {
    return { id: mount.rootDir || '-11', isFolder: true, name: '' };
  }

  const segments = targetPath.replace(/^\//, '').replace(/\/$/, '').split('/').filter(Boolean);
  if (segments.length === 0) {
    return { id: mount.rootDir || '-11', isFolder: true, name: '' };
  }

  if (!mount._folderCache) mount._folderCache = new Map();

  let currentId = mount.rootDir || '-11';
  for (let i = 0; i < segments.length; i++) {
    const target = segments[i];
    const isLast = i === segments.length - 1;

    if (currentId === (mount.rootDir || '-11') && TIANYI_ROOT_FOLDERS[target]) {
      const specialId = TIANYI_ROOT_FOLDERS[target];
      return { id: specialId, isFolder: true, name: target };
    }

    const cacheKey = `${currentId}::${target}`;
    const cached = mount._folderCache.get(cacheKey);
    if (cached !== undefined) {
      currentId = cached;
      if (isLast) return { id: cached, isFolder: true, name: target };
      continue;
    }

    let pageNum = 1;
    let found = false;
    while (true) {
      const result = await tianyiApiCall(mount, '/api/open/file/listFiles.action', {
        folderId: currentId,
        pageNum: String(pageNum),
        ...TIANYI_LIST_PARAMS,
      });
      const fileListAO = (result.fileListAO || {}) as Record<string, unknown>;
      const folders = (fileListAO.folderList || []) as Array<Record<string, unknown>>;
      const files = (fileListAO.fileList || []) as Array<Record<string, unknown>>;

      for (const f of folders) {
        mount._folderCache.set(`${currentId}::${String(f.name || '')}`, String(f.id || ''));
      }

      if (isLast) {
        for (const file of files) {
          if (String(file.name || '') === target) {
            return { id: String(file.id || ''), isFolder: false, name: target };
          }
        }
      }

      for (const folder of folders) {
        if (String(folder.name || '') === target) {
          if (isLast) return { id: String(folder.id || ''), isFolder: true, name: target };
          currentId = String(folder.id || '');
          found = true;
          break;
        }
      }

      if (found) break;
      const totalCount = Number(fileListAO.count || 0);
      if (pageNum * 60 >= totalCount) break;
      pageNum++;
    }

    if (!found) return null;
  }

  return null;
}

async function tianyiPostAction(mount: StorageMount, action: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params);
  return tianyiApiCall(mount, `/api/open/file/${action}.action`, {}, 'POST', body.toString());
}

export async function tianyiGetDownloadUrl(mount: StorageMount, fileId: string): Promise<string> {
  const result = await tianyiApiCall(mount, '/api/open/file/getFileDownloadUrl.action', { fileId });
  return String(result.downloadUrl || result.fileDownloadUrl || '');
}

export async function tianyiCreateFolder(mount: StorageMount, parentId: string, folderName: string): Promise<string> {
  const result = await tianyiPostAction(mount, 'createFolder', { parentFolderId: parentId, folderName });
  return String(result.folderId || result.id || '');
}

export async function tianyiDeleteFile(mount: StorageMount, fileId: string): Promise<void> {
  await tianyiPostAction(mount, 'deleteFile', { fileId });
}

export async function tianyiDeleteFolder(mount: StorageMount, folderId: string): Promise<void> {
  await tianyiPostAction(mount, 'deleteFolder', { folderId });
}

export async function tianyiRenameFile(mount: StorageMount, fileId: string, newName: string): Promise<void> {
  await tianyiPostAction(mount, 'renameFile', { fileId, destFileName: newName });
}

export async function tianyiRenameFolder(mount: StorageMount, folderId: string, newName: string): Promise<void> {
  await tianyiPostAction(mount, 'renameFolder', { folderId, destFolderName: newName });
}

export async function tianyiMoveFile(mount: StorageMount, fileId: string, destFolderId: string): Promise<void> {
  await tianyiPostAction(mount, 'moveFile', { fileId, destFolderId });
}

export async function tianyiCopyFile(mount: StorageMount, fileId: string, destFolderId: string): Promise<void> {
  await tianyiPostAction(mount, 'copyFile', { fileId, destFolderId });
}

// --- Crypto Helpers ---

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

export function canonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodePathSegment(key)}=${encodePathSegment(value)}`)
    .join('&');
}

// --- S3 Signing ---

export function shortDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

export function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
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

  return { url, host: endpoint.host, canonicalUri, canonicalQuery: queryString };
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
    method, urlParts.canonicalUri, urlParts.canonicalQuery,
    canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD',
  ].join('\n');

  const credentialScope = `${date}/${mount.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', timestamp, credentialScope,
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

  return { url: urlParts.url, headers: new Headers(normalizedHeaders) };
}

export async function s3Fetch(
  mount: StorageMount, method: string, key = '',
  query: Record<string, string> = {}, headers: Record<string, string> = {},
  body?: BodyInit | null,
): Promise<Response> {
  const signed = await signS3Headers(mount, method, key, query, headers);
  return fetchWithTimeout(signed.url, { method, headers: signed.headers, body });
}

// --- R2 Helpers ---

function isR2BucketBinding(value: unknown): value is R2Bucket {
  return !!value
    && typeof value === 'object'
    && typeof (value as R2Bucket).get === 'function'
    && typeof (value as R2Bucket).put === 'function'
    && typeof (value as R2Bucket).delete === 'function'
    && typeof (value as R2Bucket).head === 'function'
    && typeof (value as R2Bucket).list === 'function';
}

export function getR2Bucket(mount: StorageMount, workerEnv?: Record<string, unknown>): R2Bucket {
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
    const result = await bucket.list({ prefix, delimiter: '/', limit: 1000, cursor });
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

// --- Storage Abstraction ---

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export async function listObjects(mount: StorageMount, prefix: string, workerEnv?: Record<string, unknown>, limit = 0, offset = 0): Promise<S3ListResult> {
  if (mount.provider === 'r2') {
    return listR2Objects(mount, prefix, workerEnv);
  }
  if (mount.provider === 'tianyi') {
    const cleanPrefix = prefix.replace(/\/+$/, '');
    const resolved = await tianyiResolvePath(mount, cleanPrefix);
    if (!resolved || !resolved.isFolder) {
      return { objects: [], prefixes: [] };
    }
    return tianyiListFiles(mount, resolved.id, limit, offset);
  }

  const response = await s3Fetch(mount, 'GET', '', {
    'delimiter': '/', 'list-type': '2', 'max-keys': '1000', 'prefix': prefix,
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

export async function objectMeta(mount: StorageMount, key: string, workerEnv?: Record<string, unknown>): Promise<S3Object | null> {
  if (mount.provider === 'r2') {
    const object = await getR2Bucket(mount, workerEnv).head(key);
    if (!object) return null;
    return {
      key: object.key, size: object.size,
      etag: object.httpEtag || object.etag,
      lastModified: object.uploaded instanceof Date ? object.uploaded.toISOString() : String(object.uploaded || ''),
    };
  }
  if (mount.provider === 'tianyi') {
    const cleanKey = key.replace(/\/+$/, '');
    const resolved = await tianyiResolvePath(mount, cleanKey);
    if (!resolved || resolved.isFolder) return null;
    let size = 0;
    let lastModified = '';
    try {
      const lastSlash = cleanKey.lastIndexOf('/');
      const parentPath = lastSlash >= 0 ? cleanKey.slice(0, lastSlash) : '';
      const parent = parentPath ? await tianyiResolvePath(mount, parentPath) : { id: mount.rootDir || '-11' };
      if (parent) {
        const listing = await tianyiListFiles(mount, parent.id, 300);
        const found = listing.objects.find(o => o.key === resolved.name);
        if (found) { size = found.size; lastModified = found.lastModified; }
      }
    } catch { /* fall back to zero */ }
    return { key: cleanKey, size, etag: resolved.id, lastModified };
  }

  const response = await s3Fetch(mount, 'HEAD', key);
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) throw new Error(`Read storage metadata failed (${response.status})`);
  return {
    key, size: Number(response.headers.get('content-length') || 0),
    etag: response.headers.get('etag') || '',
    lastModified: response.headers.get('last-modified') || '',
  };
}

export async function collectionExists(mount: StorageMount, prefix: string, workerEnv?: Record<string, unknown>): Promise<boolean> {
  const normalizedPrefix = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
  const listing = await listObjects(mount, normalizedPrefix, workerEnv, 1, 0);
  return listing.prefixes.length > 0 || listing.objects.length > 0;
}

// --- Storage Operations Interface ---

export interface StorageOps {
  read(key: string, method: 'GET' | 'HEAD', workerEnv?: Record<string, unknown>): Promise<Response>;
  write(key: string, body: BodyInit | null, contentType?: string, workerEnv?: Record<string, unknown>): Promise<Response>;
  mkdir(key: string, workerEnv?: Record<string, unknown>): Promise<Response>;
  delete(key: string, workerEnv?: Record<string, unknown>): Promise<Response>;
  copy(srcKey: string, destKey: string, workerEnv?: Record<string, unknown>): Promise<Response>;
  move(srcKey: string, destKey: string, workerEnv?: Record<string, unknown>): Promise<Response>;
  list(prefix: string, workerEnv?: Record<string, unknown>, limit?: number, offset?: number): Promise<S3ListResult>;
  meta(key: string, workerEnv?: Record<string, unknown>): Promise<S3Object | null>;
  collectionExists(prefix: string, workerEnv?: Record<string, unknown>): Promise<boolean>;
  isEmpty(dirKey: string, workerEnv?: Record<string, unknown>): Promise<boolean>;
}

// --- Provider Implementations ---

function pk(mount: StorageMount, key: string): string {
  return withMountPrefix(mount, key);
}

function pkd(mount: StorageMount, key: string): string {
  const full = withMountPrefix(mount, key);
  return full && !full.endsWith('/') ? `${full}/` : full;
}

function createR2Ops(mount: StorageMount): StorageOps {
  return {
    async read(k, method, workerEnv) {
      const bucket = getR2Bucket(mount, workerEnv);
      const object = await bucket.get(pk(mount, k));
      if (!object) return new Response('Not Found', { status: 404 });
      const headers = new Headers();
      if (object.size != null) headers.set('Content-Length', String(object.size));
      if (object.httpEtag || object.etag) headers.set('ETag', object.httpEtag || object.etag || '');
      if (object.uploaded) headers.set('Last-Modified', object.uploaded.toUTCString());
      if (object.httpMetadata?.contentType) headers.set('Content-Type', object.httpMetadata.contentType);
      return new Response(method === 'HEAD' ? null : object.body, { status: 200, headers });
    },

    async write(k, body, contentType, workerEnv) {
      const bucket = getR2Bucket(mount, workerEnv);
      await bucket.put(pk(mount, k), (body ?? '') as string | ReadableStream | ArrayBuffer | Blob, {
        httpMetadata: contentType ? { contentType } : undefined,
      });
      return new Response(null, { status: 201 });
    },

    async mkdir(k, workerEnv) {
      const bucket = getR2Bucket(mount, workerEnv);
      const dirKey = k.endsWith('/') ? pk(mount, k) : `${pk(mount, k)}/`;
      await bucket.put(dirKey, '', {
        httpMetadata: { contentType: 'application/x-directory' },
      });
      return new Response(null, { status: 201 });
    },

    async delete(k, workerEnv) {
      const bucket = getR2Bucket(mount, workerEnv);
      await bucket.delete(pk(mount, k));
      return new Response(null, { status: 204 });
    },

    async copy(srcK, destK, workerEnv) {
      const bucket = getR2Bucket(mount, workerEnv);
      const sourceObject = await bucket.get(pk(mount, srcK));
      if (!sourceObject) return new Response('Not Found', { status: 404 });
      await bucket.put(pk(mount, destK), sourceObject.body, {
        httpMetadata: sourceObject.httpMetadata,
      });
      return new Response(null, { status: 201 });
    },

    async move(srcK, destK, workerEnv) {
      const bucket = getR2Bucket(mount, workerEnv);
      const sourceObject = await bucket.get(pk(mount, srcK));
      if (!sourceObject) return new Response('Not Found', { status: 404 });
      await bucket.put(pk(mount, destK), sourceObject.body, {
        httpMetadata: sourceObject.httpMetadata,
      });
      await bucket.delete(pk(mount, srcK));
      return new Response(null, { status: 201 });
    },

    list(prefix, workerEnv, limit, offset) {
      return listObjects(mount, pkd(mount, prefix), workerEnv, limit, offset);
    },

    meta(k, workerEnv) {
      return objectMeta(mount, pk(mount, k), workerEnv);
    },

    collectionExists(prefix, workerEnv) {
      return collectionExists(mount, pkd(mount, prefix), workerEnv);
    },

    async isEmpty(dirK, workerEnv) {
      const prefix = pkd(mount, dirK);
      const bucket = getR2Bucket(mount, workerEnv);
      const result = await bucket.list({ prefix, delimiter: '/', limit: 2 });
      if ((result.delimitedPrefixes || []).length > 0) return false;
      const nonMarkers = (result.objects || []).filter(o => o.key !== prefix);
      if (nonMarkers.length > 0) return false;
      if (result.truncated) return false;
      return true;
    },
  };
}

function createS3Ops(mount: StorageMount): StorageOps {
  return {
    async read(k, method, workerEnv) {
      const response = await s3Fetch(mount, method, pk(mount, k));
      if (response.status === 404 || response.status === 403) {
        return new Response('Not Found', { status: 404 });
      }
      return response;
    },

    async write(k, body, contentType, workerEnv) {
      const headers: Record<string, string> = {};
      if (contentType) headers['content-type'] = contentType;
      const response = await s3Fetch(mount, 'PUT', pk(mount, k), {}, headers, body);
      if (!response.ok) return new Response(`Storage write failed (${response.status})`, { status: 502 });
      return new Response(null, { status: 201 });
    },

    async mkdir(k, workerEnv) {
      const dirKey = k.endsWith('/') ? pk(mount, k) : `${pk(mount, k)}/`;
      const response = await s3Fetch(mount, 'PUT', dirKey, {}, { 'content-type': 'application/x-directory' }, '');
      if (!response.ok) return new Response(`Storage write failed (${response.status})`, { status: 502 });
      return new Response(null, { status: 201 });
    },

    async delete(k, workerEnv) {
      const response = await s3Fetch(mount, 'DELETE', pk(mount, k));
      if (!response.ok && response.status !== 404) return new Response(`Storage delete failed (${response.status})`, { status: 502 });
      return new Response(null, { status: 204 });
    },

    async copy(srcK, destK, workerEnv) {
      const copySource = `/${encodePathSegment(mount.bucket)}/${encodeKeyPath(pk(mount, srcK))}`;
      const response = await s3Fetch(mount, 'PUT', pk(mount, destK), {}, { 'x-amz-copy-source': copySource });
      if (!response.ok) return new Response(`Storage copy failed (${response.status})`, { status: 502 });
      return new Response(null, { status: 201 });
    },

    async move(srcK, destK, workerEnv) {
      const copySource = `/${encodePathSegment(mount.bucket)}/${encodeKeyPath(pk(mount, srcK))}`;
      const copyResponse = await s3Fetch(mount, 'PUT', pk(mount, destK), {}, { 'x-amz-copy-source': copySource });
      if (!copyResponse.ok) return new Response(`Storage copy failed (${copyResponse.status})`, { status: 502 });
      const deleteResponse = await s3Fetch(mount, 'DELETE', pk(mount, srcK));
      if (!deleteResponse.ok && deleteResponse.status !== 404) {
        return new Response(`Storage move cleanup failed (${deleteResponse.status})`, { status: 502 });
      }
      return new Response(null, { status: 201 });
    },

    list(prefix, workerEnv, limit, offset) {
      return listObjects(mount, pkd(mount, prefix), workerEnv, limit, offset);
    },

    meta(k, workerEnv) {
      return objectMeta(mount, pk(mount, k), workerEnv);
    },

    collectionExists(prefix, workerEnv) {
      return collectionExists(mount, pkd(mount, prefix), workerEnv);
    },

    async isEmpty(dirK, workerEnv) {
      const prefix = pkd(mount, dirK);
      const response = await s3Fetch(mount, 'GET', '', {
        'delimiter': '/', 'list-type': '2', 'max-keys': '2', 'prefix': prefix,
      });
      if (!response.ok) return false;
      const xml = await response.text();
      if (xml.match(/<CommonPrefixes>/)) return false;
      const contentMatches = Array.from(xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g));
      if (contentMatches.length === 0) return true;
      const hasNonMarker = contentMatches.some(match => {
        const block = match[1] || '';
        const key = decodeXml(block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] || '');
        return key !== prefix;
      });
      if (hasNonMarker) return false;
      if (xml.includes('<IsTruncated>true</IsTruncated>')) return false;
      return true;
    },
  };
}

async function tianyiPollAndRename(
  mount: StorageMount, destParentPath: string, sourceName: string, destName: string,
): Promise<void> {
  if (!destName || destName === sourceName) return;
  let resolved: { id: string; isFolder: boolean; name: string } | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 200));
    resolved = await tianyiResolvePath(mount, (destParentPath ? `${destParentPath}/` : '') + sourceName);
    if (resolved) break;
  }
  if (resolved && !resolved.isFolder) await tianyiRenameFile(mount, resolved.id, destName);
}

function createTianyiOps(mount: StorageMount): StorageOps {
  return {
    async read(k, method, workerEnv) {
      const fullKey = pk(mount, k);
      const cleanKey = fullKey.replace(/\/+$/, '');
      const resolved = await tianyiResolvePath(mount, cleanKey);
      if (!resolved || resolved.isFolder) return new Response('Not Found', { status: 404 });
      if (method === 'HEAD') return new Response(null, { status: 200 });
      const downloadUrl = await tianyiGetDownloadUrl(mount, resolved.id);
      if (!downloadUrl) return new Response('Not Found', { status: 404 });
      const downloadResp = await fetchWithTimeout(downloadUrl);
      if (!downloadResp.ok) return new Response(`Download failed (${downloadResp.status})`, { status: 502 });
      return downloadResp;
    },

    async write(k, body, contentType, workerEnv) {
      const fullKey = pk(mount, k);
      const lastSlash = fullKey.lastIndexOf('/');
      const parentPath = lastSlash >= 0 ? fullKey.slice(0, lastSlash) : '';
      const fileName = lastSlash >= 0 ? fullKey.slice(lastSlash + 1) : fullKey;
      const parent = await tianyiResolvePath(mount, parentPath || '');
      if (!parent || !parent.isFolder) return new Response('Parent folder not found', { status: 404 });
      const cookie = await tianyiEnsureSession(mount);
      const form = new FormData();
      form.append('folderId', parent.id);
      if (body) {
        const buf = await new Response(body).arrayBuffer();
        form.append('file', new Blob([buf]), fileName);
      }
      const uploadUrl = `${TIANYI_API_BASE}/api/open/file/uploadFile.action`;
      const uploadResp = await fetchWithTimeout(uploadUrl, { method: 'POST', headers: { 'Cookie': cookie, 'Referer': 'https://cloud.189.cn/', 'User-Agent': TIANYI_UA }, body: form });
      if (!uploadResp.ok) return new Response(`Upload failed (${uploadResp.status})`, { status: 502 });
      return new Response(null, { status: 201 });
    },

    async mkdir(k, workerEnv) {
      const dirKey = (k.endsWith('/') ? pk(mount, k) : `${pk(mount, k)}/`).replace(/\/+$/, '');
      const segments = dirKey.split('/').filter(Boolean);
      const folderName = segments.pop() || dirKey;
      const parentPath = segments.join('/');
      const parent = await tianyiResolvePath(mount, parentPath || '');
      if (!parent || !parent.isFolder) return new Response('Parent folder not found', { status: 409 });
      await tianyiCreateFolder(mount, parent.id, folderName);
      return new Response(null, { status: 201 });
    },

    async delete(k, workerEnv) {
      const cleanKey = pk(mount, k).replace(/\/+$/, '');
      const resolved = await tianyiResolvePath(mount, cleanKey);
      if (!resolved) return new Response('Not Found', { status: 404 });
      if (resolved.isFolder) {
        await tianyiDeleteFolder(mount, resolved.id);
      } else {
        await tianyiDeleteFile(mount, resolved.id);
      }
      return new Response(null, { status: 204 });
    },

    async copy(srcK, destK, workerEnv) {
      const cleanSource = pk(mount, srcK).replace(/\/+$/, '');
      const cleanDest = pk(mount, destK).replace(/\/+$/, '');
      const source = await tianyiResolvePath(mount, cleanSource);
      if (!source) return new Response('Not Found', { status: 404 });
      if (source.isFolder) return new Response('Collection copy is not supported', { status: 409 });

      const destSlash = cleanDest.lastIndexOf('/');
      const destParentPath = destSlash >= 0 ? cleanDest.slice(0, destSlash) : '';
      const destName = destSlash >= 0 ? cleanDest.slice(destSlash + 1) : cleanDest;
      const destParent = await tianyiResolvePath(mount, destParentPath || '');
      if (!destParent || !destParent.isFolder) return new Response('Destination folder not found', { status: 409 });

      await tianyiCopyFile(mount, source.id, destParent.id);
      await tianyiPollAndRename(mount, destParentPath, source.name, destName);
      return new Response(null, { status: 201 });
    },

    async move(srcK, destK, workerEnv) {
      const cleanSource = pk(mount, srcK).replace(/\/+$/, '');
      const cleanDest = pk(mount, destK).replace(/\/+$/, '');
      const source = await tianyiResolvePath(mount, cleanSource);
      if (!source) return new Response('Not Found', { status: 404 });
      if (source.isFolder) return new Response('Collection move is not supported', { status: 409 });

      const destSlash = cleanDest.lastIndexOf('/');
      const destParentPath = destSlash >= 0 ? cleanDest.slice(0, destSlash) : '';
      const destName = destSlash >= 0 ? cleanDest.slice(destSlash + 1) : cleanDest;
      const destParent = await tianyiResolvePath(mount, destParentPath || '');
      if (!destParent || !destParent.isFolder) return new Response('Destination folder not found', { status: 409 });

      const srcSlash = cleanSource.lastIndexOf('/');
      const srcParentPath = srcSlash >= 0 ? cleanSource.slice(0, srcSlash) : '';
      const srcParent = srcParentPath ? await tianyiResolvePath(mount, srcParentPath) : { id: mount.rootDir || '-11', isFolder: true, name: '' };
      const sameParent = srcParent && destParent.id === srcParent.id;

      if (sameParent) {
        await tianyiRenameFile(mount, source.id, destName);
      } else {
        await tianyiMoveFile(mount, source.id, destParent.id);
        await tianyiPollAndRename(mount, destParentPath, source.name, destName);
      }
      return new Response(null, { status: 201 });
    },

    list(prefix, workerEnv, limit, offset) {
      return listObjects(mount, pkd(mount, prefix), workerEnv, limit, offset);
    },

    meta(k, workerEnv) {
      return objectMeta(mount, pk(mount, k), workerEnv);
    },

    collectionExists(prefix, workerEnv) {
      return collectionExists(mount, pkd(mount, prefix), workerEnv);
    },

    async isEmpty(dirK, workerEnv) {
      const listing = await listObjects(mount, pkd(mount, dirK), workerEnv, 2, 0);
      return listing.prefixes.length === 0 && listing.objects.length === 0;
    },
  };
}

export function getStorageOps(mount: StorageMount): StorageOps {
  switch (mount.provider) {
    case 'r2': return createR2Ops(mount);
    case 'tianyi': return createTianyiOps(mount);
    default: return createS3Ops(mount);
  }
}
