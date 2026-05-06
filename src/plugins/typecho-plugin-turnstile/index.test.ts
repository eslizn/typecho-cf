import { afterEach, describe, expect, it, vi } from 'vitest';
import init, { getClientSnippet } from './index';

function collectHooks() {
  const hooks = new Map<string, Function>();
  init({
    pluginId: 'typecho-plugin-turnstile',
    HookPoints: {} as any,
    addHook: (point: string, _pluginId: string, handler: Function) => {
      hooks.set(point, handler);
    },
  });
  return hooks;
}

function options(settings: Record<string, unknown>) {
  return {
    'plugin:typecho-plugin-turnstile': JSON.stringify(settings),
  };
}

describe('typecho-plugin-turnstile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not inject client snippets before site key is configured', () => {
    expect(getClientSnippet()).toEqual({ headHtml: '', bodyHtml: '' });
  });

  it('injects Turnstile script and widget mount when configured', () => {
    const snippet = getClientSnippet(options({
      sitekey: 'site-key',
      input: 'cf-token',
      appearance: 'interaction-only',
      theme: 'dark',
      size: 'compact',
    }));

    expect(snippet.headHtml).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js');
    expect(snippet.bodyHtml).toContain('cf-turnstile');
    expect(snippet.bodyHtml).toContain('site-key');
    expect(snippet.bodyHtml).toContain('interaction-only');
  });

  it('registers comment, login, and snippet hooks', () => {
    const hooks = collectHooks();

    expect([...hooks.keys()].sort()).toEqual([
      'admin:loginForm',
      'admin:loginHead',
      'archive:footer',
      'archive:header',
      'feedback:comment',
      'user:login',
    ]);
  });

  it('rejects login when Turnstile token is missing', async () => {
    const hooks = collectHooks();
    const login = hooks.get('user:login')!;

    const result = await login({}, {
      options: options({ sitekey: 'site-key', secret: 'secret' }),
      formData: new FormData(),
      request: new Request('https://example.com/admin/login'),
    });

    expect(result).toMatchObject({ _rejected: '请完成人机验证' });
  });

  it('skips comment verification for logged-in users', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const feedback = hooks.get('feedback:comment')!;
    const result = await feedback({}, {
      options: options({ sitekey: 'site-key', secret: 'secret' }),
      formData: new FormData(),
      request: new Request('https://example.com/post'),
      isLoggedIn: true,
    });

    expect(result).not.toHaveProperty('_rejected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes login when Turnstile verification succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true })));
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const login = hooks.get('user:login')!;
    const formData = new FormData();
    formData.set('cf-token', 'token');

    const result = await login({}, {
      options: options({ sitekey: 'site-key', secret: 'secret', input: 'cf-token' }),
      formData,
      request: new Request('https://example.com/admin/login', {
        headers: { 'cf-connecting-ip': '203.0.113.5' },
      }),
    });

    expect(result).not.toHaveProperty('_rejected');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('remoteip=203.0.113.5'),
      }),
    );
  });
});
