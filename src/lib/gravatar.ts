export interface GravatarUrlOptions {
  defaultImage?: string;
  size?: number;
  rating?: string;
}

export async function createGravatarHash(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.trim().toLowerCase());
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function buildGravatarUrl(
  email: string | null | undefined,
  { defaultImage = 'identicon', size = 40, rating }: GravatarUrlOptions = {},
): Promise<string> {
  const hash = email ? await createGravatarHash(email) : '';
  const params = new URLSearchParams();
  params.set('d', defaultImage);
  params.set('s', String(size));
  if (rating) params.set('r', rating);
  return `https://www.gravatar.com/avatar/${hash}?${params.toString()}`;
}
