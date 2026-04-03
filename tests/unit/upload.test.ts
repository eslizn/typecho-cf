/**
 * Unit tests for src/lib/upload.ts
 *
 * Tests MIME type validation from extension (not client-provided type),
 * dangerous extension rejection, filename sanitization, and upload path generation.
 */
import { describe, it, expect } from 'vitest';
import {
  getMimeTypeFromExtension,
  isAllowedType,
  generateUploadPath,
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
// generateUploadPath — sanitizeFilename is tested indirectly
// ---------------------------------------------------------------------------
describe('generateUploadPath()', () => {
  it('generates path in year/month format', () => {
    const date = new Date('2026-03-15');
    const path = generateUploadPath('photo.jpg', date);
    expect(path).toMatch(/^usr\/uploads\/2026\/03\//);
    expect(path).toContain('.jpg');
  });

  it('sanitizes filename (removes special chars)', () => {
    const date = new Date('2026-01-01');
    const path = generateUploadPath('hello world!@#$%.jpg', date);
    expect(path).toMatch(/^usr\/uploads\/2026\/01\//);
    expect(path).toContain('.jpg');
    // Should not contain special characters (only alnum, _, -, Chinese)
    const filename = path.split('/').pop()!;
    expect(filename).toMatch(/^[a-zA-Z0-9_\-\u4e00-\u9fff]+_[a-z0-9]+\.jpg$/);
  });

  it('preserves Chinese characters in filename', () => {
    const date = new Date('2026-01-01');
    const path = generateUploadPath('你好世界.png', date);
    expect(path).toContain('你好世界');
    expect(path).toContain('.png');
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

  it('adds timestamp suffix to avoid collisions', () => {
    const date = new Date('2026-01-01');
    const path1 = generateUploadPath('test.jpg', date);
    const path2 = generateUploadPath('test.jpg', date);
    // Filenames should contain a timestamp and may differ
    expect(path1).toMatch(/test_[a-z0-9]+\.jpg$/);
    expect(path2).toMatch(/test_[a-z0-9]+\.jpg$/);
  });

  it('lowercases the extension', () => {
    const date = new Date('2026-01-01');
    const path = generateUploadPath('PHOTO.JPG', date);
    expect(path).toMatch(/\.jpg$/);
  });
});
