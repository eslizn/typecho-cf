/**
 * Render tests for the content-editor upload panel.
 *
 * The upload/delete AJAX handlers live in an inline script (no DOM harness),
 * but the pages must hand that script a valid CSRF token; otherwise every
 * drag-and-drop or picker upload is rejected by /api/admin/upload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import { validateSecurityToken } from '@/lib/auth';
import * as workerRuntime from 'cloudflare:workers';
import { createTestDb, disposeTestDb, makeAuthCookie, seedAdmin, type TestDatabase } from '../helpers';
import { renderComponent } from './helpers';

let testDb: TestDatabase;
const runtime = workerRuntime as unknown as { caches: typeof globalThis.caches; _resetCaches: () => void };
(globalThis as any).caches = runtime.caches;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: () => testDb, schema: actual.schema };
});

import WritePost from '@/pages/admin/write-post.astro';
import WritePage from '@/pages/admin/write-page.astro';

const SECRET = 'upload-secret';
const AUTH_CODE = 'upload-auth-code';

beforeEach(async () => {
  runtime._resetCaches();
  testDb = await createTestDb();
  await seedAdmin(testDb, { secret: SECRET, authCode: AUTH_CODE });
  await testDb.insert(schema.options).values([
    { name: 'siteUrl', user: 0, value: 'https://example.com' },
    { name: 'timezone', user: 0, value: 'Asia/Shanghai' },
    { name: 'theme', user: 0, value: 'typecho-theme-minimal' },
  ]);
});
afterEach(async () => { await disposeTestDb(testDb); });

describe.each([
  ['post editor', WritePost, 'write-post'],
  ['page editor', WritePage, 'write-page'],
] as const)('%s upload panel', (_label, component, route) => {
  it('exposes a valid CSRF token for upload and delete requests', async () => {
    const admin = (await testDb.query.users.findFirst())!;
    const cookie = await makeAuthCookie(testDb, admin.uid, AUTH_CODE, SECRET);
    const html = await renderComponent(component, {
      request: new Request(`https://example.com/admin/${route}`, { headers: { cookie } }),
      locals: {},
    });

    const token = html.match(/id="upload-panel"[^>]*data-csrf="([^"]*)"/)?.[1];
    expect(token).toBeTruthy();
    expect(await validateSecurityToken(token!, SECRET, AUTH_CODE, admin.uid)).toBe(true);
  });

  it('labels the primary submit button as a publish action', async () => {
    const admin = (await testDb.query.users.findFirst())!;
    const cookie = await makeAuthCookie(testDb, admin.uid, AUTH_CODE, SECRET);
    const html = await renderComponent(component, {
      request: new Request(`https://example.com/admin/${route}`, { headers: { cookie } }),
      locals: {},
    });

    const label = html.match(/<button[^>]*id="btn-submit"[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? '';
    expect(label).toContain('发布');
    expect(label).not.toContain('已发布');
  });
});

// ---------------------------------------------------------------------------
// Attachment insertion (executed from the rendered inline script)
// ---------------------------------------------------------------------------

const ABSOLUTE_URL = 'https://example.com/usr/uploads/2026/11/3396430629.png';
const RELATIVE_URL = '/usr/uploads/2026/11/3396430629.png';

interface TextareaMock {
  value: string;
  selection: { start: number; end: number };
  val(next?: string): string | TextareaMock;
  getSelection(): { start: number; end: number };
  setSelection(start: number, end: number): void;
  trigger: ReturnType<typeof vi.fn>;
}

function createEditor(value: string, markdown: boolean, start = value.length, end = start) {
  const textarea: TextareaMock = {
    value,
    selection: { start, end },
    val(next?: string) {
      if (next === undefined) return this.value;
      this.value = next;
      return this;
    },
    getSelection() { return this.selection; },
    setSelection(nextStart: number, nextEnd: number) { this.selection = { start: nextStart, end: nextEnd }; },
    trigger: vi.fn(),
  };
  const jquery = (selector: string) => {
    if (selector === '#text') return textarea;
    if (selector === 'input[name="markdown"]') return { length: markdown ? 1 : 0 };
    throw new Error(`Unexpected selector: ${selector}`);
  };
  return { textarea, jquery };
}

function extractInsertSource(html: string): string {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1] || '');
  const script = scripts.find(source => source.includes('Typecho.insertFileToEditor = function'));
  if (!script) throw new Error('editor inline script not found');

  const marker = 'Typecho.insertFileToEditor = function';
  const start = script.indexOf(marker);
  const bodyStart = script.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < script.length; index++) {
    if (script[index] === '{') depth++;
    else if (script[index] === '}') {
      depth--;
      if (depth === 0) return `${script.slice(start, index + 1)};`;
    }
  }
  throw new Error('unterminated insertFileToEditor');
}

function loadInserter(source: string, jquery: (selector: string) => unknown) {
  const escapeClientHtml = (value: unknown) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const Typecho: Record<string, unknown> = {};
  new Function('$', 'location', 'escapeClientHtml', 'Typecho', `${source}\nreturn Typecho;`)(
    jquery,
    { origin: 'https://example.com' },
    escapeClientHtml,
    Typecho,
  );
  return Typecho.insertFileToEditor as (title: string, url: string, isImage: boolean | number) => void;
}

async function renderInsertSource(): Promise<string> {
  const admin = (await testDb.query.users.findFirst())!;
  const cookie = await makeAuthCookie(testDb, admin.uid, AUTH_CODE, SECRET);
  const html = await renderComponent(WritePost, {
    request: new Request('https://example.com/admin/write-post', { headers: { cookie } }),
    locals: {},
  });
  return extractInsertSource(html);
}

describe('attachment insertion', () => {
  it('inserts an image as a reference and appends the URL definition', async () => {
    const source = await renderInsertSource();
    const { textarea, jquery } = createEditor('Body ', true);

    loadInserter(source, jquery)('pic.png', ABSOLUTE_URL, true);

    expect(textarea.value).toBe(`Body ![pic.png][1]\n  [1]: ${RELATIVE_URL}`);
    expect(textarea.selection.start).toBe('Body '.length + '![pic.png][1]'.length);
  });

  it('reuses an existing reference instead of appending another definition', async () => {
    const source = await renderInsertSource();
    const value = `Body ![pic.png][1]\n\n  [1]: ${RELATIVE_URL}`;
    const { textarea, jquery } = createEditor(value, true, 5, 5);

    loadInserter(source, jquery)('pic.png', ABSOLUTE_URL, true);

    expect(textarea.value).toBe(`Body ![pic.png][1]![pic.png][1]\n\n  [1]: ${RELATIVE_URL}`);
    expect(textarea.value.match(/\[1\]:/g)).toHaveLength(1);
  });

  it('reuses an absolute definition for the same file', async () => {
    const source = await renderInsertSource();
    const value = `[old][1]\n\n  [1]: ${ABSOLUTE_URL}`;
    const { textarea, jquery } = createEditor(value, true, 0, 0);

    loadInserter(source, jquery)('pic.png', ABSOLUTE_URL, true);

    expect(textarea.value).toBe(`![pic.png][1][old][1]\n\n  [1]: ${ABSOLUTE_URL}`);
  });

  it('appends the next definition on the following line without a blank line', async () => {
    const source = await renderInsertSource();
    const { textarea, jquery } = createEditor('x\n\n  [2]: /usr/uploads/other.png', true, 0, 0);

    loadInserter(source, jquery)('pic.png', ABSOLUTE_URL, true);

    expect(textarea.value).toBe(
      `![pic.png][3]x\n\n  [2]: /usr/uploads/other.png\n  [3]: ${RELATIVE_URL}`,
    );
  });

  it('inserts non-images as reference links', async () => {
    const source = await renderInsertSource();
    const { textarea, jquery } = createEditor('', true);

    loadInserter(source, jquery)('report.pdf', ABSOLUTE_URL, false);

    expect(textarea.value).toBe(`[report.pdf][1]\n  [1]: ${RELATIVE_URL}`);
  });

  it('escapes brackets in the reference label text', async () => {
    const source = await renderInsertSource();
    const { textarea, jquery } = createEditor('', true);

    loadInserter(source, jquery)('a[1].png', ABSOLUTE_URL, true);

    expect(textarea.value).toContain('![a\\[1\\].png][1]');
  });

  it('keeps inline HTML insertion when Markdown mode is off', async () => {
    const source = await renderInsertSource();
    const { textarea, jquery } = createEditor('', false);

    loadInserter(source, jquery)('a"b.png', ABSOLUTE_URL, true);

    expect(textarea.value).toBe(`<img src="${RELATIVE_URL}" alt="a&quot;b.png" />`);
  });
});
