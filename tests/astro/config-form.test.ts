/**
 * Render tests for the shared admin configuration form.
 *
 * Replaces the previous source greps in plugin-config-page.test.ts,
 * theme-config-page.test.ts and admin-button-style.test.ts: the form is now
 * rendered and the resulting markup is asserted instead of the template text.
 */
import { describe, expect, it } from 'vitest';
import ConfigForm from '@/components/admin/ConfigForm.astro';
import type { ConfigField } from '@/lib/config';
import { renderComponent, testI18n } from './helpers';

const CONFIG_DEF: Record<string, ConfigField> = {
  apiKey: { type: 'text', label: 'API key', description: 'Secret key' },
  mode: { type: 'select', label: 'Mode', options: { fast: 'Fast', safe: 'Safe' } },
  token: { type: 'password', label: 'Token' },
  enabled: { type: 'checkbox', label: 'Enabled' },
  mounts: {
    type: 'repeatable',
    label: 'Mounts',
    itemFields: { host: { type: 'text', label: 'Host' } },
  },
};

const CONFIG_VALUES = {
  apiKey: 'stored-key',
  mode: 'safe',
  token: '••••••••',
  enabled: true,
  mounts: [{ host: 'a.example' }, { host: 'b.example' }],
};

function renderForm(overrides: Record<string, unknown> = {}) {
  return renderComponent(ConfigForm, {
    props: {
      action: '/api/admin/plugin-config',
      csrfToken: 'csrf-token-value',
      entityName: 'plugin',
      entityId: 'demo-plugin',
      configDef: CONFIG_DEF,
      configValues: CONFIG_VALUES,
      message: 'Saved',
      backHref: '/admin/plugins',
      backLabel: 'Back',
      i18n: testI18n('en'),
      ...overrides,
    },
  });
}

