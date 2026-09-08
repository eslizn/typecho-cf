import { describe, expect, it } from 'vitest';
import { createRequestI18n } from '@/lib/i18n-runtime';

describe('createRequestI18n()', () => {
  it('selects the browser locale only when lang is empty', () => {
    const request = new Request('https://example.com/', { headers: { 'Accept-Language': 'zh-CN' } });
    const runtime = createRequestI18n('', request, []);
    expect(runtime.i18n.locale).toBe('zh-CN');
    expect(runtime.autoLocale).toBe(true);
    expect(runtime.resolvedLocale.bundleName).toMatch(/^zh-CN@catalog-/);
  });

  it('keeps fixed site language independent from the browser header', () => {
    const request = new Request('https://example.com/', { headers: { 'Accept-Language': 'en-US' } });
    const runtime = createRequestI18n('zh_CN', request, []);
    expect(runtime.i18n.locale).toBe('zh-CN');
    expect(runtime.autoLocale).toBe(false);
  });
});
