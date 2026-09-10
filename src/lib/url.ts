export function normalizeHttpUrl(value: string): string | null {
  const raw = value.trim();
  // Empty and invalid input both mean "no usable URL"; returning '' for one
  // and null for the other invites a future caller to treat '' as valid.
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}
