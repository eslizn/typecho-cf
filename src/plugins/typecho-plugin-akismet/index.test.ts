import { afterEach, describe, expect, it, vi } from 'vitest';
import init from './index';

function collectHooks() {
  const hooks = new Map<string, Function>();
  init({
    pluginId: 'typecho-plugin-akismet',
    HookPoints: {} as any,
    addHook: (point: string, _pluginId: string, handler: Function) => {
      hooks.set(point, handler);
    },
  });
  return hooks;
}

function options(settings: Record<string, unknown>) {
  return {
    'plugin:typecho-plugin-akismet': JSON.stringify(settings),
    siteUrl: 'https://blog.example.com',
  };
}

describe('typecho-plugin-akismet', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers comment check, action, and config validation hooks', () => {
    const hooks = collectHooks();

    expect([...hooks.keys()].sort()).toEqual([
      'comment:action',
      'feedback:comment',
      'plugin:config:beforeSave',
    ]);
  });

  it('skips comment check when API key is not configured', async () => {
    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    const result = await handler({}, {
      options: options({}),
      formData: new FormData(),
      request: new Request('https://blog.example.com/post'),
    });

    expect(result).not.toHaveProperty('_rejected');
    expect(result).not.toHaveProperty('status');
  });

  it('skips logged-in users when checkLoggedIn is disabled', async () => {
    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await handler({}, {
      options: options({ apiKey: 'ak-key', checkLoggedIn: false }),
      formData: new FormData(),
      request: new Request('https://blog.example.com/post'),
      isLoggedIn: true,
    });

    expect(result).not.toHaveProperty('_rejected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks logged-in users when checkLoggedIn is enabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('false'));
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    await handler({ author: 'Test', text: 'Hello' }, {
      options: options({ apiKey: 'ak-key', checkLoggedIn: true }),
      formData: new FormData(),
      request: new Request('https://blog.example.com/post'),
      isLoggedIn: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('.rest.akismet.com/1.1/comment-check'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('marks comment as spam when akismet returns true in spam mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('true'));
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    const result = await handler({ author: 'Spammer', text: 'Buy now!' }, {
      options: options({ apiKey: 'ak-key', mode: 'spam' }),
      formData: new FormData(),
      request: new Request('https://blog.example.com/post', {
        headers: { referer: 'https://blog.example.com/post' },
      }),
    });

    expect(result).toMatchObject({ status: 'spam' });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('ak-key.rest.akismet.com/1.1/comment-check'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejects comment when akismet returns true in reject mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('true'));
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    const result = await handler({ author: 'Spammer', text: 'Buy now!' }, {
      options: options({ apiKey: 'ak-key', mode: 'reject' }),
      formData: new FormData(),
      request: new Request('https://blog.example.com/post'),
    });

    expect(result).toMatchObject({ _rejected: '您的评论已被识别为垃圾评论' });
  });

  it('allows comment through when akismet returns false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('false'));
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    const result = await handler({ author: 'Legit', text: 'Nice post!' }, {
      options: options({ apiKey: 'ak-key' }),
      formData: new FormData(),
      request: new Request('https://blog.example.com/post'),
    });

    expect(result).not.toHaveProperty('_rejected');
    expect(result).not.toHaveProperty('status');
  });

  it('allows comment through when akismet API call fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    const result = await handler({ author: 'User', text: 'Comment' }, {
      options: options({ apiKey: 'ak-key' }),
      formData: new FormData(),
      request: new Request('https://blog.example.com/post'),
    });

    expect(result).not.toHaveProperty('_rejected');
  });

  it('submits spam on comment:action when status changes to spam', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Thanks for making the web a better place.'));
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const handler = hooks.get('comment:action')!;

    handler(
      { coid: 1, cid: 1, author: 'Spammer', mail: 's@spam.com', url: '', ip: '1.2.3.4', agent: 'Chrome', text: 'Buy!', type: 'comment' },
      { action: 'spam', oldStatus: 'approved', newStatus: 'spam', options: options({ apiKey: 'ak-key' }) },
    );

    // Fire-and-forget: we can't await, but verify fetch was called
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('.rest.akismet.com/1.1/submit-spam'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('submits ham on comment:action when status changes from spam to approved', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Thanks for making the web a better place.'));
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const handler = hooks.get('comment:action')!;

    handler(
      { coid: 1, cid: 1, author: 'User', mail: 'u@test.com', url: '', ip: '1.2.3.4', agent: 'Chrome', text: 'Comment', type: 'comment' },
      { action: 'approved', oldStatus: 'spam', newStatus: 'approved', options: options({ apiKey: 'ak-key' }) },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('.rest.akismet.com/1.1/submit-ham'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('skips comment:action when no API key is configured', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const handler = hooks.get('comment:action')!;

    handler(
      { coid: 1, cid: 1 },
      { action: 'spam', oldStatus: 'approved', newStatus: 'spam', options: options({}) },
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates API key successfully before saving config', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('valid'));
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')!;

    const result = await validate({ success: true, settings: {} }, {
      pluginId: 'typecho-plugin-akismet',
      settings: { apiKey: 'ak-key', siteUrl: 'https://blog.example.com' },
      options: { siteUrl: 'https://blog.example.com' },
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://rest.akismet.com/1.1/verify-key',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejects config save when API key verification fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('invalid'));
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')!;

    const result = await validate({ success: true, settings: {} }, {
      pluginId: 'typecho-plugin-akismet',
      settings: { apiKey: 'bad-key', siteUrl: 'https://blog.example.com' },
      options: { siteUrl: 'https://blog.example.com' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('验证失败');
  });

  it('ignores config validation for other plugins', async () => {
    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')!;

    const original = { success: true, settings: {} };
    const result = await validate(original, {
      pluginId: 'typecho-plugin-other',
      settings: {},
    });

    expect(result).toBe(original);
  });

  it('includes test flag in akismet body when isTest is enabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('false'));
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    await handler({ author: 'Test', text: 'Testing' }, {
      options: options({ apiKey: 'ak-key', isTest: true }),
      formData: new FormData(),
      request: new Request('https://blog.example.com/post'),
    });

    const [, call] = (fetchMock as any).mock.calls[0];
    expect(call.body).toContain('is_test=true');
  });

  it('falls back to options.siteUrl when plugin siteUrl is empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('false'));
    vi.stubGlobal('fetch', fetchMock);

    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    await handler({ author: 'User', text: 'Hi' }, {
      options: { ...options({ apiKey: 'ak-key' }), siteUrl: 'https://myblog.example.com' },
      formData: new FormData(),
      request: new Request('https://myblog.example.com/post'),
    });

    const [, call] = (fetchMock as any).mock.calls[0];
    expect(call.body).toContain('blog=https%3A%2F%2Fmyblog.example.com');
  });
});
