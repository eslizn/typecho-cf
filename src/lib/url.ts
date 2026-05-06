export function normalizeHttpUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}