describe('ConfigForm rendering', () => {
  it('posts to the configured action with CSRF and entity identity', async () => {
    const html = await renderForm();

    expect(html).toContain('<form method="post" action="/api/admin/plugin-config"');
    expect(html).toContain('name="_" value="csrf-token-value"');
    expect(html).toContain('name="plugin" value="demo-plugin"');
  });

  it('renders every field type with its saved value', async () => {
    const html = await renderForm();

    expect(html).toContain('name="apiKey"');
    expect(html).toContain('value="stored-key"');
    expect(html).toContain('<option value="safe" selected>Safe</option>');
    expect(html).toContain('type="password"');
    expect(html).toContain('name="enabled" value="1" checked');
  });

  it('renders one repeatable row per saved entry plus the add-template row', async () => {
    const html = await renderForm();

    expect(html).toContain('name="mounts[0][host]"');
    expect(html).toContain('name="mounts[1][host]"');
    expect(html).toContain('value="a.example"');
    expect(html).toContain('value="b.example"');
    expect(html).toContain('class="typecho-repeatable"');
    expect(html).toContain('data-label="Mounts"');
    expect(html).toContain('<template class="typecho-repeatable-template">');
    // Every rendered row and the template row carry a remove button.
    expect(html.match(/class="btn btn-xs typecho-repeatable-remove"/g)).toHaveLength(3);
    // Initial legends are numbered; the add-template keeps its placeholders.
    expect(html).toContain('<legend>Mounts #1</legend>');
    expect(html).toContain('<legend>Mounts #2</legend>');
    expect(html).toContain('<legend>Mounts #__NUMBER__</legend>');
  });

  it('renders the dismissible success notice with a close control', async () => {
    const html = await renderForm();

    expect(html).toContain('notice typecho-dismissible notice-success');
    expect(html).toContain('class="typecho-notice-close"');
    expect(html).toContain('aria-label="Close notice"');
  });

  it('omits the notice when no message is supplied', async () => {
    const html = await renderForm({ message: '' });

    expect(html).not.toContain('typecho-dismissible');
  });

  it('renders the entity hidden field for themes as well as plugins', async () => {
    const html = await renderForm({
      action: '/api/admin/theme-config',
      entityName: 'theme',
      entityId: 'typecho-theme-minimal',
      backHref: '/admin/themes',
    });

    expect(html).toContain('action="/api/admin/theme-config"');
    expect(html).toContain('name="theme" value="typecho-theme-minimal"');
  });

  it('renders dynamic R2 option sources without an R2 binding', async () => {
    // The form guards every binding method before use; with the stub env (no
    // BUCKET) the select must still render, just without options.
    const html = await renderForm({
      configDef: {
        bucket: { type: 'select', label: 'Bucket', optionsSource: 'r2Bindings' },
      } as Record<string, ConfigField>,
      configValues: {},
    });

    expect(html).toContain('name="bucket"');
    expect(html).toContain('<select id="cfg-bucket" name="bucket"');
  });

  it('keeps the stable row id on existing repeatable rows', async () => {
    const html = await renderForm();

    expect(html).toContain('name="mounts[0][__typechoConfigRowId]"');
    expect(html).toContain('name="mounts[1][__typechoConfigRowId]"');
  });

  it('normalises an empty root path back to "/"', async () => {
    const html = await renderForm({
      configDef: {
        mounts: {
          type: 'repeatable',
          label: 'Mounts',
          itemFields: { path: { type: 'text', label: 'Path', default: '/' } },
        },
      } as Record<string, ConfigField>,
      configValues: { mounts: [{ path: '' }] },
    });

    expect(html).toContain('name="mounts[0][path]"');
    expect(html).toContain('value="/"');
  });

  it('renders boolean select values as manifest option strings', async () => {
    const html = await renderForm({
      configDef: {
        enabled: { type: 'select', label: 'Enabled', options: { true: 'Yes', false: 'No' } },
      } as Record<string, ConfigField>,
      configValues: { enabled: true },
    });

    expect(html).toContain('data-current-value="true"');
    expect(html).toContain('<option value="true" selected>Yes</option>');
  });

  it('lists only bucket-like bindings for dynamic R2 option sources', async () => {
    const { env } = await import('cloudflare:workers');
    const fullBucket = {
      get: () => undefined, put: () => undefined, delete: () => undefined,
      head: () => undefined, list: () => undefined,
    };
    const bindings = env as unknown as Record<string, unknown>;
    const previousExtra = bindings.R2_EXTRA;
    const previousPartial = bindings.R2_PARTIAL;

    try {
      bindings.R2_EXTRA = fullBucket;
      bindings.R2_PARTIAL = { get: () => undefined };

      const html = await renderForm({
        configDef: { bucket: { type: 'select', label: 'Bucket', optionsSource: 'r2Bindings' } } as Record<string, ConfigField>,
        configValues: {},
      });

      expect(html).toContain('<option value="R2_EXTRA">R2_EXTRA</option>');
      expect(html).not.toContain('R2_PARTIAL');
    } finally {
      bindings.R2_EXTRA = previousExtra;
      bindings.R2_PARTIAL = previousPartial;
    }
  });

  it('renders nested repeatable fields and multi-select checkboxes', async () => {
    const html = await renderForm({
      configDef: {
        providers: {
          type: 'repeatable',
          label: 'Providers',
          itemFields: {
            models: {
              type: 'repeatable',
              label: 'Models',
              itemFields: {
                model: { type: 'text', label: 'Model' },
                capabilities: {
                  type: 'checkbox',
                  label: 'Capabilities',
                  options: { chat: 'Chat', image: 'Image' },
                },
              },
            },
          },
        },
      } as Record<string, ConfigField>,
      configValues: {
        providers: [{
          models: [{ model: 'gpt-test', capabilities: ['chat', 'image'] }],
        }],
      },
    });

    expect(html).toContain('name="providers[0][models][0][model]"');
    expect(html).toContain('name="providers[0][models][0][capabilities]"');
    expect(html).toContain('value="chat" checked');
    expect(html).toContain('value="image" checked');
    expect(html).toContain('name="providers[__INDEX__][models][__INDEX__][capabilities]"');
  });

  it('renders a collapsible repeatable as a summary card with a status badge', async () => {
    const html = await renderForm({
      configDef: {
        providers: {
          type: 'repeatable',
          label: 'Providers',
          collapsible: true,
          summaryFields: ['name', 'baseUrl'],
          statusField: 'enabled',
          itemFields: {
            name: { type: 'text', label: 'Name' },
            baseUrl: { type: 'text', label: 'Base URL' },
            enabled: { type: 'select', label: 'Enabled', options: { true: 'Enabled', false: 'Disabled' } },
          },
        },
      } as Record<string, ConfigField>,
      configValues: {
        providers: [
          { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', enabled: 'true' },
          { name: 'Azure', baseUrl: '', enabled: 'false' },
        ],
      },
    });

    expect(html).toContain('typecho-repeatable is-collapsible');
    expect(html).toContain('data-summary-fields="name,baseUrl"');
    expect(html).toContain('data-status-field="enabled"');
    expect(html).toContain('<span class="typecho-repeatable-summary" data-item-summary>OpenAI · https://api.openai.com/v1</span>');
    expect(html).toContain('admin-badge--active');
    expect(html).toContain('admin-badge--muted');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-expanded="false"');
    // The first card stays open; later cards start collapsed.
    expect(html).toContain('class="typecho-repeatable-item"');
    expect(html).toContain('class="typecho-repeatable-item is-collapsed"');
  });

  it('renders a token list with copy/delete controls and a pending-row template', async () => {
    const html = await renderForm({
      configDef: { tokens: { type: 'tokens', label: 'Access tokens' } } as Record<string, ConfigField>,
      configValues: { tokens: [{ id: 't1', token: 'abcdefghijklmnopqrst' }] },
    });

    expect(html).toContain('data-token-list="tokens"');
    expect(html).toContain('name="tokens[0][id]" value="t1"');
    expect(html).toContain('name="tokens[0][token]" value="abcdefghijklmnopqrst"');
    // Tokens are shown in full; the page is wide enough and masking would only
    // make them harder to verify by eye.
    expect(html).toContain('abcdefghijklmnopqrst');
    expect(html).not.toContain('abcdef…qrst');
    expect(html).toContain('typecho-token-copy');
    expect(html).toContain('typecho-token-remove');
    expect(html).toContain('Generate token');
    expect(html).toContain('name="tokens[__INDEX__][id]" value="__TOKEN_ID__"');
    // The client fills the template row with a freshly generated token; the
    // row is not persisted until the form is saved.
    expect(html).toContain('<code class="typecho-token-value" data-token-display></code>');
    expect(html).toMatch(/class="typecho-token-template"[\s\S]*typecho-token-copy/);
    // The empty-state hint is hidden while at least one token exists.
    expect(html).toMatch(/data-token-empty[^>]*hidden/);
  });

  it('localizes the collapsed-card status badge through the nested field path', async () => {
    const messages: Record<string, string> = {
      'plugin.demo.config.providers.enabled.option.true': '提供方启用',
      'plugin.demo.config.providers.enabled.option.false': '提供方停用',
      'plugin.demo.config.providers.models.enabled.option.true': '模型启用',
      'plugin.demo.config.providers.models.enabled.option.false': '模型停用',
    };
    const i18n = {
      locale: 'zh-CN',
      t: (key: string, _variables: Record<string, string | number> = {}, fallback = '') => messages[key] ?? fallback,
    };

    const html = await renderForm({
      entityId: 'demo',
      i18n: i18n as never,
      configDef: {
        providers: {
          type: 'repeatable',
          label: 'Providers',
          collapsible: true,
          statusField: 'enabled',
          itemFields: {
            name: { type: 'text', label: 'Name' },
            enabled: { type: 'select', label: 'Enabled', options: { true: 'Enabled', false: 'Disabled' } },
            models: {
              type: 'repeatable',
              label: 'Models',
              collapsible: true,
              statusField: 'enabled',
              itemFields: {
                model: { type: 'text', label: 'Model' },
                enabled: { type: 'select', label: 'Enabled', options: { true: 'Enabled', false: 'Disabled' } },
              },
            },
          },
        },
      } as Record<string, ConfigField>,
      configValues: {
        providers: [{
          name: 'OpenAI',
          enabled: 'true',
          models: [{ model: 'gpt-test', enabled: 'false' }],
        }],
      },
    });

    // Both the provider badge and the nested model badge use the localized
    // option label instead of the English fallback.
    expect(html).toContain('data-item-badge>提供方启用<');
    expect(html).toContain('data-item-badge>模型停用<');
    expect(html).not.toContain('data-item-badge>Enabled<');
  });

  it('renders options the manifest disables as disabled controls', async () => {
    const html = await renderForm({
      configDef: {
        capabilities: {
          type: 'checkbox',
          label: 'Capabilities',
          options: { chat: 'Chat generation', image: 'Image generation' },
          optionDisabled: ['image'],
        },
        mode: { type: 'select', label: 'Mode', options: { fast: 'Fast', safe: 'Safe' }, optionDisabled: ['safe'] },
      } as Record<string, ConfigField>,
      configValues: { capabilities: ['chat', 'image'], mode: 'fast' },
    });

    expect(html).toContain('value="chat" checked');
    expect(html).toMatch(/value="image" checked disabled/);
    expect(html).toMatch(/<option value="safe"[^>]*disabled/);
    expect(html).not.toMatch(/<option value="fast"[^>]*disabled/);
  });

  it('disables token generation once the cap is reached', async () => {
    const tokens = Array.from({ length: 20 }, (_, index) => ({
      id: `t${index}`,
      token: `token-${index}-0123456789`,
    }));

    const html = await renderForm({
      configDef: { tokens: { type: 'tokens', label: 'Access tokens' } } as Record<string, ConfigField>,
      configValues: { tokens },
    });

    expect(html).toContain('data-max="20"');
    expect(html).toMatch(/class="btn typecho-token-generate" disabled/);
    expect(html).toMatch(/data-token-limit(?! hidden)/);
  });

  it('shows the token empty state when every token is deleted', async () => {
    const html = await renderForm({
      configDef: { tokens: { type: 'tokens', label: 'Access tokens' } } as Record<string, ConfigField>,
      configValues: { tokens: [] },
    });

    expect(html).toContain('data-token-list="tokens"');
    expect(html).not.toContain('name="tokens[0][id]"');
    expect(html).not.toMatch(/data-token-empty[^>]*hidden/);
    expect(html).toContain('makes the endpoint unreachable');
    // The generate template is always present for client-side rows.
    expect(html).toContain('class="typecho-token-template"');
  });
});
