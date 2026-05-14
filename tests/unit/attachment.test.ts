import { describe, expect, it } from 'vitest';
import { parseAttachmentMeta, type AttachmentMeta } from '@/lib/attachment';

describe('parseAttachmentMeta', () => {
  it('returns empty object for null/undefined/empty', () => {
    expect(parseAttachmentMeta(null)).toEqual({});
    expect(parseAttachmentMeta(undefined)).toEqual({});
    expect(parseAttachmentMeta('')).toEqual({});
  });

  it('parses valid JSON metadata', () => {
    const meta = parseAttachmentMeta(JSON.stringify({
      url: '/uploads/img.jpg',
      name: 'photo.jpg',
      type: 'image/jpeg',
      size: 204800,
    }));
    expect(meta).toEqual({
      url: '/uploads/img.jpg',
      name: 'photo.jpg',
      type: 'image/jpeg',
      size: 204800,
    });
  });

  it('returns empty object for invalid JSON', () => {
    expect(parseAttachmentMeta('not json')).toEqual({});
    expect(parseAttachmentMeta('{broken')).toEqual({});
  });

  it('omits fields with wrong types', () => {
    const meta = parseAttachmentMeta(JSON.stringify({
      url: 123,
      name: true,
      type: null,
      size: 'big',
    }));
    // All fields have wrong types, so none should appear
    expect(meta.url).toBeUndefined();
    expect(meta.name).toBeUndefined();
    expect(meta.type).toBeUndefined();
    expect(meta.size).toBeUndefined();
  });

  it('handles JSON arrays gracefully', () => {
    const meta = parseAttachmentMeta('["a", "b"]');
    expect(meta).toEqual({});
  });

  it('handles JSON primitives gracefully', () => {
    expect(parseAttachmentMeta('"just a string"')).toEqual({});
    expect(parseAttachmentMeta('42')).toEqual({});
    expect(parseAttachmentMeta('true')).toEqual({});
    expect(parseAttachmentMeta('null')).toEqual({});
  });

  it('returns {} for null parsed result', () => {
    // JSON.parse('null') returns null, which is falsy
    expect(parseAttachmentMeta('null')).toEqual({});
  });
});
