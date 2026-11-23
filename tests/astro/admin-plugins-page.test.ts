import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@/db';
import { discoverPlugins } from '@/integrations/plugin-loader';
import { generateSecurityToken } from '@/lib/auth';
import { resetCacheVersionMemo } from '@/lib/cache';
import { getCapabilityActivationGeneration } from '@/lib/capability';
import { resetOptionsSnapshot } from '@/lib/options';
import {
  addHook,
  HookPoints,
  registerPlugin,
  registerPluginInit,
  resetPluginInitState,
  type PluginManifest,
} from '@/lib/plugin';
import type { CapabilityRuntimeContext } from '@/lib/capability';
import Plugins from '@/pages/admin/plugins.astro';
import initQueuePlugin from '@/plugins/typecho-plugin-queue';
import { createTestDb, disposeTestDb, makeAuthCookie, seedAdmin, type TestDatabase } from '../helpers';
import { renderComponent } from './helpers';

const SECRET = 'plugins-secret';
const AUTH_CODE = 'plugins-auth-code';
const PLUGIN_ID = 'test-capability-plugin';
const QUEUE_PLUGIN_ID = 'typecho-plugin-queue';
const queueManifest = discoverPlugins(process.cwd())
  .find(plugin => plugin.id === QUEUE_PLUGIN_ID)!.manifest as PluginManifest;

let db: TestDatabase;
const hookRuntimes: CapabilityRuntimeContext[] = [];

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: () => db, getPrimaryDb: () => db, schema: actual.schema };
});
vi.mock('cloudflare:workers', () => ({ env: {} }));

describe('admin plugin activation', () => {
  beforeEach(async () => {
    db = await createTestDb();
    resetCacheVersionMemo();
    resetOptionsSnapshot();
    resetPluginInitState();
    hookRuntimes.length = 0;
    registerPlugin('typecho-plugin-test', { id: PLUGIN_ID, name: 'Test capability plugin' });
    registerPluginInit({
      [PLUGIN_ID]: ({ addHook: register }) => {
        register('admin:footer', PLUGIN_ID, (
          html: string,
          extra: { capabilityRuntime?: CapabilityRuntimeContext },
        ) => {
          if (extra.capabilityRuntime) hookRuntimes.push(extra.capabilityRuntime);
          return html;
        });
      },
    }, { addHook, HookPoints });
  });

  afterEach(async () => {
    await disposeTestDb(db);
  });

  async function renderPluginList(lang: string, activatedPlugins: string[]) {
    const admin = await seedAdmin(db, { secret: SECRET, authCode: AUTH_CODE });
    await db.insert(schema.options).values([
      { name: 'lang', user: 0, value: lang },
      { name: 'siteUrl', user: 0, value: 'https://example.com' },
      { name: 'activatedPlugins', user: 0, value: JSON.stringify(activatedPlugins) },
    ]);
    const cookie = await makeAuthCookie(db, admin.uid, AUTH_CODE, SECRET);
    return renderComponent(Plugins, {
      request: new Request('https://example.com/admin/plugins', { headers: { cookie } }),
      locals: {},
    });
  }

  it('localizes the active Queue plugin description from its build-time display catalog', async () => {
    registerPlugin(QUEUE_PLUGIN_ID, queueManifest);
    registerPluginInit({ [QUEUE_PLUGIN_ID]: initQueuePlugin }, { addHook, HookPoints });

    const html = await renderPluginList('zh-CN', [QUEUE_PLUGIN_ID]);

    expect(html).toContain('为 Cloudflare Workers 提供后台任务传输与队列监控');
    expect(html).not.toContain(queueManifest.description);
  });

  it('localizes the Queue plugin description while it is inactive', async () => {
    registerPlugin(QUEUE_PLUGIN_ID, queueManifest);
    registerPluginInit({ [QUEUE_PLUGIN_ID]: initQueuePlugin }, { addHook, HookPoints });

    const html = await renderPluginList('zh-CN', []);

    expect(html).toContain('为 Cloudflare Workers 提供后台任务传输与队列监控');
    expect(html).not.toContain(queueManifest.description);
  });

  it('falls back to the manifest description without display locales', async () => {
    registerPlugin('typecho-plugin-plain', {
      id: 'typecho-plugin-plain',
      name: 'Plain',
      description: 'Manifest description only',
    });

    const html = await renderPluginList('zh-CN', []);

    expect(html).toContain('Manifest description only');
  });

  it('rebuilds the request capability runtime after a plugin is activated', async () => {
    const admin = await seedAdmin(db, { secret: SECRET, authCode: AUTH_CODE });
    await db.insert(schema.options).values([
      { name: 'lang', user: 0, value: 'en' },
      { name: 'siteUrl', user: 0, value: 'https://example.com' },
      { name: 'activatedPlugins', user: 0, value: '[]' },
    ]);
    const cookie = await makeAuthCookie(db, admin.uid, AUTH_CODE, SECRET);
    const csrf = await generateSecurityToken(SECRET, AUTH_CODE, admin.uid);
    const body = new URLSearchParams({ _: csrf, action: 'activate', plugin: PLUGIN_ID });

    await renderComponent(Plugins, {
      request: new Request('https://example.com/admin/plugins', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://example.com',
          cookie,
        },
        body: body.toString(),
      }),
      locals: {},
    });

    expect(hookRuntimes.length).toBeGreaterThan(0);
    const runtime = hookRuntimes[hookRuntimes.length - 1]!;
    expect(runtime.activatedPlugins.has(PLUGIN_ID)).toBe(true);
    expect(runtime.activationGeneration).toBe(getCapabilityActivationGeneration());
  });
});
