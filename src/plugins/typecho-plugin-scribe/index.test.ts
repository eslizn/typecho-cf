import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCapabilityRuntimeContext,
  registerCapability,
  resetCapabilityRegistry,
  setCapabilityActivation,
} from '@/lib/capability';
import init from './index';

function collectHooks() {
  const hooks = new Map<string, Function[]>();
  init({
    pluginId: 'typecho-plugin-scribe',
    HookPoints: {} as any,
    addHook: (point: string, _pluginId: string, handler: Function) => {
      const list = hooks.get(point) || [];
      list.push(handler);
      hooks.set(point, list);
    },
    registerRouteResolver: () => {},
    registerAdminPath: () => {},
    registerTranslations: () => {},
    registerScheduledTask: () => {},
    registerAsyncTask: () => {},
    enqueueAsyncTask: async () => ({
      jobId: 'test-job',
      taskKey: 'test-task',
      idempotencyKey: 'test-key',
    }),
  });
  return hooks;
}

/**
 * Publish the AI plugin's chat capability and model catalog, then return the
 * request-scoped runtime Scribe resolves both through.
 */
function aiRuntime(generate: ReturnType<typeof vi.fn>, models: string[] = ['glm-4.7-flash']) {
  resetCapabilityRegistry();
  registerCapability('typecho-plugin-ai', {
    capability: 'ai.chat.generate',
    version: 1,
    factory: () => ({ generate }),
  });
  registerCapability('typecho-plugin-ai', {
    capability: 'ai.models.list',
    version: 1,
    factory: () => ({ listOptions: () => models.map(value => ({ value, label: value })) }),
  });
  setCapabilityActivation(new Set(['typecho-plugin-ai']), 1);
  return createCapabilityRuntimeContext({
    request: new Request('https://blog.example/admin/write-post'),
    db: {} as never,
    activatedPlugins: new Set(['typecho-plugin-ai']),
    activationGeneration: 1,
  });
}

/** Minimal chat chunk stream in the shape the AI capability returns. */
function chatChunks(parts: string[]): ReadableStream<{ choices: Array<{ delta: { content: string } }> }> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue({ choices: [{ delta: { content: part } }] });
      controller.close();
    },
  });
}

function scribeOptions(overrides: Record<string, unknown> = {}) {
  return {
    siteUrl: 'https://blog.example',
    'plugin:typecho-plugin-scribe': JSON.stringify({ model: 'glm-4.7-flash', ...overrides }),
  };
}

