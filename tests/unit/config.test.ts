import { describe, expect, it } from 'vitest';
import {
  allowlistConfigSettings,
  CONFIG_TOKEN_MAX,
  CONFIG_TOKEN_PATTERN,
  findTokenLimitOverflow,
  loadConfig,
  maskConfigValue,
  maskConfigValues,
  parseConfigFormData,
  restoreConfigValue,
  type ConfigField,
} from '@/lib/config';

const FIELDS: Record<string, ConfigField> = {
  providers: {
    type: 'repeatable',
    label: 'Providers',
    itemFields: {
      name: { type: 'text', label: 'Name', default: '' },
      models: {
        type: 'repeatable',
        label: 'Models',
        itemFields: {
          model: { type: 'text', label: 'Model', default: '' },
          capabilities: {
            type: 'checkbox',
            label: 'Capabilities',
            options: { chat: 'Chat', embeddings: 'Embeddings' },
            default: ['chat'],
          },
          apiKey: { type: 'password', label: 'API key', default: '' },
        },
      },
    },
  },
};

describe('recursive config normalization', () => {
  it('drops unknown nested keys and defaults invalid known values', () => {
    const result = allowlistConfigSettings(FIELDS, {
      providers: [{
        name: 'provider',
        unknown: 'drop me',
        models: [{
          model: 'gpt-test',
          capabilities: ['chat', 'unknown'],
          unknown: true,
        }],
      }],
    }, { providers: [] });

    expect(result).toEqual({
      providers: [{
        name: 'provider',
        models: [{ model: 'gpt-test', capabilities: ['chat'], apiKey: '' }],
      }],
    });
  });

  it('masks and restores secrets at every repeatable depth', () => {
    const value = {
      providers: [{
        name: 'provider',
        models: [{ model: 'gpt-test', capabilities: ['chat'], apiKey: 'secret' }],
      }],
    };
    const masked = maskConfigValue(FIELDS.providers, value.providers) as any[];
    expect(masked[0].models[0].apiKey).toBe('__PLUGIN_CONFIG_SECRET__');

    const restored = restoreConfigValue(FIELDS.providers, masked, value.providers) as any[];
    expect(restored[0].models[0].apiKey).toBe('secret');
  });

  it('uses the schema allowlist when loading saved JSON', () => {
    const loaded = loadConfig({
      'plugin:test': JSON.stringify({
        providers: [{ name: 'ok', models: [], unknown: 'drop' }],
        unknown: true,
      }),
    }, 'plugin:test', FIELDS);

    expect(loaded).toEqual({ providers: [{ name: 'ok', models: [] }] });
  });
});

