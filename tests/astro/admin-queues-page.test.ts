import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@/db';
import { resetCacheVersionMemo } from '@/lib/cache';
import { DEFAULT_QUEUE_PROVIDER_ID } from '@/lib/default-queue-provider';
import { addHook, HookPoints } from '@/lib/hooks';
import { resetOptionsSnapshot } from '@/lib/options';
import { registerPluginInit, resetPluginInitState } from '@/lib/plugin';
import ManageQueues from '@/pages/admin/manage-queues.astro';
import initCloudflareQueue from '@/plugins/typecho-plugin-queue';
import { createTestDb, disposeTestDb, makeAuthCookie, seedAdmin, type TestDatabase } from '../helpers';
import { renderComponent } from './helpers';

const queue = vi.hoisted(() => ({ binding: undefined as unknown }));
let db: TestDatabase;

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>();
  return { ...actual, getDb: () => db, getPrimaryDb: () => db };
});
vi.mock('cloudflare:workers', () => ({
  env: { get QUEUE() { return queue.binding; } },
}));

const secret = 'queue-page-secret';
const authCode = 'queue-page-auth-code';

async function renderDashboard(enabled: boolean, group = 'administrator') {
  const admin = await seedAdmin(db, { secret, authCode, group });
  await db.insert(schema.options).values([
    { name: 'lang', user: 0, value: 'en' },
    { name: 'activatedPlugins', user: 0, value: JSON.stringify(enabled ? [DEFAULT_QUEUE_PROVIDER_ID] : []) },
  ]);
  const cookie = await makeAuthCookie(db, admin.uid, authCode, secret);
  return renderComponent(ManageQueues, {
    request: new Request('https://example.com/admin/manage-queues', { headers: { cookie } }),
    locals: {},
  });
}

describe('admin queue dashboard rendering', () => {
  beforeEach(async () => {
    db = await createTestDb();
    queue.binding = undefined;
    resetCacheVersionMemo();
    resetOptionsSnapshot();
    resetPluginInitState();
    registerPluginInit({ [DEFAULT_QUEUE_PROVIDER_ID]: initCloudflareQueue }, { addHook, HookPoints });
  });

  afterEach(async () => {
    await disposeTestDb(db);
  });

  it('rejects users who are not administrators', async () => {
    const html = await renderDashboard(false, 'editor');
    expect(html).toContain('Forbidden');
    expect(html).not.toContain('queue-page');
  });

  it('renders the enabled provider without a queue resource', async () => {
    const html = await renderDashboard(true);
    expect(html).toContain('The queue provider is enabled, but a queue resource is unavailable.');
    expect(html).not.toContain('id="queue-main"');
  });

  it('renders provider metrics and distinguishes them from disabled status', async () => {
    const metrics = vi.fn(async () => ({ backlogCount: 12, backlogBytes: 250 }));
    queue.binding = { send: vi.fn(), sendBatch: vi.fn(), metrics };

    const html = await renderDashboard(true);
    expect(html).toContain('The queue provider is available.');
    expect(html).toContain('id="queue-main"');
    expect(html).toContain('>250 B<');
    expect(html).toContain('queue-card');
    expect(html).toContain('queue-metrics');
    expect(html).not.toMatch(/<form[^>]*action="[^"]*\/api\/admin\//i);
    expect(html).not.toContain('deadLetterQueue');
    expect(metrics).toHaveBeenCalledOnce();
  });

  it('serves nothing when no queue provider is enabled', async () => {
    const metrics = vi.fn();
    queue.binding = { send: vi.fn(), sendBatch: vi.fn(), metrics };

    const html = await renderDashboard(false);
    expect(html).not.toContain('queue-page');
    expect(metrics).not.toHaveBeenCalled();
  });
});
