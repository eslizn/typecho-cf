import { afterEach, describe, expect, it, vi } from 'vitest';
import init from './index';

const HONEYPOT_FIELD = 'address_confirm';
const TOKEN_FIELD = 'antispam_token';

function collectHooks() {
  const hooks = new Map<string, Function>();
  init({
    pluginId: 'typecho-plugin-antispam',
    HookPoints: {} as any,
    addHook: (point: string, _pluginId: string, handler: Function) => {
      hooks.set(point, handler);
    },
  });
  return hooks;
}

function options(settings: Record<string, unknown>) {
  return {
    'plugin:typecho-plugin-antispam': JSON.stringify(settings),
    secret: 'test-site-secret-key',
  };
}

async function generateValidToken(secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(String(now)));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${now.toString(16)}:${hex}`;
}

describe('typecho-plugin-antispam', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers comment check and archive footer hooks', () => {
    const hooks = collectHooks();

    expect([...hooks.keys()].sort()).toEqual([
      'archive:footer',
      'feedback:comment',
    ]);
  });

  // ── Honeypot ──

  it('rejects comment when honeypot field is filled (discard mode)', async () => {
    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    const formData = new FormData();
    formData.set('address_confirm', 'I am a bot');

    const result = await handler({}, {
      options: options({ mode: 'discard' }),
      formData,
      request: new Request('https://blog.example.com/post'),
    });

    expect(result).toMatchObject({ _rejected: '检测到垃圾评论特征' });
  });

  it('marks comment as spam when honeypot is filled in spam mode', async () => {
    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    const formData = new FormData();
    formData.set('address_confirm', 'bot data');

    const result = await handler({}, {
      options: options({ mode: 'spam' }),
      formData,
      request: new Request('https://blog.example.com/post'),
    });

    expect(result).toMatchObject({ status: 'spam' });
  });

  it('marks comment as waiting when honeypot is filled in waiting mode', async () => {
    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    const formData = new FormData();
    formData.set('address_confirm', 'bot data');

    const result = await handler({}, {
      options: options({ mode: 'waiting' }),
      formData,
      request: new Request('https://blog.example.com/post'),
    });

    expect(result).toMatchObject({ status: 'waiting' });
  });

  it('passes comment when honeypot field is empty', async () => {
    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    const result = await handler({}, {
      options: options({ honeypot: true, timeCheck: false, linkCheck: false }),
      formData: new FormData(),
      request: new Request('https://blog.example.com/post'),
    });

    expect(result).not.toHaveProperty('_rejected');
    expect(result).not.toHaveProperty('status');
  });

  // ── Time check ──

  it('rejects when time token is missing', async () => {
    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    const result = await handler({}, {
      options: options({ timeCheck: true, honeypot: false, linkCheck: false, mode: 'discard' }),
      formData: new FormData(),
      request: new Request('https://blog.example.com/post'),
    });

    expect(result).toMatchObject({ _rejected: '安全令牌缺失' });
  });

  it('rejects when time token is invalid', async () => {
    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    const formData = new FormData();
    formData.set('antispam_token', 'bad:token');

    const result = await handler({}, {
      options: options({ timeCheck: true, honeypot: false, linkCheck: false, mode: 'discard' }),
      formData,
      request: new Request('https://blog.example.com/post'),
    });

    expect(result._rejected).toBeTruthy();
  });

  it('passes when time token is valid', async () => {
    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    const token = await generateValidToken('test-site-secret-key');
    const formData = new FormData();
    formData.set('antispam_token', token);

    // minTime: 0 avoids the "submitted too fast" guard
    const result = await handler({}, {
      options: options({ timeCheck: true, honeypot: false, linkCheck: false, minTime: 0 }),
      formData,
      request: new Request('https://blog.example.com/post'),
    });

    expect(result).not.toHaveProperty('_rejected');
    expect(result).not.toHaveProperty('status');
  });

  it('rejects when time token is too old (outside maxTime window)', async () => {
    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    // Create a token with epoch 0 timestamp
    const past = 0;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode('test-site-secret-key'),
      { name: 'HMAC', hash: 'SHA-256' },
      false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(String(past)));
    const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    const token = `${past.toString(16)}:${hex}`;

    const formData = new FormData();
    formData.set('antispam_token', token);

    // discard mode so we can assert _rejected
    const result = await handler({}, {
      options: options({ timeCheck: true, honeypot: false, linkCheck: false, maxTime: 60, mode: 'discard' }),
      formData,
      request: new Request('https://blog.example.com/post'),
    });

    expect(result._rejected).toContain('页面已过期');
  });

  // ── Link check ──

  it('passes comment with links within limit', async () => {
    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    const result = await handler({ text: 'Check https://example.com and https://test.com' }, {
      options: options({ honeypot: false, timeCheck: false, linkCheck: true, maxLinks: 2 }),
      formData: new FormData(),
      request: new Request('https://blog.example.com/post'),
    });

    expect(result).not.toHaveProperty('_rejected');
  });

  it('rejects comment with too many links', async () => {
    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    const result = await handler({
      text: 'https://a.com https://b.com https://c.com',
    }, {
      options: options({ honeypot: false, timeCheck: false, linkCheck: true, maxLinks: 2, mode: 'discard' }),
      formData: new FormData(),
      request: new Request('https://blog.example.com/post'),
    });

    expect(result._rejected).toContain('链接数量');
  });

  it('rejects any link when maxLinks is 0', async () => {
    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    const result = await handler({ text: 'See https://example.com' }, {
      options: options({ honeypot: false, timeCheck: false, linkCheck: true, maxLinks: 0, mode: 'discard' }),
      formData: new FormData(),
      request: new Request('https://blog.example.com/post'),
    });

    expect(result._rejected).toBe('评论中不允许包含链接');
  });

  // ── General ──

  it('skips all checks for logged-in users', async () => {
    const hooks = collectHooks();
    const handler = hooks.get('feedback:comment')!;

    const formData = new FormData();
    formData.set('address_confirm', 'bot'); // honeypot filled

    const result = await handler({}, {
      options: options({ mode: 'discard' }),
      formData,
      request: new Request('https://blog.example.com/post'),
      isLoggedIn: true,
    });

    expect(result).not.toHaveProperty('_rejected');
    expect(result).not.toHaveProperty('status');
  });

  // ── archive:footer pageContext guard ──

  it('injects antispam fields when page has comments', async () => {
    const hooks = collectHooks();
    const handler = hooks.get('archive:footer')!;

    const result = await handler('', {
      options: { ...options({ honeypot: true, timeCheck: true }), secret: 'test-secret' },
      pageContext: { hasComments: true },
    });

    expect(result).toContain(HONEYPOT_FIELD);
    expect(result).toContain(TOKEN_FIELD);
  });

  it('skips injection when page lacks comment form', async () => {
    const hooks = collectHooks();
    const handler = hooks.get('archive:footer')!;

    const result = await handler('', {
      options: options({}),
      pageContext: { hasComments: false },
    });

    expect(result).toBe('');
  });
});
