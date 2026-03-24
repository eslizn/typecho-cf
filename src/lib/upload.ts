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
 * Check if a MIME type is allowed
 * attachmentTypes format: "@image@" means only images, "@image@file@" means images and files
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
 * Upload a file to R2
 */
export async function uploadToR2(
  bucket: R2Bucket,
  file: File,
  siteUrl: string,
  attachmentTypes: string
): Promise<UploadResult> {
  if (!isAllowedType(file.type, attachmentTypes)) {
    throw new Error(`不允许上传此类型的文件: ${file.type}`);
  }

  const maxSize = 10 * 1024 * 1024; // 10MB
  if (file.size > maxSize) {
    throw new Error('文件大小超出限制 (最大 10MB)');
  }

  const path = generateUploadPath(file.name);
  const arrayBuffer = await file.arrayBuffer();

  await bucket.put(path, arrayBuffer, {
    httpMetadata: {
      contentType: file.type,
    },
  });

  return {
    name: file.name,
    path,
    size: file.size,
    type: file.type,
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

function sanitizeFilename(name: string): string {
  // Remove path separators and special chars
  const ext = name.lastIndexOf('.') >= 0 ? name.substring(name.lastIndexOf('.')) : '';
  const base = name.substring(0, name.lastIndexOf('.') >= 0 ? name.lastIndexOf('.') : name.length);
  const safe = base.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_').substring(0, 100);
  // Add timestamp to avoid conflicts
  const ts = Date.now().toString(36);
  return `${safe}_${ts}${ext.toLowerCase()}`;
}
