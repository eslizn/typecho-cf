/**
 * Unit tests for src/lib/upload.ts
 *
 * Tests MIME type validation from extension (not client-provided type),
 * dangerous extension rejection, filename sanitization, and upload path generation.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  getMimeTypeFromExtension,
  isAllowedType,
  generateUploadPath,
  sanitizeUploadName,
  uploadToR2,
} from '@/lib/upload';

// ---------------------------------------------------------------------------
// getMimeTypeFromExtension — MIME derived from extension, not client
// ---------------------------------------------------------------------------
describe('getMimeTypeFromExtension()', () => {
  it('returns image/jpeg for .jpg', () => {
    expect(getMimeTypeFromExtension('photo.jpg')).toBe('image/jpeg');
  });

  it('returns image/jpeg for .jpeg', () => {
    expect(getMimeTypeFromExtension('photo.jpeg')).toBe('image/jpeg');
  });

  it('returns image/png for .png', () => {
    expect(getMimeTypeFromExtension('screenshot.png')).toBe('image/png');
  });

  it('returns image/gif for .gif', () => {
    expect(getMimeTypeFromExtension('animation.gif')).toBe('image/gif');
  });

  it('returns image/webp for .webp', () => {
    expect(getMimeTypeFromExtension('photo.webp')).toBe('image/webp');
  });

  it('returns image/svg+xml for .svg', () => {
    expect(getMimeTypeFromExtension('icon.svg')).toBe('image/svg+xml');
  });

  it('returns application/pdf for .pdf', () => {
    expect(getMimeTypeFromExtension('doc.pdf')).toBe('application/pdf');
  });

  it('returns application/zip for .zip', () => {
    expect(getMimeTypeFromExtension('archive.zip')).toBe('application/zip');
  });

  it('is case-insensitive for extensions', () => {
    expect(getMimeTypeFromExtension('PHOTO.JPG')).toBe('image/jpeg');
    expect(getMimeTypeFromExtension('Doc.PDF')).toBe('application/pdf');
    expect(getMimeTypeFromExtension('file.PNG')).toBe('image/png');
  });

  it('returns undefined for unknown extensions', () => {
    expect(getMimeTypeFromExtension('file.unknown')).toBeUndefined();
    expect(getMimeTypeFromExtension('file.xyz')).toBeUndefined();
  });

  it('returns undefined for files with no extension', () => {
    expect(getMimeTypeFromExtension('noextension')).toBeUndefined();
  });

  it('returns undefined for dangerous extensions like .html', () => {
    // .html is not in EXTENSION_TO_MIME even though it could be
    expect(getMimeTypeFromExtension('page.html')).toBeUndefined();
  });

  it('returns undefined for .js files', () => {
    expect(getMimeTypeFromExtension('script.js')).toBeUndefined();
  });

  it('returns undefined for .php files', () => {
    expect(getMimeTypeFromExtension('index.php')).toBeUndefined();
  });

  it('returns undefined for .exe files', () => {
    expect(getMimeTypeFromExtension('virus.exe')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isAllowedType
// ---------------------------------------------------------------------------
describe('isAllowedType()', () => {
  it('allows image/jpeg when attachmentTypes includes @image@', () => {
    expect(isAllowedType('image/jpeg', '@image@')).toBe(true);
  });

  it('allows image/png when attachmentTypes includes @image@', () => {
    expect(isAllowedType('image/png', '@image@')).toBe(true);
  });

  it('allows application/pdf when attachmentTypes includes @file@', () => {
    expect(isAllowedType('application/pdf', '@file@')).toBe(true);
  });

  it('rejects application/pdf when only @image@ is allowed', () => {
    expect(isAllowedType('application/pdf', '@image@')).toBe(false);
  });

  it('allows both images and files when @image@file@ is set', () => {
    expect(isAllowedType('image/jpeg', '@image@file@')).toBe(true);
    expect(isAllowedType('application/pdf', '@image@file@')).toBe(true);
  });

  it('rejects unknown MIME types', () => {
    expect(isAllowedType('application/x-custom', '@image@file@')).toBe(false);
  });

  it('rejects text/html always', () => {
    expect(isAllowedType('text/html', '@image@file@')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sanitizeUploadName
// ---------------------------------------------------------------------------
describe('sanitizeUploadName()', () => {
  it('strips quotes and angle brackets', () => {
    expect(sanitizeUploadName('a"b<c>.jpg')).toBe('abc.jpg');
  });

  it('normalizes Windows separators and keeps only the basename', () => {
    expect(sanitizeUploadName('C:\\Photos\\trip.jpg')).toBe('trip.jpg');
    expect(sanitizeUploadName('../../etc/passwd.png')).toBe('passwd.png');
  });

  it('preserves Unicode display names', () => {
    expect(sanitizeUploadName('你好 世界.png')).toBe('你好 世界.png');
  });
});

// ---------------------------------------------------------------------------
// generateUploadPath — Typecho-compatible numeric storage names
// ---------------------------------------------------------------------------
describe('generateUploadPath()', () => {
  const date = new Date('2026-03-15');

  it('generates path in year/month format with a numeric name', () => {
    const path = generateUploadPath('photo.jpg', date, 'seed');
    expect(path).toMatch(/^usr\/uploads\/2026\/03\/\d+\.jpg$/);
  });

  it('is deterministic for the same seed and varies across seeds', () => {
    const first = generateUploadPath('photo.jpg', date, 'seed-a');
    const second = generateUploadPath('photo.jpg', date, 'seed-a');
    const other = generateUploadPath('photo.jpg', date, 'seed-b');
    expect(first).toBe(second);
    expect(first).not.toBe(other);
  });

  it('does not embed the original filename in the storage path', () => {
    const path = generateUploadPath('hello world!@#$%.jpg', date, 'seed');
    expect(path.split('/').pop()).toMatch(/^\d+\.jpg$/);
  });

  it('keeps Chinese display names out of the path', () => {
    const path = generateUploadPath('你好世界.png', date, 'seed');
    expect(path).toMatch(/\/\d+\.png$/);
  });

  it('throws for empty filename', () => {
    expect(() => generateUploadPath('')).toThrow();
  });

  it('throws for extension-only filename', () => {
    expect(() => generateUploadPath('.jpg')).toThrow();
  });

  it('throws for dangerous extensions like .html', () => {
    expect(() => generateUploadPath('evil.html')).toThrow('扩展名');
  });

  it('throws for .js extension', () => {
    expect(() => generateUploadPath('script.js')).toThrow('扩展名');
  });

  it('throws for .php extension', () => {
    expect(() => generateUploadPath('index.php')).toThrow('扩展名');
  });

  it('throws for .exe extension', () => {
    expect(() => generateUploadPath('virus.exe')).toThrow('扩展名');
  });

  it('throws for unknown extensions', () => {
    expect(() => generateUploadPath('file.xyz')).toThrow('扩展名');
  });

  it('lowercases the extension', () => {
    const path = generateUploadPath('PHOTO.JPG', date, 'seed');
    expect(path).toMatch(/\.jpg$/);
  });
});

// ---------------------------------------------------------------------------
// uploadToR2 — generated-name collision handling and display name
// ---------------------------------------------------------------------------
describe('uploadToR2()', () => {
  it('retries when the generated key already exists and keeps the display name', async () => {
    const head = vi.fn()
      .mockResolvedValueOnce({ key: 'taken' })
      .mockResolvedValueOnce(null);
    const put = vi.fn(async () => undefined);
    const file = new File([new Uint8Array([1, 2, 3])], '../photo"<1>.jpg', { type: 'image/jpeg' });

    const result = await uploadToR2(
      { head, put } as unknown as R2Bucket,
      file,
      'https://example.com/',
      '@image@',
    );

    expect(head).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
    expect(result.name).toBe('photo1.jpg');
    expect(result.path).toMatch(/^usr\/uploads\/\d{4}\/\d{2}\/\d+\.jpg$/);
    expect(result.url).toBe(`https://example.com/${result.path}`);
    expect((put.mock.calls[0] as unknown as [string])[0]).toBe(result.path);
  });
});
