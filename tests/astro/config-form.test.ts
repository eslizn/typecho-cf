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
});
