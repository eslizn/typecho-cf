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
 * Generate upload path based on date
 * e.g., /usr/uploads/2024/03/filename.jpg
 */
export function generateUploadPath(filename: string, date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const safeName = sanitizeFilename(filename);
  return `usr/uploads/${year}/${month}/${safeName}`;
}

/**
 * Upload a file to R2.
 *
 * Security notes:
 * - MIME type is derived from the file extension, NOT from the client-supplied `file.type`.
 * - SVG files are served with `Content-Disposition: attachment` to mitigate stored XSS,
 *   because SVGs can contain embedded `<script>` tags and event handlers.
 * - Dangerous executable extensions are rejected by `sanitizeFilename`.
 */
export async function uploadToR2(
  bucket: R2Bucket,
  file: File,
  siteUrl: string,
  attachmentTypes: string
): Promise<UploadResult> {
  // Derive MIME type from extension — never trust client-provided file.type
  const mimeType = getMimeTypeFromExtension(file.name);
  if (!mimeType) {
    throw new Error(`无法识别的文件扩展名: ${file.name}`);
  }

  if (!isAllowedType(mimeType, attachmentTypes)) {
    throw new Error(`不允许上传此类型的文件: ${mimeType}`);
  }

  const maxSize = 10 * 1024 * 1024; // 10MB
  if (file.size > maxSize) {
    throw new Error('文件大小超出限制 (最大 10MB)');
  }

  const path = generateUploadPath(file.name);
  const arrayBuffer = await file.arrayBuffer();

  // SVG XSS protection: force download instead of inline rendering.
  // SVGs can contain <script>, onload handlers, and other XSS vectors;
  // serving them as attachments prevents the browser from executing embedded scripts.
  const isSvg = mimeType === 'image/svg+xml';

  await bucket.put(path, arrayBuffer, {
    httpMetadata: {
      contentType: mimeType,
      ...(isSvg && { contentDisposition: 'attachment' }),
    },
  });

  return {
    name: file.name,
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
 * Sanitize a user-supplied filename for safe storage.
 *
 * - Strips path separators and special characters.
 * - Validates that the base name is non-empty (rejects extension-only names like ".jpg").
 * - Rejects dangerous executable extensions (e.g. .html, .js, .php, .exe).
 * - Validates the extension against the known `EXTENSION_TO_MIME` allowlist.
 * - Appends a timestamp to avoid naming collisions.
 *
 * @throws {Error} If the filename is empty, extension-only, has a dangerous extension,
 *                 or has an unrecognized extension.
 */
function sanitizeFilename(name: string): string {
  const ext = getExtension(name);
  const dotIdx = name.lastIndexOf('.');
  const base = dotIdx >= 0 ? name.substring(0, dotIdx) : name;

  // Reject empty or whitespace-only filenames
  if (!name || !name.trim()) {
    throw new Error('文件名不能为空');
  }

  // Reject extension-only filenames (e.g. ".jpg" with no base name)
  const safe = base.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_').substring(0, 100);
  if (!safe || safe === '_') {
    throw new Error('文件名无效 (不能仅为扩展名)');
  }

  // Reject dangerous executable extensions
  if (DANGEROUS_EXTENSIONS.has(ext)) {
    throw new Error(`不允许上传此扩展名的文件: ${ext}`);
  }

  // Reject unrecognized extensions (must be in the allowlist)
  if (!ext || !EXTENSION_TO_MIME[ext]) {
    throw new Error(`无法识别的文件扩展名: ${ext || '(无)'}`);
  }

  // Add timestamp to avoid conflicts
  const ts = Date.now().toString(36);
  return `${safe}_${ts}${ext}`;
}
