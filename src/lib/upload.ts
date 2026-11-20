import { REQUEST_BODY_LIMITS } from '@/lib/constants';

/**
 * File upload utilities - R2 storage integration
 * Corresponds to Typecho's Widget/Upload.php
 */

export interface UploadResult {
  name: string;
  path: string;
  size: number;
  type: string;
  url: string;
}

export type UploadErrorCode =
  | 'extension_unknown'
  | 'type_not_allowed'
  | 'file_too_large'
  | 'filename_required'
  | 'filename_invalid'
  | 'extension_not_allowed';

export class UploadError extends Error {
  constructor(
    public readonly code: UploadErrorCode,
    public readonly variables: Record<string, string | number>,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/**
 * Mapping from file extension to MIME type.
 * Used to derive the actual MIME type from the filename extension
 * instead of trusting the client-provided `file.type`, which can be spoofed.
 */
const EXTENSION_TO_MIME: Record<string, string> = {
  // Images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  // Documents & archives
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.rar': 'application/x-rar-compressed',
  '.7z': 'application/x-7z-compressed',
  '.txt': 'text/plain',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * Dangerous file extensions that must never be uploaded,
 * regardless of any other configuration.
 */
const DANGEROUS_EXTENSIONS = new Set([
  '.html', '.htm', '.xhtml', '.shtml',
  '.js', '.mjs', '.cjs',
  '.php', '.phtml', '.php3', '.php4', '.php5',
  '.exe', '.bat', '.cmd', '.com', '.msi',
  '.sh', '.bash', '.csh',
  '.jsp', '.asp', '.aspx',
  '.py', '.pl', '.rb', '.cgi',
]);

const ALLOWED_TYPES: Record<string, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/avif'],
  file: [
    'application/pdf',
    'application/zip',
    'application/x-rar-compressed',
    'application/x-7z-compressed',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
};

/**
 * Derive the MIME type from a filename's extension.
 * Returns `undefined` if the extension is not recognized.
 *
 * We intentionally do NOT trust the client-provided `file.type` because
 * it can be trivially spoofed by an attacker.
 */
export function getMimeTypeFromExtension(filename: string): string | undefined {
  const ext = getExtension(filename);
  return ext ? EXTENSION_TO_MIME[ext] : undefined;
}

/**
 * Extract the lowercased extension (including the dot) from a filename.
 * Returns an empty string if there is no extension.
 */
function getExtension(filename: string): string {
  const dotIdx = filename.lastIndexOf('.');
  return dotIdx >= 0 ? filename.substring(dotIdx).toLowerCase() : '';
}

/**
 * Check if a MIME type is allowed.
 * attachmentTypes format: "@image@" means only images, "@image@file@" means images and files.
 */
export function isAllowedType(mimeType: string, attachmentTypes: string): boolean {
  const types = attachmentTypes.split('@').filter(Boolean);
  for (const t of types) {
    const allowed = ALLOWED_TYPES[t];
    if (allowed && allowed.includes(mimeType)) {
      return true;
    }
  }
  return false;
}

/**
 * Generate upload path based on date, using Typecho's filename scheme:
 * `usr/uploads/YYYY/MM/<unsigned crc32>.<ext>`.
 *
 * The original filename is kept only as the attachment's display name;
 * storing it in the path would keep changing the public URL and leak
 * user-supplied characters into storage keys.
 *
 * An explicit seed makes the generated name deterministic for tests.
 */
export function generateUploadPath(
  filename: string,
  date = new Date(),
  seed = newUploadSeed(),
): string {
  const { ext } = validateUploadName(filename);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `usr/uploads/${year}/${month}/${crc32(seed)}.${ext.slice(1)}`;
}

/**
 * Upload a file to R2.
 *
 * Security notes:
 * - MIME type is derived from the file extension, NOT from the client-supplied `file.type`.
 * - SVG files are served with `Content-Disposition: attachment` to mitigate stored XSS,
 *   because SVGs can contain embedded `<script>` tags and event handlers.
 * - Dangerous executable extensions are rejected by `validateUploadName`.
 */
export async function uploadToR2(
  bucket: R2Bucket,
  file: File,
  siteUrl: string,
  attachmentTypes: string
): Promise<UploadResult> {
  const { displayName, ext } = validateUploadName(file.name);
  const mimeType = EXTENSION_TO_MIME[ext]!;
  if (!isAllowedType(mimeType, attachmentTypes)) {
    throw new UploadError('type_not_allowed', { type: mimeType }, `不允许上传此类型的文件: ${mimeType}`);
  }

  if (file.size > REQUEST_BODY_LIMITS.uploadFile) {
    throw new UploadError('file_too_large', {}, '文件大小超出限制 (最大 10MB)');
  }

  // The generated name is random, but never overwrite an existing object if
  // two uploads happen to collide.
  let path = generateUploadPath(displayName);
  for (let attempt = 0; await bucket.head(path); attempt++) {
    if (attempt >= 4) throw new Error('Unable to allocate a unique upload path');
    path = generateUploadPath(displayName);
  }

  // SVG XSS protection: force download instead of inline rendering.
  // SVGs can contain <script>, onload handlers, and other XSS vectors;
  // serving them as attachments prevents the browser from executing embedded scripts.
  const isSvg = mimeType === 'image/svg+xml';

  await bucket.put(path, file.stream(), {
    httpMetadata: {
      contentType: mimeType,
      ...(isSvg && { contentDisposition: 'attachment' }),
    },
  });

  return {
    name: displayName,
    path,
    size: file.size,
    type: mimeType,
    url: `${siteUrl.replace(/\/$/, '')}/${path}`,
  };
}

/**
 * Delete a file from R2
 */
export async function deleteFromR2(bucket: R2Bucket, path: string): Promise<void> {
  await bucket.delete(path);
}

/**
 * Get a file from R2
 */
export async function getFromR2(bucket: R2Bucket, path: string): Promise<R2ObjectBody | null> {
  return await bucket.get(path);
}

/**
 * Sanitize a user-supplied filename for display.
 *
 * Mirrors Typecho's `Widget\Upload::getSafeName()`: quotes and angle brackets
 * are removed, Windows separators are normalized, and only the basename is
 * kept. The result is stored as the attachment title; it never becomes part
 * of the storage key.
 */
export function sanitizeUploadName(name: string): string {
  const cleaned = name.replace(/["<>]/g, '').replace(/\\/g, '/');
  return cleaned.split('/').pop() ?? '';
}

/**
 * Validate the original filename and split it into its display name and
 * lowercased extension.
 *
 * @throws {UploadError} When the name is empty, extension-only, has a
 *         dangerous executable extension, or has an unrecognized extension.
 */
function validateUploadName(name: string): { displayName: string; ext: string } {
  const displayName = sanitizeUploadName(name);
  const ext = getExtension(displayName);
  const dotIdx = displayName.lastIndexOf('.');
  const base = dotIdx >= 0 ? displayName.substring(0, dotIdx) : displayName;

  if (!name || !name.trim() || !displayName.trim()) {
    throw new UploadError('filename_required', {}, '文件名不能为空');
  }

  // Reject extension-only filenames (e.g. ".jpg" with no base name)
  if (!base.trim() || base === '_') {
    throw new UploadError('filename_invalid', {}, '文件名无效 (不能仅为扩展名)');
  }

  // Reject dangerous executable extensions
  if (DANGEROUS_EXTENSIONS.has(ext)) {
    throw new UploadError('extension_not_allowed', { extension: ext }, `不允许上传此扩展名的文件: ${ext}`);
  }

  // Reject unrecognized extensions (must be in the allowlist)
  if (!ext || !EXTENSION_TO_MIME[ext]) {
    throw new UploadError('extension_unknown', { name: ext || '(none)' }, `无法识别的文件扩展名: ${ext || '(无)'}`);
  }

  return { displayName, ext };
}

// CRC-32 (IEEE 802.3), matching PHP's crc32() used by Typecho for file names.
const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[index] = value >>> 0;
}

function crc32(input: string): number {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(input)) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function newUploadSeed(): string {
  return `${Date.now()}-${Math.random()}-${crypto.randomUUID()}`;
}
