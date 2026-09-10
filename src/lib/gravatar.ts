export interface GravatarUrlOptions {
  defaultImage?: string;
  size?: number;
  rating?: string;
}

// ─── MD5 ─────────────────────────────────────────────────────────────────────
// Gravatar avatar URLs are keyed by MD5(lowercased, trimmed email): the service
// predates SHA-2 and still only accepts the 32-character MD5 hex digest, so a
// SHA-256 hash silently falls back to the `d=` default image for every user.
// Workers' WebCrypto has no MD5, so RFC 1321 is implemented here. The tables
// are hardcoded rather than derived from Math.sin() so the digest cannot drift
// with a runtime's floating-point implementation.

const MD5_SHIFTS: readonly number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_CONSTANTS: readonly number[] = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

/** MD5 digest of the UTF-8 bytes of `input`, lowercase hex. */
export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  // Padding: 0x80, then zeros, then the 64-bit little-endian bit length.
  const paddedLength = (((bytes.length + 8) >> 6) + 1) * 64;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 4_294_967_296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const words = new Uint32Array(16);

  for (let chunk = 0; chunk < paddedLength; chunk += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(chunk + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + MD5_CONSTANTS[i] + words[g]) | 0;
      const rotated = (sum << MD5_SHIFTS[i]) | (sum >>> (32 - MD5_SHIFTS[i]));
      const previousD = d;
      d = c;
      c = b;
      b = (b + rotated) | 0;
      a = previousD;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const digest = new Uint8Array(16);
  const digestView = new DataView(digest.buffer);
  digestView.setUint32(0, a0 >>> 0, true);
  digestView.setUint32(4, b0 >>> 0, true);
  digestView.setUint32(8, c0 >>> 0, true);
  digestView.setUint32(12, d0 >>> 0, true);
  return Array.from(digest).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createGravatarHash(email: string): Promise<string> {
  return md5Hex(email.trim().toLowerCase());
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
