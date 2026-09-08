/**
 * Unit tests for getClientIp() in src/lib/context.ts
 *
 * Tests the correct extraction of client IP from Cloudflare Workers requests.
 */
import { describe, it, expect } from 'vitest';
import {
  createContext,
  createContextAlongside,
  getClientIp,
  setRequestCoreContext,
} from '@/lib/context';
import { createRequestI18n } from '@/lib/i18n-runtime';

function makeRequest(headers: Record<string, string>): Request {
  return new Request('https://example.com/', { headers });
}

describe('getClientIp()', () => {
  it('returns CF-Connecting-IP when present (single trusted value)', () => {
    const req = makeRequest({ 'cf-connecting-ip': '1.2.3.4' });
    expect(getClientIp(req)).toBe('1.2.3.4');
  });

  it('trims whitespace from CF-Connecting-IP', () => {
    const req = makeRequest({ 'cf-connecting-ip': '  1.2.3.4  ' });
    expect(getClientIp(req)).toBe('1.2.3.4');
  });

  it('prefers CF-Connecting-IP over X-Forwarded-For when both are present', () => {
    const req = makeRequest({
      'cf-connecting-ip': '1.2.3.4',
      'x-forwarded-for': '5.6.7.8, 9.10.11.12',
    });
    expect(getClientIp(req)).toBe('1.2.3.4');
  });

  it('extracts only the first IP from X-Forwarded-For when no CF-Connecting-IP', () => {
    const req = makeRequest({ 'x-forwarded-for': '10.0.0.1, 172.16.0.1, 192.168.1.1' });
    expect(getClientIp(req)).toBe('10.0.0.1');
  });

  it('trims whitespace from X-Forwarded-For first entry', () => {
    const req = makeRequest({ 'x-forwarded-for': '  10.0.0.1  , 172.16.0.1' });
    expect(getClientIp(req)).toBe('10.0.0.1');
  });

  it('handles single value in X-Forwarded-For', () => {
    const req = makeRequest({ 'x-forwarded-for': '203.0.113.5' });
    expect(getClientIp(req)).toBe('203.0.113.5');
  });

  it('returns empty string when no IP headers are present', () => {
    const req = makeRequest({});
    expect(getClientIp(req)).toBe('');
  });

  it('handles IPv6 addresses from CF-Connecting-IP', () => {
    const req = makeRequest({ 'cf-connecting-ip': '2001:db8::1' });
    expect(getClientIp(req)).toBe('2001:db8::1');
  });

  it('handles IPv6 addresses from X-Forwarded-For', () => {
    const req = makeRequest({ 'x-forwarded-for': '2001:db8::1, 10.0.0.1' });
    expect(getClientIp(req)).toBe('2001:db8::1');
  });
});

describe('request context reuse', () => {
  it('reuses middleware options, database and plugin activation', async () => {
    const locals = {} as App.Locals;
    const db = {} as any;
    const options = {
      siteUrl: 'https://example.com',
      secret: '',
      activatedPlugins: '[]',
    } as any;
    const pluginCtx = { activatedPlugins: new Set(['active-plugin']) };
    const request = makeRequest({});
    const runtime = createRequestI18n(options.lang, request, pluginCtx.activatedPlugins);
    setRequestCoreContext(locals, {
      db,
      options,
      pluginCtx,
      i18n: runtime.i18n,
      resolvedLocale: runtime.resolvedLocale,
      autoLocale: runtime.autoLocale,
    });
    const firstPromise = createContext(locals, request);
    const secondPromise = createContext(locals, request);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(firstPromise).toBe(secondPromise);
    expect(first).toBe(second);
    expect(first.db).toBe(db);
    expect(first.options).toBe(options);
    expect(first.activatedPlugins).toBe(pluginCtx.activatedPlugins);
  });

  it('starts a route read immediately from the middleware DB core', async () => {
    const locals = {} as App.Locals;
    const db = { marker: 'shared-db' } as any;
    const options = { siteUrl: 'https://example.com', secret: '', activatedPlugins: '[]' } as any;
    const request = makeRequest({});
    const runtime = createRequestI18n(options.lang, request, []);
    setRequestCoreContext(locals, {
      db,
      options,
      pluginCtx: { activatedPlugins: new Set<string>() },
      i18n: runtime.i18n,
      resolvedLocale: runtime.resolvedLocale,
      autoLocale: runtime.autoLocale,
    });

    let started = false;
    const pending = createContextAlongside(locals, request, async receivedDb => {
      started = true;
      expect(receivedDb).toBe(db);
      return 'loaded';
    });

    expect(started).toBe(true);
    const [ctx, value] = await pending;
    expect(ctx.db).toBe(db);
    expect(value).toBe('loaded');
  });
});
