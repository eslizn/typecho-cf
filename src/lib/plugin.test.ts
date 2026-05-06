import { describe, expect, it } from 'vitest';
import { parsePluginConfigFormData, type PluginConfigField } from './plugin';

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
});
