import type { WebDavConfig, StorageMount, S3Object } from './types';
import {
  resolveWebDavTarget, matchWebDavRoute,
  stripMountPrefix, isCollectionPath, href,
  getWebDavClientIp, isWebDavClientBanned, recordWebDavAuthFailure,
  clearWebDavAuthFailures, authenticate,
} from './config';
import { getStorageOps } from './adapters';
import { escapeXml } from '@/lib/escape';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';

// --- Constants ---

const ALLOWED_METHODS = 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE';
const XML_HEADERS = { 'Content-Type': 'application/xml; charset=utf-8' };

// --- XML / HTML Helpers ---

function responseXml(
  itemHref: string, displayName: string, collection: boolean,
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
  return new Response(
    `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`,
    { status: 207, headers: XML_HEADERS },
  );
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
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
    '<body><main>',
    `<h1>${escapeXml(title)}</h1>`,
    items.length > 0 ? `<ul>${items.join('')}</ul>` : '<p>This WebDAV collection is empty.</p>',
    '</main></body>',
    '</html>',
  ].join('');
}

function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: ALLOWED_METHODS, DAV: '1, 2', 'MS-Author-Via': 'DAV', 'Cache-Control': 'no-store',
    },
  });
}

// --- WebDAV Protocol Handlers ---

async function propfindRoot(config: WebDavConfig, depth: string): Promise<Response> {
  const responses = [responseXml(href(config.routePath, [], true), 'WebDAV', true)];
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
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  const items = config.mounts.map(mount => {
    const label = mount.mount || 'Root storage';
    return `<li><a href="${escapeXml(href(config.routePath, [mount.mount], true))}">${escapeXml(label)}/</a></li>`;
  });
  return htmlResponse(htmlPage('WebDAV', items));
}

async function browserMountListing(
  config: WebDavConfig, mount: StorageMount, key: string,
  method: string, workerEnv?: Record<string, unknown>,
): Promise<Response> {
  if (method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const cleanKey = key.replace(/^\/+|\/+$/g, '');
  const ops = getStorageOps(mount);
  const listing = await ops.list(cleanKey, workerEnv);
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
    if (object.key.endsWith('/')) {
      const relative = stripMountPrefix(mount, object.key);
      const collectionRelative = relative.replace(/\/+$/, '');
      if (!collectionRelative || collectionRelative === cleanKey || emittedCollections.has(collectionRelative)) continue;
      emittedCollections.add(collectionRelative);
      const display = collectionRelative.split('/').pop() || collectionRelative;
      items.push(`<li><a href="${escapeXml(href(config.routePath, [
        ...(mount.mount ? [mount.mount] : []),
        ...collectionRelative.split('/').filter(Boolean),
      ], true))}">${escapeXml(display)}/</a></li>`);
      continue;
    }
    const relative = stripMountPrefix(mount, object.key);
    const normalizedCleanKey = cleanKey ? `${cleanKey}/` : '';
    if (relative.includes('/') && !relative.startsWith(normalizedCleanKey)) continue;
    const display = relative.split('/').pop() || relative;
    items.push(`<li><a href="${escapeXml(href(config.routePath, [
      ...(mount.mount ? [mount.mount] : []),
      ...relative.split('/').filter(Boolean),
    ], false))}">${escapeXml(display)}</a></li>`);
  }

  return htmlResponse(htmlPage(basePartsLen(mount, cleanKey), items));
}

function basePartsLen(mount: StorageMount, cleanKey: string): string {
  const parts = [...(mount.mount ? [mount.mount] : []), ...cleanKey.split('/').filter(Boolean)];
  return parts.length > 0 ? `WebDAV / ${parts.join('/')}` : 'WebDAV';
}

