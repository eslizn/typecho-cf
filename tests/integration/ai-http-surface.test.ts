// End-to-end coverage for the AI plugin HTTP surface: middleware dispatch,
// bearer auth, and the capability behind it.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';
import { resetIsolateBoot } from '@/lib/isolate-boot';

let testDb: TestDatabase;

function createD1Stub() {
  return {
    prepare: (sql: string) => ({
      first: () => Promise.resolve(
        sql.includes('runtimeSchemaVersion')
          ? { value: '20260816' }
          : ({ name: 'typecho_options' } as any),
      ),
      all: () => Promise.resolve({ results: [] }),
      run: () => Promise.resolve({}),
      bind() { return this; },
    }),
    batch: () => Promise.resolve([]),
    dump: () => Promise.resolve([]),
    exec: () => Promise.resolve({}),
  };
}

let d1Stub = createD1Stub();

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: () => testDb, schema: actual.schema };
});

vi.mock('cloudflare:workers', () => ({
  env: {
    get DB() { return d1Stub; },
    BUCKET: { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn() },
  },
  caches: { default: { match: vi.fn(), put: vi.fn(), delete: vi.fn() } },
}));

import { schema } from '@/db';
import { resetCacheVersionMemo } from '@/lib/cache';
import { resetOptionsSnapshot } from '@/lib/options';
import { advanceOptionsSnapshotGeneration } from '@/lib/options-snapshot-generation';
import { onRequest } from '@/middleware';

const SITE = 'http://localhost:4321';
const ACCESS_TOKEN = 'access-secret-token-1234';
const AI_CONFIG = {
  providers: [{
    name: 'example',
    baseUrl: 'https://provider.example.com/v1',
    apiKey: 'upstream-secret',
    models: [{
      model: 'gpt-upstream',
      alias: 'chat',
      enabled: true,
      capabilities: ['ai.chat.generate'],
      modalities: ['text'],
    }],
  }],
  http: { enabled: 'true', basePath: '/ai', tokens: [{ id: 't1', token: ACCESS_TOKEN }] },
};

function makeCtx(path: string, init: RequestInit = {}) {
  const request = new Request(SITE + path, init);
  return {
    request,
    url: new URL(request.url),
    locals: {},
    redirect: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
    rewrite: (p: string) => new Response(null, { status: 302, headers: { Location: p } }),
  } as any;
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const next = vi.fn(async () => new Response('core fallback', { status: 404 }));
  return await onRequest(makeCtx(path, init), next) as Response;
}

describe('AI plugin HTTP surface', () => {
  beforeAll(async () => {
    testDb = await createTestDb();
    d1Stub = createD1Stub();
    resetIsolateBoot();
    resetCacheVersionMemo();
    await testDb.insert(schema.options).values([
      { name: 'siteUrl', user: 0, value: SITE },
      { name: 'installed', user: 0, value: '1' },
      { name: 'secret', user: 0, value: 'test-secret-32-chars-long!!!!!' },
      { name: 'title', user: 0, value: 'Test Blog' },
      { name: 'theme', user: 0, value: 'typecho-theme-minimal' },
      { name: 'activatedPlugins', user: 0, value: JSON.stringify(['typecho-plugin-ai']) },
      { name: 'plugin:typecho-plugin-ai', user: 0, value: JSON.stringify(AI_CONFIG) },
    ]);
    advanceOptionsSnapshotGeneration();
    resetOptionsSnapshot();
  });

  it('rejects a request without a bearer token', async () => {
    const response = await call('/ai/v1/models');

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('lists the published models for an authenticated caller', async () => {
    const response = await call('/ai/v1/models', {
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ id: string }> };
    expect(body.data.map(entry => entry.id)).toEqual(['chat']);
  });

  it('proxies a chat completion through the capability', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'completion-1',
      model: 'gpt-upstream',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const response = await call('/ai/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${ACCESS_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'chat', messages: [{ role: 'user', content: 'hi' }] }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0]?.message.content).toBe('hello');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('leaves unknown paths under the base path to the core router', async () => {
    const response = await call('/ai/other', {
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    expect(response.status).toBe(404);
  });
});
