/**
 * Unit tests for src/lib/options.ts
 *
 * Tests loadOptions(), getOption(), setOption(), deleteOption() and computeUrls()
 * using an in-memory better-sqlite3 database via Drizzle ORM.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers';
import { loadOptions, getOption, setOption, deleteOption, computeUrls } from '@/lib/options';

function createOptionsTestDb() {
  return createTestDb() as any;
}

describe('loadOptions()', () => {
  it('returns defaults when database is empty', async () => {
    const db = createOptionsTestDb();
    const opts = await loadOptions(db);
    expect(opts.title).toBe('Hello World');
    expect(opts.pageSize).toBe(5);
    expect(opts.commentsPostInterval).toBe(60);
    expect(opts.timezone).toBe(28800);
  });

  it('overrides defaults with values from DB', async () => {
    const db = createOptionsTestDb();
    await setOption(db, 'title', 'My Blog');
    await setOption(db, 'pageSize', '10');
    const opts = await loadOptions(db);
    expect(opts.title).toBe('My Blog');
    expect(opts.pageSize).toBe(10);
  });

  it('parses numeric option keys as integers', async () => {
    const db = createOptionsTestDb();
    await setOption(db, 'allowRegister', '1');
    const opts = await loadOptions(db);
    expect(typeof opts.allowRegister).toBe('number');
    expect(opts.allowRegister).toBe(1);
  });

  it('auto-generates secret when missing and persists it', async () => {
    const db = createOptionsTestDb();
    const opts1 = await loadOptions(db);
    expect(opts1.secret).toBeTruthy();
    expect(opts1.secret.length).toBeGreaterThan(0);

    // Second load should return the same secret
    const opts2 = await loadOptions(db);
    expect(opts2.secret).toBe(opts1.secret);
  });
});

describe('getOption()', () => {
  it('returns null for non-existent option', async () => {
    const db = createOptionsTestDb();
    expect(await getOption(db, 'nonexistent')).toBeNull();
  });

  it('returns stored value', async () => {
    const db = createOptionsTestDb();
    await setOption(db, 'title', 'Test Blog');
    expect(await getOption(db, 'title')).toBe('Test Blog');
  });
});

describe('setOption()', () => {
  it('inserts a new option', async () => {
    const db = createOptionsTestDb();
    await setOption(db, 'theme', 'my-theme');
    expect(await getOption(db, 'theme')).toBe('my-theme');
  });

  it('updates an existing option (upsert)', async () => {
    const db = createOptionsTestDb();
    await setOption(db, 'title', 'First');
    await setOption(db, 'title', 'Updated');
    expect(await getOption(db, 'title')).toBe('Updated');
  });
});

describe('deleteOption()', () => {
  it('removes an option', async () => {
    const db = createOptionsTestDb();
    await setOption(db, 'toDelete', 'value');
    await deleteOption(db, 'toDelete');
    expect(await getOption(db, 'toDelete')).toBeNull();
  });

  it('does not throw when deleting non-existent option', async () => {
    const db = createOptionsTestDb();
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
