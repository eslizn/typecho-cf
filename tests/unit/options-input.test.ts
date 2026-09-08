import { describe, expect, it } from 'vitest';
import { parseSiteOptionsInput, SiteOptionsInputError } from '@/lib/options-input';

function parse(values: Record<string, string>, sourcePath = '/admin/options-general') {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  return parseSiteOptionsInput({ formData, sourcePath });
}

describe('parseSiteOptionsInput()', () => {
  it('normalizes a valid settings submission and checkbox defaults', () => {
    expect(parse({
      title: 'Blog',
      siteUrl: 'https://example.com/',
      timezone: '28800',
      allowRegister: '1',
    })).toMatchObject({
      title: 'Blog',
      siteUrl: 'https://example.com',
      timezone: '28800',
      allowRegister: '1',
      cacheEnabled: '0',
      mailEnabled: '0',
    });
  });

  it('converts discussion units only after validating their ranges', () => {
    expect(parse({ commentsPostTimeout: '7', commentsPostInterval: '5' }, '/admin/options-discussion'))
      .toMatchObject({ commentsPostTimeout: '604800', commentsPostInterval: '300' });
  });

  it('preserves an explicit empty language and accepts legacy locale aliases', () => {
    expect(parse({ lang: '' })).toMatchObject({ lang: '' });
    expect(parse({ lang: 'zh_CN' })).toMatchObject({ lang: 'zh_CN' });
    expect(parse({ lang: 'en-US' })).toMatchObject({ lang: 'en-US' });
  });

  it.each([
    ['siteUrl', 'javascript:alert(1)'],
    ['siteUrl', 'https://user:secret@example.com'],
    ['siteUrl', 'https://example.com/blog'],
    ['pageSize', '0'],
    ['feedItems', '51'],
    ['timezone', 'Infinity'],
    ['allowRegister', 'true'],
    ['commentsOrder', 'RANDOM'],
    ['lang', '../en'],
  ])('rejects invalid %s without returning a partial result', (field, value) => {
    expect(() => parse({ title: 'must-not-save', [field]: value }))
      .toThrow(SiteOptionsInputError);
  });

  it('validates every permalink pattern kind', () => {
    expect(parse({
      permalinkPattern: 'custom',
      customPattern: '/{year}/{slug}/',
      pagePattern: '/pages/{cid}/',
      categoryPattern: '/topics/{slug}/',
    }, '/admin/options-permalink')).toMatchObject({
      permalinkPattern: '/{year}/{slug}/',
      pagePattern: '/pages/{cid}/',
      categoryPattern: '/topics/{slug}/',
    });

    expect(() => parse({ pagePattern: '/pages/{year}/' }, '/admin/options-permalink'))
      .toThrow(/Invalid pagePattern/);
  });
});