describe('token list fields', () => {
  const TOKEN_FIELDS: Record<string, ConfigField> = {
    http: {
      type: 'object',
      label: 'HTTP',
      itemFields: {
        enabled: { type: 'checkbox', label: 'Enabled' },
        tokens: { type: 'tokens', label: 'Tokens' },
      },
    },
    keys: { type: 'tokens', label: 'Keys' },
  };

  it('parses existing and pending token rows from the form', () => {
    const form = new FormData();
    form.set('http[enabled]', '1');
    form.set('keys[0][id]', 't1');
    form.set('keys[0][token]', 'A'.repeat(32));
    form.set('keys[1][id]', 't2');

    const parsed = parseConfigFormData(TOKEN_FIELDS, form);

    expect(parsed.keys).toEqual([
      { id: 't1', token: 'A'.repeat(32) },
      { id: 't2', token: '' },
    ]);
  });

  it('drops malformed, empty and duplicate tokens and enforces the cap', () => {
    const valid = Array.from({ length: CONFIG_TOKEN_MAX + 3 }, (_, index) => ({
      id: `t${index}`,
      token: `tok_${String(index).padStart(3, '0')}`.padEnd(20, 'x'),
    }));

    const normalized = allowlistConfigSettings({ keys: TOKEN_FIELDS.keys }, {
      keys: [
        { id: 'bad id', token: 'short' },
        { id: 'empty', token: '' },
        { id: 'dup', token: valid[0].token },
        ...valid,
      ],
    }, { keys: [] });
    const tokens = normalized.keys as Array<{ id: string; token: string }>;

    expect(tokens).toHaveLength(CONFIG_TOKEN_MAX);
    expect(tokens.some(row => row.token === 'short')).toBe(false);
    expect(tokens.some(row => row.id === 'empty')).toBe(false);
    expect(tokens.every(row => CONFIG_TOKEN_PATTERN.test(row.token))).toBe(true);
    expect(new Set(tokens.map(row => row.token)).size).toBe(tokens.length);
  });

  it('rejects option values the manifest marks disabled', () => {
    const fields: Record<string, ConfigField> = {
      capabilities: {
        type: 'checkbox',
        label: 'Capabilities',
        options: { chat: 'Chat generation', image: 'Image generation' },
        optionDisabled: ['image'],
      },
      mode: { type: 'select', label: 'Mode', options: { fast: 'Fast', safe: 'Safe' }, optionDisabled: ['safe'] },
    };

    expect(allowlistConfigSettings(fields, {
      capabilities: ['chat', 'image'],
      mode: 'safe',
    }, { capabilities: [], mode: 'fast' })).toEqual({ capabilities: ['chat'], mode: '' });
  });

  it('bounds values coming from a dynamic option source', () => {
    const fields: Record<string, ConfigField> = {
      model: {
        type: 'select',
        label: 'Model',
        optionsSource: { capability: 'ai.models.list', ownerPluginId: 'typecho-plugin-ai' },
      },
    };

    // The catalog lives in another plugin, so a bounded name is kept here and
    // re-validated by the owning plugin during beforeSave.
    expect(allowlistConfigSettings(fields, { model: 'glm-4.7-flash' }, {})).toEqual({ model: 'glm-4.7-flash' });
    expect(allowlistConfigSettings(fields, { model: 'x'.repeat(300) }, {}).model).toBe('');
    expect(allowlistConfigSettings(fields, { model: 'bad\tname' }, {}).model).toBe('');
  });

  it('detects token lists over the cap instead of trimming them silently', () => {
    const atCap = Array.from({ length: CONFIG_TOKEN_MAX }, (_, index) => ({
      id: `t${index}`,
      token: `token-${index}-0123456789`,
    }));
    const overCap = [...atCap, { id: 'extra', token: 'token-extra-0123456789' }];

    expect(findTokenLimitOverflow(TOKEN_FIELDS, { keys: atCap })).toBeNull();
    expect(findTokenLimitOverflow(TOKEN_FIELDS, { keys: overCap }))
      .toEqual({ max: CONFIG_TOKEN_MAX, count: CONFIG_TOKEN_MAX + 1 });
    expect(findTokenLimitOverflow(TOKEN_FIELDS, { http: { tokens: overCap } }))
      .toEqual({ max: CONFIG_TOKEN_MAX, count: CONFIG_TOKEN_MAX + 1 });
  });

  it('starts a token list empty and never mints one while reading', () => {
    expect(allowlistConfigSettings({ keys: TOKEN_FIELDS.keys }, {}, { keys: [] }).keys).toEqual([]);
    expect(loadConfig(
      { 'plugin:test': JSON.stringify({ keys: [{ id: 't1', token: 'C'.repeat(32) }] }) },
      'plugin:test',
      { keys: TOKEN_FIELDS.keys },
    )).toEqual({ keys: [{ id: 't1', token: 'C'.repeat(32) }] });
  });

  it('keeps tokens readable in the masked admin view', () => {
    const value = 'C'.repeat(32);
    expect(maskConfigValues({ keys: TOKEN_FIELDS.keys }, {
      keys: [{ id: 't1', token: value }],
    })).toEqual({ keys: [{ id: 't1', token: value }] });
  });
});