async function propfindMount(
  config: WebDavConfig, mount: StorageMount, key: string,
  depth: string, workerEnv?: Record<string, unknown>,
): Promise<Response> {
  const cleanKey = key.replace(/^\/+/, '');
  const mountParts = [
    ...(mount.mount ? [mount.mount] : []),
    ...cleanKey.split('/').filter(Boolean),
  ];
  const responses: string[] = [];
  const ops = getStorageOps(mount);

  if (cleanKey === '' || isCollectionPath(key)) {
    const listing = await ops.list(cleanKey, workerEnv);
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
        if (object.key.endsWith('/')) {
          const relative = stripMountPrefix(mount, object.key);
          const collectionRelative = relative.replace(/\/+$/, '');
          if (!collectionRelative || collectionRelative === cleanKey || emittedCollections.has(collectionRelative)) continue;
          emittedCollections.add(collectionRelative);
          const display = collectionRelative.split('/').pop() || collectionRelative;
          responses.push(responseXml(href(config.routePath, [
            ...(mount.mount ? [mount.mount] : []),
            ...collectionRelative.split('/').filter(Boolean),
          ], true), display, true));
          continue;
        }
        const relative = stripMountPrefix(mount, object.key);
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

  const meta = await ops.meta(cleanKey, workerEnv);
  if (meta) {
    return multistatus([
      responseXml(href(config.routePath, mountParts, false), mountParts.at(-1) || cleanKey, false, meta),
    ]);
  }

  const existsAsCollection = await ops.collectionExists(cleanKey, workerEnv);
  if (!existsAsCollection) return new Response('Not Found', { status: 404 });
  if (depth !== '0') {
    return propfindMount(config, mount, `${cleanKey}/`, depth, workerEnv);
  }
  return multistatus([
    responseXml(href(config.routePath, mountParts, true), mountParts.at(-1) || cleanKey, true),
  ]);
}

async function handleRead(
  method: string, mount: StorageMount, key: string,
  workerEnv?: Record<string, unknown>,
): Promise<Response> {
  return getStorageOps(mount).read(key, method as 'GET' | 'HEAD', workerEnv);
}

async function handlePut(
  request: Request, mount: StorageMount, key: string,
  workerEnv?: Record<string, unknown>,
): Promise<Response> {
  if (!key || key.endsWith('/')) return new Response('Invalid target', { status: 409 });

  // WebDAV is not an unbounded write channel: uploads share the admin upload
  // ceiling, so a single PUT cannot fill the bucket (or buffer the isolate)
  // without limit. Content-Length is checked up front, and chunked uploads are
  // aborted by the counting stream below.
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PUT_BYTES) {
    return new Response('Payload Too Large', { status: 413 });
  }

  const contentType = request.headers.get('content-type') || undefined;
  const body = request.body ? limitRequestBody(request.body, MAX_PUT_BYTES) : request.body;
  try {
    return await getStorageOps(mount).write(key, body, contentType, workerEnv);
  } catch (error) {
    if (error instanceof Error && error.message === PUT_TOO_LARGE) {
      return new Response('Payload Too Large', { status: 413 });
    }
    throw error;
  }
}

/** Upload ceiling for a single WebDAV PUT — same value as the admin uploader. */
const MAX_PUT_BYTES = REQUEST_BODY_LIMITS.uploadFile;
const PUT_TOO_LARGE = 'webdav-payload-too-large';

/** Abort a streamed upload as soon as it passes the ceiling. */
function limitRequestBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(new Error(PUT_TOO_LARGE));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}

async function handleMkcol(mount: StorageMount, key: string, workerEnv?: Record<string, unknown>): Promise<Response> {
  if (!key) return new Response('Method Not Allowed', { status: 405 });
  return getStorageOps(mount).mkdir(key, workerEnv);
}

async function handleDelete(mount: StorageMount, key: string, workerEnv?: Record<string, unknown>): Promise<Response> {
  if (!key) return new Response('Cannot delete mount root', { status: 409 });
  const ops = getStorageOps(mount);
  if (key.endsWith('/')) {
    if (!(await ops.isEmpty(key, workerEnv))) {
      return new Response('Directory is not empty', { status: 409 });
    }
  }
  return ops.delete(key, workerEnv);
}

function resolveDestination(config: WebDavConfig, destinationHeader: string | null): { mountName: string; key: string } | null {
  if (!destinationHeader) return null;
  let pathname = destinationHeader;
  try { pathname = new URL(destinationHeader).pathname; } catch { /* relative header */ }
  const relative = matchWebDavRoute(config.routePath, pathname);
  if (relative === null) return null;
  const target = resolveWebDavTarget(config, relative);
  if (!target) return null;
  return { mountName: target.mount.mount, key: target.key };
}

