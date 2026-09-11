import { describe, expect, it, vi } from 'vitest';
import { createCapabilityRuntimeContext } from '@/lib/capability';
import init, {
  AI_CAPABILITIES,
  AI_CONFIG_FIELDS,
  createAiChatService,
  handleAiHttpRequest,
  isValidHttpBasePath,
  normalizeBaseUrl,
  parseChatRequest,
  selectAiModel,
  validateAiConfig,
  type AiChatResponse,
  type AiChatResult,
  type AiConfig,
} from './index';
import type { I18n, PluginInitContext } from 'typecho/plugin-sdk';

const BASE_URL = 'https://provider.example.com/v1';

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    providers: [{
      name: 'example',
      baseUrl: BASE_URL,
      apiKey: 'upstream-secret',
      models: [{
        model: 'gpt-upstream',
        alias: 'chat',
        enabled: true,
        capabilities: [AI_CAPABILITIES.chatGenerate],
        modalities: ['text', 'image', 'audio_input', 'audio_output'],
      }],
    }],
    http: { enabled: false, basePath: '/ai', tokens: [] },
    ...overrides,
  };
}

function initContext(overrides: Partial<PluginInitContext> = {}): {
  context: PluginInitContext;
  hooks: Map<string, Function>;
  translations: Map<string, Record<string, string>>;
} {
  const hooks = new Map<string, Function>();
  const translations = new Map<string, Record<string, string>>();
  const context: PluginInitContext = {
    pluginId: 'typecho-plugin-ai',
    HookPoints: {} as any,
    addHook: (point, _pluginId, handler) => hooks.set(point, handler),
    registerCapability: () => {},
    registerRouteResolver: () => {},
    registerAdminPath: () => {},
    registerTranslations: (locale, messages) => { translations.set(locale, messages); },
    registerScheduledTask: () => {},
    registerAsyncTask: () => {},
    enqueueAsyncTask: async () => ({ jobId: 'job', taskKey: 'task', idempotencyKey: 'key' }),
    ...overrides,
  };
  return { context, hooks, translations };
}

function runtime() {
  return createCapabilityRuntimeContext({
    request: new Request('https://example.com/'),
    db: {} as any,
    env: {},
    options: {},
    activatedPlugins: new Set(['typecho-plugin-ai']),
    activationGeneration: 1,
  });
}

function upstreamJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readStream<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const values: T[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) return values;
    values.push(next.value);
  }
}

