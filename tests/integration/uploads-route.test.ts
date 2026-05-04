/**
 * Integration tests for public upload serving route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockBucketGet } = vi.hoisted(() => ({
  mockBucketGet: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({
  env: {
    BUCKET: { get: mockBucketGet },
  },
}));

import { GET } from '@/pages/usr/uploads/[...path]';

function bodyStream(text: string) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe('GET /usr/uploads/[...path]', () => {
  beforeEach(() => {
    mockBucketGet.mockReset();
  });

  it('preserves Content-Disposition metadata for SVG downloads', async () => {
    mockBucketGet.mockResolvedValue({
      body: bodyStream('<svg></svg>'),
      httpEtag: '"svg-etag"',
      httpMetadata: {
        contentType: 'image/svg+xml',
        contentDisposition: 'attachment',
      },
    });

    const res = await GET({ params: { path: '2026/05/icon.svg' }, locals: {} } as any);

    expect(res.status).toBe(200);
    expect(mockBucketGet).toHaveBeenCalledWith('usr/uploads/2026/05/icon.svg');
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(res.headers.get('Content-Disposition')).toBe('attachment');
  });
});
