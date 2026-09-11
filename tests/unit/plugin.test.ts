import { describe, expect, it } from 'vitest';
import { HookPoints, parsePluginConfigFormData, type PluginConfigField } from '@/lib/plugin';

describe('HookPoints', () => {
  it('includes the plugin admin page hook used by the generic admin route', () => {
    expect(HookPoints['admin:page']).toBe('admin:page');
  });
});

describe('parsePluginConfigFormData()', () => {
  it('parses scalar, checkbox, and repeatable plugin config fields', () => {
    const configDef: Record<string, PluginConfigField> = {
      title: { type: 'text', label: 'Title' },
      flags: {
        type: 'checkbox',
        label: 'Flags',
        options: { a: 'A', b: 'B' },
      },
      mounts: {
        type: 'repeatable',
        label: 'Mounts',
        itemFields: {
          mount: { type: 'text', label: 'Mount' },
          provider: {
            type: 'select',
            label: 'Provider',
            default: 'r2',
            options: { r2: 'R2', s3: 'S3' },
          },
          pathStyle: {
            type: 'select',
            label: 'Path style',
            default: 'true',
            options: { true: 'Path', false: 'Virtual hosted' },
          },
        },
      },
    };

    const formData = new FormData();
    formData.set('title', 'WebDAV');
    formData.append('flags', 'a');
    formData.set('mounts[0][mount]', 'media');
    formData.set('mounts[0][provider]', 'r2');
    formData.set('mounts[0][pathStyle]', 'true');
    formData.set('mounts[1][mount]', 'backup');
    formData.set('mounts[1][provider]', 's3');
    formData.set('mounts[1][pathStyle]', 'false');

    expect(parsePluginConfigFormData(configDef, formData)).toEqual({
      title: 'WebDAV',
      flags: ['a'],
      mounts: [
        { mount: 'media', provider: 'r2', pathStyle: 'true' },
        { mount: 'backup', provider: 's3', pathStyle: 'false' },
      ],
    });
  });

  it('ignores repeatable subfields that are not declared in the manifest', () => {
    const configDef: Record<string, PluginConfigField> = {
      mounts: {
        type: 'repeatable',
        label: 'Mounts',
        itemFields: {
          mount: { type: 'text', label: 'Mount' },
        },
      },
    };
    const formData = new FormData();
    formData.set('mounts[0][mount]', 'media');
    formData.set('mounts[0][secret]', 'should-not-pass');

    expect(parsePluginConfigFormData(configDef, formData)).toEqual({
      mounts: [{ mount: 'media' }],
    });
  });

  it('parses nested repeatables and option checkboxes recursively', () => {
    const configDef: Record<string, PluginConfigField> = {
      providers: {
        type: 'repeatable',
        label: 'Providers',
        itemFields: {
          name: { type: 'text', label: 'Name' },
          models: {
            type: 'repeatable',
            label: 'Models',
            itemFields: {
              model: { type: 'text', label: 'Model' },
              capabilities: {
                type: 'checkbox',
                label: 'Capabilities',
                options: { chat: 'Chat', embed: 'Embeddings' },
              },
            },
          },
        },
      },
    };
    const formData = new FormData();
    formData.set('providers[0][name]', 'primary');
    formData.set('providers[0][models][0][model]', 'gpt-test');
    formData.append('providers[0][models][0][capabilities]', 'chat');
    formData.append('providers[0][models][0][capabilities]', 'embed');
    formData.set('providers[0][models][1][model]', 'fallback');
    formData.set('providers[1][name]', 'secondary');
    formData.set('providers[1][models][0][model]', 'other');

    expect(parsePluginConfigFormData(configDef, formData)).toEqual({
      providers: [
        {
          name: 'primary',
          models: [
            { model: 'gpt-test', capabilities: ['chat', 'embed'] },
            { model: 'fallback', capabilities: [] },
          ],
        },
        {
          name: 'secondary',
          models: [{ model: 'other', capabilities: [] }],
        },
      ],
    });
  });
});