describe('typecho-plugin-ai', () => {
  it('exposes the agreed configuration schema with nested provider models', () => {
    expect(AI_CONFIG_FIELDS.providers.type).toBe('repeatable');
    expect(AI_CONFIG_FIELDS.providers.itemFields?.models.type).toBe('repeatable');
    expect(AI_CONFIG_FIELDS.providers.itemFields?.models.itemFields?.capabilities.type).toBe('checkbox');
    expect(AI_CONFIG_FIELDS.http.type).toBe('object');
    // Availability is controlled per model; providers have no enable switch.
    expect(AI_CONFIG_FIELDS.providers.itemFields?.enabled).toBeUndefined();
    expect(AI_CONFIG_FIELDS.providers.statusField).toBeUndefined();
    expect(AI_CONFIG_FIELDS.providers.itemFields?.models.itemFields?.enabled.type).toBe('select');
  });

  it('disables the reserved capability options instead of labeling them', () => {
    const capabilities = AI_CONFIG_FIELDS.providers.itemFields?.models.itemFields?.capabilities;
    expect(capabilities?.optionDisabled).toEqual([
      'ai.image.generate',
      'ai.audio.speech.generate',
      'ai.audio.transcribe',
      'ai.embeddings.create',
    ]);
    for (const label of Object.values(capabilities?.options ?? {})) {
      expect(String(label).toLowerCase()).not.toContain('reserved');
    }
  });

  it('rejects non-public provider URLs and reserved HTTP paths', () => {
    expect(normalizeBaseUrl('http://provider.example.com/v1')).toBeNull();
    expect(normalizeBaseUrl('https://localhost/v1')).toBeNull();
    expect(normalizeBaseUrl('https://127.0.0.1/v1')).toBeNull();
    expect(normalizeBaseUrl('https://provider.example.com/v1?key=secret')).toBeNull();
    expect(isValidHttpBasePath('/ai')).toBe(true);
    expect(isValidHttpBasePath('/custom/ai')).toBe(true);
    expect(isValidHttpBasePath('/api/ai')).toBe(false);
    expect(isValidHttpBasePath('/sitemap.xml')).toBe(false);
    expect(isValidHttpBasePath('/custom/../ai')).toBe(false);
  });

  it('selects a logical alias and never accepts an upstream name after aliasing', () => {
    const alias = selectAiModel(config(), { model: 'chat', messages: [] });
    expect(alias.candidate?.logicalModel).toBe('chat');

    const upstreamName = selectAiModel(config(), { model: 'gpt-upstream', messages: [] });
    expect(upstreamName).toEqual({ reason: 'model-not-found' });
  });

  it('validates enabled upstream models through /models and falls back to one model endpoint', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/models')) return new Response(null, { status: 404 });
      return upstreamJson({ id: 'gpt-upstream' });
    }) as unknown as typeof fetch;

    await validateAiConfig(config(), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String((fetcher as any).mock.calls[0][0])).toBe(`${BASE_URL}/models`);
    expect(String((fetcher as any).mock.calls[1][0])).toBe(`${BASE_URL}/models/gpt-upstream`);
  });

  it('fails closed when a fallback model endpoint does not identify the requested model', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) return new Response(null, { status: 404 });
      return upstreamJson({});
    }) as unknown as typeof fetch;

    await expect(validateAiConfig(config(), fetcher)).rejects.toThrow('did not confirm model gpt-upstream');
  });

  it('bounds a provider response body by the total validation budget', async () => {
    let sent = false;
    const fetcher = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: new Headers(),
      body: {
        getReader() {
          return {
            read: () => {
              if (!sent) {
                sent = true;
                return Promise.resolve({ done: false, value: new TextEncoder().encode('{') });
              }
              return new Promise<never>(() => {});
            },
            cancel: async () => {},
            releaseLock: () => {},
          };
        },
      },
    } as unknown as Response)) as unknown as typeof fetch;
    await expect(validateAiConfig(config(), fetcher, {
      concurrency: 1,
      requestTimeoutMs: 20,
      totalBudgetMs: 50,
      responseBodyBytes: 1024,
    })).rejects.toThrow('timed out');
  });

  it('forwards one selected upstream request with tools and binary image input', async () => {
    let sentBody: Record<string, any> | undefined;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return upstreamJson({
        id: 'chat-1',
        model: 'gpt-upstream',
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
          },
        }],
      });
    }) as unknown as typeof fetch;

    const service = createAiChatService(runtime(), config(), { fetcher });
    const result = await service.generate({
      model: 'chat',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Find this.' },
          { type: 'image_url', image_url: { url: new Uint8Array([1, 2]), detail: 'low', mimeType: 'image/png' } },
        ],
      }],
      tools: [{
        type: 'function',
        function: { name: 'lookup', description: 'Look up a value', parameters: { type: 'object' } },
      }],
      tool_choice: 'auto',
    });

    expect(sentBody?.model).toBe('gpt-upstream');
    expect(sentBody?.tools).toHaveLength(1);
    expect(sentBody?.messages[0].content[1].image_url.url).toBe('data:image/png;base64,AQI=');
    expect((result as AiChatResponse).model).toBe('chat');
    expect((result as AiChatResponse).choices[0].message.tool_calls?.[0].function.name).toBe('lookup');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('supports audio output and keeps upstream errors single-attempt', async () => {
    const fetcher = vi.fn(async () => upstreamJson({
      id: 'audio-1',
      choices: [{
        message: {
          role: 'assistant',
          content: 'spoken',
          audio: { data: 'AQI=', format: 'wav', transcript: 'spoken' },
        },
        finish_reason: 'stop',
      }],
    })) as unknown as typeof fetch;
    const service = createAiChatService(runtime(), config(), { fetcher });
    const result = await service.generate({
      model: 'chat',
      messages: [{ role: 'user', content: 'Say it.' }],
      modalities: ['text', 'audio'],
      audio: { voice: 'alloy', format: 'wav' },
    });
    expect((result as AiChatResponse).choices[0].message.audio?.data).toEqual(new Uint8Array([1, 2]));

    const failingFetcher = vi.fn(async () => upstreamJson({}, 503)) as unknown as typeof fetch;
    const failingService = createAiChatService(runtime(), config(), { fetcher: failingFetcher });
    await expect(failingService.generate({ model: 'chat', messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toMatchObject({ code: 'upstream-server-error' });
    expect(failingFetcher).toHaveBeenCalledTimes(1);
  });

  it('aborts a hanging upstream fetch within the single request deadline', async () => {
    let aborted = false;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
      return await new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const service = createAiChatService(runtime(), config(), {
      fetcher,
      limits: {
        timeoutMs: 20,
        requestBodyBytes: 1024,
        responseBodyBytes: 1024,
        maxMessages: 10,
        maxTools: 4,
        maxToolSchemaBytes: 1024,
        maxTextBytes: 1024,
        maxMediaBytes: 1024,
      },
    });

    await expect(service.generate({ model: 'chat', messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toMatchObject({ code: 'upstream-timeout' });
    expect(aborted).toBe(true);
  });

  it('normalizes streaming tool-call fragments through the same capability', async () => {
    const encoder = new TextEncoder();
    const events = [
      { choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'lookup', arguments: '{"q":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: 'tool_calls' }] },
    ].map(item => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n';
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(events));
        controller.close();
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as unknown as typeof fetch;

    const service = createAiChatService(runtime(), config(), { fetcher });
    const result = await service.generate({ model: 'chat', messages: [{ role: 'user', content: 'x' }], stream: true });
    const chunks = await readStream(result as ReadableStream<any>);
    expect(chunks[1].choices[0].delta.tool_calls?.[0].function.name).toBe('lookup');
    expect(chunks[2].choices[0].delta.tool_calls?.[0].function.arguments).toBe('"x"}');
  });

  it('converts deprecated HTTP functions to modern tools and requires Bearer auth', async () => {
    const parsed = parseChatRequest({
      messages: [{ role: 'user', content: 'x' }],
      functions: [{ name: 'lookup', parameters: { type: 'object' } }],
      function_call: { name: 'lookup' },
    });
    expect(parsed.functions).toBeUndefined();
    expect(parsed.tools?.[0].function.name).toBe('lookup');
    expect(parsed.tool_choice).toEqual({ type: 'function', function: { name: 'lookup' } });

    const service = {
      generate: vi.fn(async (): Promise<AiChatResult> => ({
        id: 'public-1', object: 'chat.completion', created: 1, model: 'chat',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      })),
    };
    const httpConfig = config({ http: { enabled: true, basePath: '/ai', tokens: [{ id: 't1', token: 'access-secret-token-1234' }] } });
    const unauthenticated = await handleAiHttpRequest({
      request: new Request('https://example.com/ai/v1/models'),
      path: '/ai/v1/models', config: httpConfig, service,
    });
    expect(unauthenticated?.status).toBe(401);

    const models = await handleAiHttpRequest({
      request: new Request('https://example.com/ai/v1/models', { headers: { authorization: 'Bearer access-secret-token-1234' } }),
      path: '/ai/v1/models', config: httpConfig, service,
    });
    expect(models?.status).toBe(200);
    expect((await models?.json() as any).data[0].id).toBe('chat');

    const completion = await handleAiHttpRequest({
      request: new Request('https://example.com/ai/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer access-secret-token-1234', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'chat', messages: [{ role: 'user', content: 'x' }] }),
      }),
      path: '/ai/v1/chat/completions', config: httpConfig, service,
    });
    expect(completion?.status).toBe(200);
    expect(service.generate).toHaveBeenCalledOnce();
  });

  it('returns standard SSE and base64 encodes internal audio bytes', async () => {
    const service = {
      generate: vi.fn(async (request: any): Promise<AiChatResult> => request.stream
        ? new ReadableStream({
          start(controller) {
            controller.enqueue({
              id: 'stream-1', object: 'chat.completion.chunk', created: 1, model: 'chat',
              choices: [{ index: 0, delta: { audio: { data: new Uint8Array([1, 2]), format: 'wav' } }, finish_reason: null }],
            });
            controller.close();
          },
        })
        : ({
          id: 'normal-1', object: 'chat.completion', created: 1, model: 'chat',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: null, audio: { data: new Uint8Array([1, 2]), format: 'wav' } } }],
        })),
    };
    const httpConfig = config({ http: { enabled: true, basePath: '/ai', tokens: [{ id: 't1', token: 'access-secret-token-1234' }] } });
    const normal = await handleAiHttpRequest({
      request: new Request('https://example.com/ai/v1/chat/completions', {
        method: 'POST', headers: { authorization: 'Bearer access-secret-token-1234', 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
      }),
      path: '/ai/v1/chat/completions', config: httpConfig, service,
    });
    expect((await normal?.json() as any).choices[0].message.audio.data).toBe('AQI=');

    const stream = await handleAiHttpRequest({
      request: new Request('https://example.com/ai/v1/chat/completions', {
        method: 'POST', headers: { authorization: 'Bearer access-secret-token-1234', 'content-type': 'application/json' },
        body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'x' }] }),
      }),
      path: '/ai/v1/chat/completions', config: httpConfig, service,
    });
    const text = await stream?.text();
    expect(text).toContain('AQI=');
    expect(text).toContain('data: [DONE]');
  });

  it('rate-limits invalid bearer tokens without querying D1 and still accepts a valid token', async () => {
    const httpConfig = config({ http: { enabled: true, basePath: '/ai', tokens: [{ id: 't1', token: 'access-secret-token-1234' }] } });
    const request = (authorization: string) => new Request('https://example.com/ai/v1/models', {
      headers: { authorization, 'cf-connecting-ip': '203.0.113.10' },
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await handleAiHttpRequest({
        request: request('Bearer wrong-token'),
        path: '/ai/v1/models', config: httpConfig,
        service: { generate: vi.fn() },
      });
      expect(response?.status).toBe(401);
    }
    const limited = await handleAiHttpRequest({
      request: request('Bearer wrong-token'),
      path: '/ai/v1/models', config: httpConfig,
      service: { generate: vi.fn() },
    });
    expect(limited?.status).toBe(429);

    const valid = await handleAiHttpRequest({
      request: request('Bearer access-secret-token-1234'),
      path: '/ai/v1/models', config: httpConfig,
      service: { generate: vi.fn() },
    });
    expect(valid?.status).toBe(200);
  });

  it('registers the chat capability and exposes both locale catalogs', async () => {
    const { context, hooks, translations } = initContext();
    const capabilitySpy = vi.fn();
    context.registerCapability = capabilitySpy;
    let routeResolver: ((context: { config: Readonly<Record<string, unknown>> }) => ReadonlyArray<{ path: string; match?: 'exact' | 'prefix' }>) | undefined;
    context.registerRouteResolver = resolver => { routeResolver = resolver; };

    init(context);

    expect(capabilitySpy).toHaveBeenCalledWith(expect.objectContaining({ capability: AI_CAPABILITIES.chatGenerate, version: 1 }));
    expect([...translations.keys()]).toEqual(['en', 'zh-CN']);
    expect(Object.keys(translations.get('zh-CN')!).sort()).toEqual(Object.keys(translations.get('en')!).sort());
    expect(Object.keys(translations.get('en')!)).toContain('plugin.typecho-plugin-ai.config.http.tokens.label');
    expect(routeResolver?.({ config: { http: { enabled: 'true', basePath: '/custom', tokens: [] } } })).toEqual([
      { path: '/custom', match: 'prefix' },
    ]);

    const saveHook = hooks.get('plugin:config:beforeSave')!;
    // Existing tokens survive a save untouched; only pending rows are filled,
    // and that happens at the host save boundary.
    const result = await saveHook({ success: true }, {
      pluginId: 'typecho-plugin-ai',
      settings: { providers: [], http: { enabled: 'true', basePath: '/ai', tokens: [{ id: 't1', token: 'access-secret-token-1234' }] } },
    });
    expect(result.success).toBe(true);
    expect(result.settings.http.tokens).toEqual([{ id: 't1', token: 'access-secret-token-1234' }]);

    const invalidToken = await saveHook({ success: true }, {
      pluginId: 'typecho-plugin-ai',
      settings: { providers: [], http: { enabled: 'true', basePath: '/ai', tokens: [{ id: 't1', token: 'short' }] } },
    });
    expect(invalidToken.success).toBe(false);
    expect(invalidToken.error).toContain('16-128');
  });

  it('translates validation failures through the registered locale catalog', async () => {
    const { context, hooks } = initContext();
    init(context);
    const zh = (await import('./locales/zh-CN.json')).default as Record<string, string>;
    const i18n = {
      t: (key: string, variables: Record<string, string | number> = {}, fallback = '') => {
        const template = zh[key];
        if (!template) return fallback;
        return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(variables[name] ?? `{${name}}`));
      },
    } as unknown as I18n;

    const saveHook = hooks.get('plugin:config:beforeSave')!;
    const result = await saveHook({ success: true }, {
      pluginId: 'typecho-plugin-ai',
      settings: {
        providers: [{ name: '', baseUrl: 'https://api.openai.com/v1', apiKey: 'key', models: [] }],
        http: { enabled: 'false', basePath: '/ai', tokens: [] },
      },
      i18n,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('每个 Provider 都需要名称。');
  });

  it('accepts every configured token and rejects requests when all are deleted', async () => {
    const service = { generate: vi.fn() };
    const multi = config({
      http: {
        enabled: true,
        basePath: '/ai',
        tokens: [
          { id: 't1', token: 'first-token-0123456789' },
          { id: 't2', token: 'second-token-0123456789' },
        ],
      },
    });
    const call = (token: string) => handleAiHttpRequest({
      request: new Request('https://example.com/ai/v1/models', {
        headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '198.51.100.7' },
      }),
      path: '/ai/v1/models', config: multi, service,
    });

    expect((await call('first-token-0123456789'))?.status).toBe(200);
    expect((await call('second-token-0123456789'))?.status).toBe(200);
    expect((await call('third-token-0123456789'))?.status).toBe(401);

    const empty = config({ http: { enabled: true, basePath: '/ai', tokens: [] } });
    const unreachable = await handleAiHttpRequest({
      request: new Request('https://example.com/ai/v1/models', {
        headers: { authorization: 'Bearer first-token-0123456789', 'cf-connecting-ip': '198.51.100.8' },
      }),
      path: '/ai/v1/models', config: empty, service,
    });
    expect(unreachable?.status).toBe(401);
  });
});