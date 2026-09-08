import { describe, expect, it } from 'vitest';
import {
  InputError,
  inputErrorMessage,
  inputErrorResponse,
  normalizeSlug,
  parsePageNumber,
  parsePositiveInteger,
  readBoundedFormData,
  readBoundedJson,
  withQueryParams,
} from '@/lib/input';
import { createI18n } from '@/lib/i18n';
import { coreCatalogs } from '@/i18n/catalogs';

describe('readBoundedFormData()', () => {
  it('parses a body within the declared limit', async () => {
    const request = new Request('https://example.com/form', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'title=Hello',
    });
    expect((await readBoundedFormData(request, 1024)).get('title')).toBe('Hello');
  });

  it('rejects an oversized declared body before parsing it', async () => {
    const request = new Request('https://example.com/form', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': '2048',
      },
      body: 'title=Hello',
    });
    await expect(readBoundedFormData(request, 1024)).rejects.toMatchObject({
      status: 413,
      message: 'Request body too large',
    });
  });

  it('rejects an oversized chunked-style form body without Content-Length', async () => {
    const request = new Request('https://example.com/form', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `message=${'x'.repeat(100)}`,
    });
    request.headers.delete('content-length');

    await expect(readBoundedFormData(request, 32)).rejects.toMatchObject({
      status: 413,
      message: 'Request body too large',
    });
  });

  it('rejects malformed Content-Length values', async () => {
    const request = new Request('https://example.com/form', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '12x' },
      body: 'title=Hello',
    });
    await expect(readBoundedFormData(request, 1024)).rejects.toBeInstanceOf(InputError);
  });

  it('maps parser failures to a stable 400 error', async () => {
    const request = new Request('https://example.com/form', { method: 'POST', body: 'raw' });
    await expect(readBoundedFormData(request, 1024)).rejects.toMatchObject({
      status: 400,
      message: 'Malformed form data',
    });
  });
});

describe('localized input errors', () => {
  it('keeps a stable descriptor and renders it in the request locale', async () => {
    const request = new Request('https://example.com/form', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '2048' },
      body: 'title=Hello',
    });
    let error: InputError | undefined;
    try {
      await readBoundedFormData(request, 1024);
    } catch (caught) {
      error = caught as InputError;
    }
    expect(error).toBeInstanceOf(InputError);
    expect(inputErrorMessage(error!)).toMatchObject({ key: 'core.error.requestBodyTooLarge' });
    const response = inputErrorResponse(error!, createI18n({ locale: 'zh-CN', catalogs: coreCatalogs }));
    expect(await response.text()).toBe('请求体过大');
    expect(response.headers.get('X-Typecho-I18n-Code')).toBe('core.error.requestBodyTooLarge');
  });
});

describe('readBoundedJson()', () => {
  it('parses a bounded JSON object', async () => {
    const request = new Request('https://example.com/json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    });
    await expect(readBoundedJson(request, 1024)).resolves.toEqual({ ok: true });
  });

  it('rejects an oversized chunked-style body without Content-Length', async () => {
    const request = new Request('https://example.com/json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(100) }),
    });
    request.headers.delete('content-length');
    await expect(readBoundedJson(request, 32)).rejects.toMatchObject({ status: 413 });
  });

  it('maps malformed JSON to a stable 400 error', async () => {
    const request = new Request('https://example.com/json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken',
    });
    await expect(readBoundedJson(request, 1024)).rejects.toMatchObject({ status: 400 });
  });
});

describe('parsePageNumber()', () => {
  it.each([undefined, null, '', 'wat', '1.5', '1e2', Number.POSITIVE_INFINITY, -2, 0])(
    'normalizes %j to the default page',
    (value) => expect(parsePageNumber(value)).toBe(1),
  );

  it('accepts integers and clamps the configured upper bound', () => {
    expect(parsePageNumber('42')).toBe(42);
    expect(parsePageNumber('999', { max: 50 })).toBe(50);
    expect(parsePageNumber('8', { max: Number.NaN })).toBe(8);
  });
});

describe('parsePositiveInteger()', () => {
  it('accepts bounded identifiers and rejects malformed values', () => {
    expect(parsePositiveInteger('42')).toBe(42);
    expect(parsePositiveInteger('0')).toBeNull();
    expect(parsePositiveInteger('-1')).toBeNull();
    expect(parsePositiveInteger('1e2')).toBeNull();
    expect(parsePositiveInteger('999', 100)).toBeNull();
  });
});

describe('normalizeSlug()', () => {
  it('preserves Unicode letters while removing unsafe URL characters', () => {
    expect(normalizeSlug(' 你好 / Astro?# ')).toBe('你好-astro');
  });

  it('normalizes compatibility characters and uses a safe fallback', () => {
    expect(normalizeSlug('Ｆｏｏ　Ｂａｒ')).toBe('foo-bar');
    expect(normalizeSlug('///', 'Fallback Title')).toBe('fallback-title');
  });

  it('truncates by Unicode code point without splitting characters', () => {
    const slug = normalizeSlug('界'.repeat(151));
    expect([...slug]).toHaveLength(150);
    expect(slug.endsWith('界')).toBe(true);
  });
});

describe('withQueryParams()', () => {
  it('preserves existing values, updates fields, and omits empty values', () => {
    expect(withQueryParams('/admin/posts?status=draft&uid=2', {
      page: 3,
      status: 'publish',
      uid: null,
    })).toBe('/admin/posts?status=publish&page=3');
  });
});
