import { afterEach, describe, expect, it, vi } from 'vitest';
import init, { getClientSnippet } from './index';

function collectHooks() {
  const hooks = new Map<string, Function>();
  init({
    pluginId: 'typecho-plugin-captcha',
    HookPoints: {} as any,
    addHook: (point: string, _pluginId: string, handler: Function) => {
      hooks.set(point, handler);
    },
  });
  return hooks;
}

function options(settings: Record<string, unknown>) {
  return {
    'plugin:typecho-plugin-captcha': JSON.stringify(settings),
  };
}

describe('typecho-plugin-captcha', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not inject client snippets before site key is configured', () => {
    expect(getClientSnippet()).toEqual({ headHtml: '', bodyHtml: '' });
  });

  it('injects reCAPTCHA script and submit handler when configured', () => {
    const snippet = getClientSnippet(options({
      client: 'site-key',
      api: 'https://captcha.example',
      input: 'captcha-token',
      action: 'comment',
      hidden: 1,
    }));

    expect(snippet.headHtml).toContain('https://captcha.example/recaptcha/api.js?render=site-key');
    expect(snippet.headHtml).toContain('.grecaptcha-badge');
    expect(snippet.bodyHtml).toContain('captcha-token');
    expect(snippet.bodyHtml).toContain('comment');
  });

  it('registers comment and archive snippet hooks', () => {
    const hooks = collectHooks();

    expect([...hooks.keys()].sort()).toEqual([
      'archive:footer',
      'archive:header',
      'feedback:comment',
    ]);
  });

  it('rejects comments when captcha token is missing', async () => {
    const hooks = collectHooks();
    const feedback = hooks.get('feedback:comment')!;
    const commentData = {};

    const result = await feedback(commentData, {
      options: options({ client: 'site-key', server: 'secret' }),
      formData: new FormData(),
      request: new Request('https://example.com/post', {
        headers: { 'cf-connecting-ip': '203.0.113.1' },
      }),
    });

    expect(result).toMatchObject({ _rejected: '请完成验证码验证' });
  });

  it('passes comments when reCAPTCHA verification succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, score: 0.9 })));
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const feedback = hooks.get('feedback:comment')!;
    const formData = new FormData();
    formData.set('captcha-token', 'token');

    const result = await feedback({}, {
      options: options({
        client: 'site-key',
        server: 'secret',
        input: 'captcha-token',
        score: 0.5,
      }),
      formData,
      request: new Request('https://example.com/post', {
        headers: { 'x-forwarded-for': '203.0.113.2, 10.0.0.1' },
      }),
    });

    expect(result).not.toHaveProperty('_rejected');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.recaptcha.net/recaptcha/api/siteverify',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('remoteip=203.0.113.2'),
      }),
    );
  });

  it('rejects comments when reCAPTCHA returns success: false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false })));
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const feedback = hooks.get('feedback:comment')!;
    const formData = new FormData();
    formData.set('captcha-token', 'token');

    const result = await feedback({}, {
      options: options({ client: 'site-key', server: 'secret', input: 'captcha-token', score: 0.5 }),
      formData,
      request: new Request('https://example.com/post'),
    });

    expect(result).toMatchObject({ _rejected: '验证码验证失败' });
  });

  it('rejects comments when reCAPTCHA score is below threshold', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, score: 0.3 })));
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const feedback = hooks.get('feedback:comment')!;
    const formData = new FormData();
    formData.set('captcha-token', 'token');

    const result = await feedback({}, {
      options: options({ client: 'site-key', server: 'secret', input: 'captcha-token', score: 0.5 }),
      formData,
      request: new Request('https://example.com/post'),
    });

    expect(result).toMatchObject({ _rejected: '验证码验证失败' });
  });

  it('rejects comments with service error when verification API fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const feedback = hooks.get('feedback:comment')!;
    const formData = new FormData();
    formData.set('captcha-token', 'token');

    const result = await feedback({}, {
      options: options({ client: 'site-key', server: 'secret', input: 'captcha-token', score: 0.5 }),
      formData,
      request: new Request('https://example.com/post'),
    });

    expect(result).toMatchObject({ _rejected: '验证码服务异常，请稍后重试' });
  });

  it('skips verification when user is logged in', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const feedback = hooks.get('feedback:comment')!;
    const formData = new FormData();
    formData.set('captcha-token', 'token');

    const result = await feedback({}, {
      options: options({ client: 'site-key', server: 'secret' }),
      formData,
      request: new Request('https://example.com/post'),
      isLoggedIn: true,
    });

    expect(result).not.toHaveProperty('_rejected');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
