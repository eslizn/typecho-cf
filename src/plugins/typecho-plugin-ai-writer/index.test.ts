import { describe, expect, it } from 'vitest';
import init from './index';

function collectHooks() {
  const hooks = new Map<string, Function[]>();
  init({
    pluginId: 'typecho-plugin-ai-writer',
    HookPoints: {} as any,
    addHook: (point: string, _pluginId: string, handler: Function) => {
      const list = hooks.get(point) || [];
      list.push(handler);
      hooks.set(point, list);
    },
  });
  return hooks;
}

describe('typecho-plugin-ai-writer', () => {
  it('registers editor, config validation, and action hooks', () => {
    const hooks = collectHooks();

    expect([...hooks.keys()].sort()).toEqual([
      'admin:writePage:bottom',
      'admin:writePost:bottom',
      'plugin:config:beforeSave',
      'plugin:typecho-plugin-ai-writer:action',
    ]);
  });

  it('injects the AI writer editor control into post and page editors', () => {
    const hooks = collectHooks();
    const postHtml = hooks.get('admin:writePost:bottom')![0]('');
    const pageHtml = hooks.get('admin:writePage:bottom')![0]('');

    expect(postHtml).toContain('typecho-ai-writer');
    expect(postHtml).toContain('data-content-type="post"');
    expect(pageHtml).toContain('data-content-type="page"');
  });

  it('ignores config validation for other plugins', async () => {
    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')![0];
    const original = { success: true, settings: { endpoint: '' } };

    await expect(validate(original, {
      pluginId: 'other-plugin',
      settings: {},
    })).resolves.toBe(original);
  });

  it('rejects incomplete LLM config before saving', async () => {
    const hooks = collectHooks();
    const validate = hooks.get('plugin:config:beforeSave')![0];

    const result = await validate({ success: true, settings: {} }, {
      pluginId: 'typecho-plugin-ai-writer',
      settings: {
        endpoint: '',
        apiKey: '',
        model: '',
      },
    });

    expect(result).toMatchObject({
      success: false,
      error: '请填写接口地址、API Key 和模型名称',
    });
  });

  it('returns not handled for unsupported plugin actions', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-ai-writer:action')![0];
    const original = { handled: false };

    await expect(action(original, { action: 'unknown', payload: {} })).resolves.toBe(original);
  });

  it('handles generation action with a clear configuration error', async () => {
    const hooks = collectHooks();
    const action = hooks.get('plugin:typecho-plugin-ai-writer:action')![0];

    const result = await action({ handled: false }, {
      action: 'generate',
      payload: { contentType: 'post', title: 'Test' },
      options: {
        'plugin:typecho-plugin-ai-writer': JSON.stringify({
          endpoint: 'https://llm.example/v1',
          apiKey: '',
          model: 'demo-model',
        }),
      },
    });

    expect(result).toMatchObject({
      handled: true,
      success: false,
      error: '请先完整配置接口地址、API Key 和模型名称',
    });
  });
});