describe('typecho-plugin-scribe', () => {
  beforeEach(() => {
    resetCapabilityRegistry();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetCapabilityRegistry();
  });

  it('registers editor, config validation, and action hooks', () => {
    const hooks = collectHooks();

    expect([...hooks.keys()].sort()).toEqual([
      'admin:writePage:bottom',
      'admin:writePost:bottom',
      'plugin:config:beforeSave',
      'plugin:typecho-plugin-scribe:action',
      'plugin:typecho-plugin-scribe:action:authorize',
    ]);
  });

  it('injects the AI writer editor control into post and page editors', () => {
    const hooks = collectHooks();
    const postHtml = hooks.get('admin:writePost:bottom')![0]('');
    const pageHtml = hooks.get('admin:writePage:bottom')![0]('');

    expect(postHtml).toContain('typecho-scribe');
    expect(postHtml).toContain('data-content-type="post"');
    expect(postHtml).toContain('AI 生成');
    expect(postHtml).toContain('AI 润色');
    expect(postHtml).toContain('AI 纠错');
    expect(pageHtml).toContain('data-content-type="page"');
  });

  it('ignores config validation for other plugins', async () => {
    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')![0];
    const original = { success: true, settings: { model: '' } };

    await expect(validate(original, {
      pluginId: 'other-plugin',
      settings: {},
    })).resolves.toBe(original);
  });

  it('rejects a save without a selected model', async () => {
    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')![0];

    const result = await validate({ success: true, settings: {} }, {
      pluginId: 'typecho-plugin-scribe',
      capabilityRuntime: aiRuntime(vi.fn()),
      settings: { model: '' },
    });

    expect(result).toMatchObject({ success: false, error: '请选择 AI 插件中可用的模型' });
  });

  it('rejects a save while the AI plugin publishes no catalog', async () => {
    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')![0];

    const result = await validate({ success: true, settings: {} }, {
      pluginId: 'typecho-plugin-scribe',
      settings: { model: 'glm-4.7-flash' },
    });

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('typecho-plugin-ai');
  });

  it('rejects a model the AI plugin does not publish', async () => {
    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')![0];

    const result = await validate({ success: true, settings: {} }, {
      pluginId: 'typecho-plugin-scribe',
      capabilityRuntime: aiRuntime(vi.fn(), ['gpt-5']),
      settings: { model: 'glm-4.7-flash' },
    });

    expect(result).toMatchObject({ success: false, error: '模型不存在：glm-4.7-flash' });
  });

  it('accepts a save when the catalog publishes the selected model', async () => {
    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')![0];

    const result = await validate({ success: true, settings: {} }, {
      pluginId: 'typecho-plugin-scribe',
      capabilityRuntime: aiRuntime(vi.fn()),
      settings: { model: 'glm-4.7-flash', outputLanguage: 'en' },
    });

    expect(result.success).toBe(true);
    expect(result.settings.model).toBe('glm-4.7-flash');
    expect(result.settings.outputLanguage).toBe('en');
  });

  it('rejects unsupported writing profile config before saving', async () => {
    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')![0];

    const result = await validate({ success: true, settings: {} }, {
      pluginId: 'typecho-plugin-scribe',
      capabilityRuntime: aiRuntime(vi.fn()),
      settings: { model: 'glm-4.7-flash', outputLanguage: 'fr' },
    });

    expect(result).toMatchObject({ success: false, error: '输出语言配置不正确' });
  });

  it('returns not handled for unsupported plugin actions', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-scribe:action')![0];
    const original = { handled: false };

    await expect(action(original, { action: 'unknown', payload: {} })).resolves.toBe(original);
  });

  it('reports a missing AI capability instead of calling a provider itself', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-scribe:action')![0];

    const result = await action({ handled: false }, {
      action: 'generate',
      payload: { contentType: 'post', title: 'Test' },
      options: scribeOptions(),
    });

    expect(result).toMatchObject({ handled: true, success: false });
    expect(String(result.error)).toContain('ai.chat.generate');
  });

  it('streams the capability result and sends structured writing context', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-scribe:action')![0];
    const generate = vi.fn(async (_request: any) => chatChunks(['```markdown\n', '正文', '内容\n```']));

    const result = await action({ handled: false }, {
      action: 'generate',
      payload: { contentType: 'post', title: 'LLM 写作实践' },
      capabilityRuntime: aiRuntime(generate),
      options: scribeOptions({
        outputLanguage: 'en',
        targetAudience: '后端工程师',
        lengthPreset: 'detailed',
        factPolicy: 'conservative',
        userPrompt: '避免营销腔。',
      }),
    });

    expect(result.handled).toBe(true);
    expect(result.success).toBe(true);
    expect(result.response).toBeInstanceOf(Response);
    expect(result.response.headers.get('X-Typecho-Plugin-Stream')).toBe('1');

    const request = generate.mock.calls[0]?.[0] as any;
    expect(request.model).toBe('glm-4.7-flash');
    expect(request.stream).toBe(true);
    expect(request.messages[0].content).toContain('资深内容编辑助手');
    expect(request.messages[1].content).toContain('<style_samples>');
    expect(request.messages[1].content).toContain('<writing_profile>');
    expect(request.messages[1].content).toContain('输出语言：固定使用：en');
    expect(request.messages[1].content).toContain('目标读者：后端工程师');
    expect(request.messages[1].content).toContain('篇幅策略：深入');
    expect(request.messages[1].content).toContain('<task>');
    expect(request.messages[1].content).toContain('<output_contract>');

    const text = await result.response.text();
    expect(text).toContain('正文');
    expect(text).toContain('内容');
    // The incidental Markdown fence the model added is stripped on both ends.
    expect(text).not.toContain('```');
  });

  it('maps AI capability failures into localized writing errors', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-scribe:action')![0];
    const generate = vi.fn(async (_request: any) => {
      throw Object.assign(new Error('The requested model is not available.'), { code: 'model-not-found' });
    });

    const result = await action({ handled: false }, {
      action: 'polish',
      payload: { contentType: 'post', title: 'T', body: 'existing body' },
      capabilityRuntime: aiRuntime(generate),
      options: scribeOptions(),
    });

    expect(result).toMatchObject({ handled: true, success: false, error: '模型不存在：glm-4.7-flash' });
  });
});