async function handleCopyMove(
  request: Request, config: WebDavConfig, sourceMount: StorageMount,
  sourceKey: string, move: boolean, workerEnv?: Record<string, unknown>,
): Promise<Response> {
  if (!sourceKey || sourceKey.endsWith('/')) return new Response('Collection copy is not supported', { status: 409 });
  const destination = resolveDestination(config, request.headers.get('destination'));
  if (!destination) return new Response('Invalid Destination', { status: 400 });
  if (destination.mountName !== sourceMount.mount || !destination.key || destination.key.endsWith('/')) {
    return new Response('Cross-mount or collection copy is not supported', { status: 409 });
  }

  const overwrite = (request.headers.get('overwrite') || 'T').toUpperCase() !== 'F';
  if (!overwrite) {
    const existing = await getStorageOps(sourceMount).meta(destination.key, workerEnv);
    if (existing) return new Response('Precondition Failed', { status: 412 });
  }

  const ops = getStorageOps(sourceMount);
  return move ? ops.move(sourceKey, destination.key, workerEnv) : ops.copy(sourceKey, destination.key, workerEnv);
}

// --- Main Dispatcher ---

export async function handleWebDavRequest(config: WebDavConfig, relativePath: string, extra: {
  request?: Request; url?: URL; path?: string; db?: unknown; options?: Record<string, unknown>; env?: Record<string, unknown>;
}): Promise<Response> {
  const request = extra.request!;
  if (request.method === 'OPTIONS') return optionsResponse();

  if (!extra.db) return new Response('Database unavailable', { status: 503 });
  const clientIp = getWebDavClientIp(request);
  const hasBasicAuthAttempt = /^Basic\s+/i.test(request.headers.get('authorization') || '');
  if (hasBasicAuthAttempt && isWebDavClientBanned(config, clientIp)) {
    return new Response('Too many failed login attempts', {
      status: 429,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': String(config.failBanSeconds) },
    });
  }

  const authResult = await authenticate(request, extra.db as any);
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
        if (await getStorageOps(mount).collectionExists(key, workerEnv)) {
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

// --- Storage Adapter for Admin API ---

export function createStorageAdapter(config: WebDavConfig) {
  function resolve(path: string) {
    const target = resolveWebDavTarget(config, path);
    if (!target) throw new Error('Invalid path');
    return { ops: getStorageOps(target.mount), mount: target.mount, key: target.key };
  }

  return {
    list(path: string, workerEnv?: Record<string, unknown>, limit?: number, offset?: number) {
      const { ops, key } = resolve(path);
      return ops.list(key, workerEnv, limit, offset);
    },
    // Does not use resolve() — returns null for invalid paths instead of throwing
    async meta(path: string, workerEnv?: Record<string, unknown>) {
      const target = resolveWebDavTarget(config, path);
      if (!target) return null;
      return getStorageOps(target.mount).meta(target.key, workerEnv);
    },
    read(path: string, workerEnv?: Record<string, unknown>) {
      const { ops, key } = resolve(path);
      return ops.read(key, 'GET', workerEnv);
    },
    async write(path: string, body: ReadableStream<Uint8Array> | null, contentType: string, workerEnv?: Record<string, unknown>) {
      const { ops, key } = resolve(path);
      if (!key || key.endsWith('/')) throw new Error('Invalid target');
      const response = await ops.write(key, body, contentType, workerEnv);
      if (!response.ok) throw new Error(`Storage write failed (${response.status})`);
      return response;
    },
    async mkdir(path: string, workerEnv?: Record<string, unknown>) {
      const { ops, key } = resolve(path);
      const response = await ops.mkdir(key, workerEnv);
      if (!response.ok) throw new Error(`Create directory failed (${response.status})`);
      return response;
    },
    async delete(path: string, workerEnv?: Record<string, unknown>) {
      const { ops, key } = resolve(path);
      if (!key) throw new Error('Cannot delete mount root');
      const isCollection = path.endsWith('/') || path === '';
      if (isCollection) {
        if (!(await ops.isEmpty(key, workerEnv))) {
          throw new Error('Directory is not empty');
        }
      }
      const response = await ops.delete(key, workerEnv);
      if (!response.ok) throw new Error(`Delete failed (${response.status})`);
      return response;
    },
    getMounts() {
      return config.mounts.map(m => ({ name: m.mount || '/', provider: m.provider }));
    },
  };
}
