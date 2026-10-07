import { describe, expect, it, vi } from 'vitest';
import {
  finalizeRequestResponse,
  mergeVary,
  resolveRequestTarget,
} from '@/lib/request-bootstrap';
import { addHook, removePluginHooks, type HookContext } from '@/lib/plugin';

describe('resolveRequestTarget()', () => {
  it('resolves pagination while preserving the original URL and query', () => {
    const locals = {} as App.Locals;
    const target = resolveRequestTarget(
      new Request('https://example.com/category/news/page/23/?sort=date'),
      locals,
    );
    expect(target.originalPath).toBe('/category/news/page/23/');
    expect(target.effectivePath).toBe('/category/news/');
    expect(target.routeTarget).toBe('/category/news/?sort=date');
    expect((locals as any)._page).toBe(23);
  });

  it('normalizes hostile page segments before a route can query with them', () => {
    const locals = {} as App.Locals;
    const target = resolveRequestTarget(new Request('https://example.com/page/Infinity/'), locals);
    expect(target.routeTarget).toBe('/');
    expect((locals as any)._page).toBe(1);

    resolveRequestTarget(new Request('https://example.com/page/999999999999/'), locals);
    expect((locals as any)._page).toBe(10_000);
  });
});

describe('finalizeRequestResponse()', () => {
  it('applies common headers and tracks a public cache write', async () => {
    const waitUntil = vi.fn();
    const put = vi.spyOn(caches.default, 'put');
    const request = new Request('https://example.com/page/2/');
    const cacheKey = new Request('https://example.com/page/2/?v=1');
    const response = await finalizeRequestResponse(new Response('ok'),
      { request, cacheKey, executionContext: { waitUntil } });

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(put).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(put.mock.results[0].value);
    const cached = put.mock.calls[0][1];
    expect(cached.headers.get('set-cookie')).toBeNull();
    expect(cached.headers.get('vary')).toContain('Cookie');
    put.mockRestore();
  });

  it('returns the rendered response when the cache backend rejects a write', async () => {
    const put = vi.spyOn(caches.default, 'put').mockRejectedValueOnce(new Error('cache unavailable'));
    try {
      const response = await finalizeRequestResponse(new Response('rendered'), {
        request: new Request('https://example.com/'),
        cacheKey: new Request('https://example.com/'),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('rendered');
    } finally {
      put.mockRestore();
    }
  });

  it.each<Record<string, string>>([
    { 'Set-Cookie': 'visitor=one' },
    { 'Cache-Control': 'private, max-age=60' },
    { 'Cache-Control': 'public, no-store' },
    { 'Cache-Control': 'no-cache' },
    { Vary: '*' },
  ])('does not share a visitor-specific or uncacheable response: %j', async (headers) => {
    const put = vi.spyOn(caches.default, 'put');
    const request = new Request('https://example.com/');
    const response = await finalizeRequestResponse(new Response('visitor-specific HTML', { headers }), {
      request,
      cacheKey: request,
    });
    expect(await response.text()).toBe('visitor-specific HTML');
    expect(response.headers.get('set-cookie')).toBe(headers['Set-Cookie'] ?? null);
    expect(put).not.toHaveBeenCalled();
    put.mockRestore();
  });

  it('adds Accept-Language to cached variants in automatic mode', async () => {
    const put = vi.spyOn(caches.default, 'put');
    const request = new Request('https://example.com/');
    await finalizeRequestResponse(new Response('ok'), {
      request,
      cacheKey: new Request('https://example.com/?__typecho_i18n=en@catalog-test'),
      autoLocale: true,
    });

    expect(put.mock.calls[0]?.[1].headers.get('vary')).toContain('Accept-Language');
    put.mockRestore();
  });

  it('adds Accept-Language to automatic responses that are not cached', async () => {
    const response = await finalizeRequestResponse(new Response('not found', { status: 404 }), {
      request: new Request('https://example.com/missing'),
      autoLocale: true,
    });

    expect(response.headers.get('vary')).toContain('Accept-Language');
  });

  it('fires request:end once when middleware finalizes the same request repeatedly', async () => {
    const pluginId = 'request-end-test';
    const pluginCtx: HookContext = { activatedPlugins: new Set([pluginId]) };
    const handler = vi.fn();
    addHook('request:end', pluginId, handler);
    const request = new Request('https://example.com/');

    await finalizeRequestResponse(new Response('first'), { request, pluginCtx });
    await finalizeRequestResponse(new Response('second'), { request, pluginCtx });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].response).toBeInstanceOf(Response);
    removePluginHooks(pluginId);
  });
});

describe('mergeVary()', () => {
  it('preserves and deduplicates tokens', () => {
    expect(mergeVary('Accept, Cookie', ['Cookie', 'Accept-Encoding']))
      .toBe('Accept, Cookie, Accept-Encoding');
  });
});
