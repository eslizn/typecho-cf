export interface AttachmentMeta {
  url?: string;
  name?: string;
  type?: string;
  size?: number;
}

/**
 * Safely parse attachment metadata from the contents.text JSON field.
 * Returns an object with typed optional fields (url, name, type, size).
 * Never throws — returns {} on parse failure.
 */
export function parseAttachmentMeta(text: string | null | undefined): AttachmentMeta {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return {};
    const result: AttachmentMeta = {};
    if (typeof parsed.url === 'string') result.url = parsed.url;
    if (typeof parsed.name === 'string') result.name = parsed.name;
    if (typeof parsed.type === 'string') result.type = parsed.type;
    if (typeof parsed.size === 'number') result.size = parsed.size;
    return result;
  } catch {
    return {};
  }
}
