/**
 * Unit tests for src/lib/options.ts
 *
 * Tests loadOptions(), getOption(), setOption(), deleteOption() and computeUrls()
 * using an in-memory libSQL database via Drizzle ORM.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../helpers';
import { schema } from '@/db';
import {
  loadOptions,
  getOption,
  setOption,
  setOptionsBatch,
  deleteOption,
  computeUrls,
  ensureSecret,
} from '@/lib/options';
import { bumpCacheVersion, resetCacheVersionMemo } from '@/lib/cache';

async function createOptionsTestDb() {
  return await createTestDb() as any;
}

describe('loadOptions()', () => {
  it('returns defaults when database is empty', async () => {
    const db = await createOptionsTestDb();
    const opts = await loadOptions(db);
    expect(opts.title).toBe('Hello World');
    expect(opts.pageSize).toBe(5);
    expect(opts.commentsPostInterval).toBe(60);
    expect(opts.timezone).toBe('Asia/Shanghai');
  });

  it('keeps legacy NULL lang rows fixed to the Chinese default', async () => {
    const db = await createOptionsTestDb();
    await db.insert(schema.options).values({ name: 'lang', user: 0, value: null });
    const opts = await loadOptions(db);
    expect(opts.lang).toBe('zh_CN');
  });

  it('overrides defaults with values from DB', async () => {
    const db = await createOptionsTestDb();
    await setOption(db, 'title', 'My Blog');
    await setOption(db, 'pageSize', '10');
    const opts = await loadOptions(db);
    expect(opts.title).toBe('My Blog');
    expect(opts.pageSize).toBe(10);
  });

  it('parses numeric option keys as integers', async () => {
    const db = await createOptionsTestDb();
    await setOption(db, 'allowRegister', '1');
    const opts = await loadOptions(db);
    expect(typeof opts.allowRegister).toBe('number');
    expect(opts.allowRegister).toBe(1);
  });

  it('keeps IANA time zones and normalizes invalid rows to the default', async () => {
    const db = await createOptionsTestDb();
    await setOption(db, 'timezone', 'America/New_York');
    expect((await loadOptions(db)).timezone).toBe('America/New_York');

    await setOption(db, 'timezone', '28800');
    expect((await loadOptions(db)).timezone).toBe('Asia/Shanghai');
  });

  it('does not auto-generate secret in the read path', async () => {
    // loadOptions is a pure read; secret bootstrap is now handled by
    // ensureSecret() during install / by middleware for PHP migrations.
    const db = await createOptionsTestDb();
    const opts = await loadOptions(db);
    expect(opts.secret).toBeUndefined();
  });

  it('reuses the parsed isolate snapshot for repeated reads', async () => {
    const db = await createOptionsTestDb();
    const matchSpy = vi.spyOn(caches.default, 'match');
    await loadOptions(db);
    const callsAfterFirstLoad = matchSpy.mock.calls.length;
    await loadOptions(db);
    expect(matchSpy.mock.calls.length).toBe(callsAfterFirstLoad);
    matchSpy.mockRestore();
  });

  it('observes a direct cache-version bump immediately in the same isolate', async () => {
    const db = await createOptionsTestDb();
    await db.insert(schema.options).values({
      name: 'cacheVersion',
      user: 0,
      value: '100',
    });
    const before = await loadOptions(db);
    expect(before.cacheVersion).toBe(100);

    await bumpCacheVersion(db);
    const after = await loadOptions(db);
    expect(after.cacheVersion).toBe(101);
  });

  it('reloads when cacheVersion changes without a local snapshot generation bump', async () => {
    const db = await createOptionsTestDb();
    await setOption(db, 'title', 'Local');
    const first = await loadOptions(db);
    expect(first.title).toBe('Local');

    // Simulate a remote PoP write: mutate rows + bump stamp without advancing
    // this isolate's snapshot generation.
    await db.insert(schema.options).values({ name: 'title', user: 0, value: 'Remote' })
      .onConflictDoUpdate({
        target: [schema.options.user, schema.options.name],
        set: { value: 'Remote' },
      });
    await db.insert(schema.options).values({ name: 'cacheVersion', user: 0, value: '42' })
      .onConflictDoUpdate({
        target: [schema.options.user, schema.options.name],
        set: { value: '42' },
      });
    resetCacheVersionMemo();

    const second = await loadOptions(db);
    expect(second.title).toBe('Remote');
    expect(second.cacheVersion).toBe(42);
  });

  it('ensureSecret generates and persists on first call, reuses on subsequent calls', async () => {
    const db = await createOptionsTestDb();
    const first = await ensureSecret(db);
    expect(first).toBeTruthy();
    expect(first.length).toBeGreaterThan(0);
    const second = await ensureSecret(db);
    expect(second).toBe(first);
  });
});

describe('getOption()', () => {
  it('returns null for non-existent option', async () => {
    const db = await createOptionsTestDb();
    expect(await getOption(db, 'nonexistent')).toBeNull();
  });

  it('returns stored value', async () => {
    const db = await createOptionsTestDb();
    await setOption(db, 'title', 'Test Blog');
    expect(await getOption(db, 'title')).toBe('Test Blog');
  });
});

describe('setOption()', () => {
  it('inserts a new option', async () => {
    const db = await createOptionsTestDb();
    await setOption(db, 'theme', 'my-theme');
    expect(await getOption(db, 'theme')).toBe('my-theme');
  });

  it('updates an existing option (upsert)', async () => {
    const db = await createOptionsTestDb();
    await setOption(db, 'title', 'First');
    await setOption(db, 'title', 'Updated');
    expect(await getOption(db, 'title')).toBe('Updated');
  });
});

describe('setOptionsBatch()', () => {
  it('writes all values and one cache version in the same logical change', async () => {
    const db = await createOptionsTestDb();
    await setOptionsBatch(db, { title: 'Batch title', pageSize: '12' });
    expect(await getOption(db, 'title')).toBe('Batch title');
    expect(await getOption(db, 'pageSize')).toBe('12');
    expect(await getOption(db, 'cacheVersion')).toBeTruthy();
  });
});

describe('deleteOption()', () => {
  it('removes an option', async () => {
    const db = await createOptionsTestDb();
    await setOption(db, 'toDelete', 'value');
    await deleteOption(db, 'toDelete');
    expect(await getOption(db, 'toDelete')).toBeNull();
  });

  it('does not throw when deleting non-existent option', async () => {
    const db = await createOptionsTestDb();
    await expect(deleteOption(db, 'ghost')).resolves.toBeUndefined();
  });
});

describe('computeUrls()', () => {
  const baseOpts = {
    siteUrl: 'https://example.com',
    theme: 'typecho-theme-minimal',
  } as any;

  it('computes admin URL', () => {
    const urls = computeUrls(baseOpts);
    expect(urls.adminUrl).toBe('https://example.com/admin/');
  });

  it('strips trailing slash from siteUrl', () => {
    const urls = computeUrls({ ...baseOpts, siteUrl: 'https://example.com/' });
    expect(urls.siteUrl).toBe('https://example.com');
  });

  it('computes feed URLs', () => {
    const urls = computeUrls(baseOpts);
    expect(urls.feedUrl).toBe('https://example.com/feed');
    expect(urls.feedRssUrl).toBe('https://example.com/feed/rss');
    expect(urls.feedAtomUrl).toBe('https://example.com/feed/atom');
  });

  it('themeUrl builds correct path', () => {
    const urls = computeUrls(baseOpts);
    expect(urls.themeUrl('style.css')).toBe('https://example.com/themes/typecho-theme-minimal/style.css');
  });
});
