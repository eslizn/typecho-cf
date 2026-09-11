import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf-8')) as Record<string, any>;
}

describe('typecho-plugin-wechat-publisher metadata', () => {
  it('uses WechatPublisher as the display name in all admin name sources', () => {
    const manifest = readJson('../../src/plugins/typecho-plugin-wechat-publisher/package.json');
    const zhCatalog = readJson('../../src/plugins/typecho-plugin-wechat-publisher/locales/zh-CN.json');
    const enCatalog = readJson('../../src/plugins/typecho-plugin-wechat-publisher/locales/en.json');

    expect(manifest.typecho.plugin.name).toBe('WechatPublisher');
    expect(zhCatalog['plugin.typecho-plugin-wechat-publisher.name']).toBe('WechatPublisher');
    expect(enCatalog['plugin.typecho-plugin-wechat-publisher.name']).toBe('WechatPublisher');
    expect(zhCatalog['plugin.typecho-plugin-wechat-publisher.message.adminMenu']).toBe('WechatPublisher');
    expect(enCatalog['plugin.typecho-plugin-wechat-publisher.message.adminMenu']).toBe('WechatPublisher');
  });
});
