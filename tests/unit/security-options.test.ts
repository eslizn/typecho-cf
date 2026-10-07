import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';
import { schema } from '@/db';
import type { SiteOptions } from '@/lib/options';
import { loadPluginSecurityOptions } from '@/lib/security-options';
import { getPrimaryDb } from '@/db';

let db: TestDatabase;
beforeEach(async () => { db = await createTestDb(); });
afterEach(async () => { db.$client.close(); await disposeTestDb(db); });

describe('plugin security options', () => {
  it('replaces cached activations/config and drops config for disabled plugins', async () => {
    const [enabled] = await db.insert(schema.options).values([
      { name: 'activatedPlugins', user: 0, value: '["enabled-plugin"]' },
      { name: 'plugin:enabled-plugin', user: 0, value: '{"token":"current"}' },
      { name: 'plugin:disabled-plugin', user: 0, value: '{"token":"must-not-survive"}' },
    ]).returning();
    expect(enabled.name).toBe('activatedPlugins');

    const cached = {
      activatedPlugins: '["enabled-plugin","disabled-plugin"]',
      'plugin:enabled-plugin': '{"token":"expired"}',
      'plugin:disabled-plugin': '{"token":"expired"}',
      title: 'Cached display value',
    } as unknown as SiteOptions;
    const fresh = await loadPluginSecurityOptions(db as any, cached);

    expect(fresh.activatedPlugins).toBe('["enabled-plugin"]');
    expect(fresh['plugin:enabled-plugin']).toBe('{"token":"current"}');
    expect(fresh['plugin:disabled-plugin']).toBe('{"token":"must-not-survive"}');
    expect(fresh.title).toBe('Cached display value');
  });

  it('treats a missing activation row as all plugins disabled', async () => {
    const fresh = await loadPluginSecurityOptions(db as any, {
      activatedPlugins: '["stale"]',
      'plugin:stale': '{"token":"old"}',
      title: 'Blog',
    } as unknown as SiteOptions);
    expect(fresh.activatedPlugins).toBe('');
    expect(fresh['plugin:stale']).toBeUndefined();
    expect(fresh.title).toBe('Blog');
  });

  it('uses a first-primary D1 session for security reads', () => {
    const session = { prepare: () => ({}), batch: async () => [] };
    const withSession = vi.fn(() => session);
    const primaryDb = getPrimaryDb({ withSession } as any);
    expect(withSession).toHaveBeenCalledOnce();
    expect(withSession).toHaveBeenCalledWith('first-primary');
    expect(primaryDb).toBeDefined();
  });
});
