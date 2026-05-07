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
    expect(snippet.headHtml).not.toContain('render=explicit');
    expect(snippet.headHtml).toContain('__typechoTurnstileSubmit');
    expect(snippet.headHtml).toContain('__typechoTurnstileSetStatus');
    expect(snippet.headHtml).toContain('.typecho-turnstile-status:empty');
    expect(snippet.headHtml).toContain('message ');
    expect(snippet.bodyHtml).toContain('cf-turnstile typecho-turnstile-widget');
    expect(snippet.bodyHtml).toContain('typecho-turnstile-status');
    expect(snippet.bodyHtml).toContain('site-key');
    expect(snippet.bodyHtml).toContain('interaction-only');
    expect(snippet.bodyHtml).toContain('data-response-field="true"');
    expect(snippet.bodyHtml).toContain('data-response-field-name="cf-token"');
    expect(snippet.bodyHtml).toContain('cf-token');
  });

  it('executes interaction-only widgets on submit so login cannot post without a token', () => {
    const snippet = getClientSnippet(options({
      sitekey: 'site-key',
      appearance: 'interaction-only',
    }));

    expect(snippet.bodyHtml).toContain('data-appearance="interaction-only"');
    expect(snippet.bodyHtml).toContain('data-execution="execute"');
    expect(snippet.bodyHtml).toContain('data-callback="__typechoTurnstileSubmit"');
    expect(snippet.bodyHtml).toContain('data-error-callback="__typechoTurnstileResetPending"');
    expect(snippet.bodyHtml).toContain('form.addEventListener("submit"');
    expect(snippet.bodyHtml).toContain('正在加载人机验证，请稍候...');
    expect(snippet.bodyHtml).toContain('请完成人机验证');
    expect(snippet.bodyHtml).toContain('人机验证加载超时，请检查网络后重试');
    expect(snippet.bodyHtml).toContain('turnstile.execute("#" + containerId)');
    expect(snippet.bodyHtml).not.toContain('turnstile.reset');
  });

  it('uses managed rendering and only intercepts submit for execution mode', () => {
    const snippet = getClientSnippet(options({
      sitekey: 'site-key',
      appearance: 'execute',
    }));

    expect(snippet.bodyHtml).toContain('data-appearance="execute"');
    expect(snippet.bodyHtml).toContain('data-execution="execute"');
    expect(snippet.bodyHtml).toContain('data-timeout-callback="__typechoTurnstileResetPending"');
    expect(snippet.bodyHtml).toContain('form.addEventListener("submit"');
    expect(snippet.bodyHtml).toContain('turnstile.execute("#" + containerId)');
    expect(snippet.bodyHtml).toContain('typecho-turnstile-comment-form');
    expect(snippet.bodyHtml).toContain('timer: setTimeout(resetPending, 15000)');
    expect(snippet.bodyHtml).not.toContain('container.hidden = true');
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
