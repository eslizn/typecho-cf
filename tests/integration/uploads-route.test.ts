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

    const res = await GET({
      params: { path: '2026/05/icon.svg' },
      locals: {},
      request: new Request('https://example.com/usr/uploads/2026/05/icon.svg'),
    } as any);

    expect(res.status).toBe(200);
    expect(mockBucketGet).toHaveBeenCalledWith('usr/uploads/2026/05/icon.svg');
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(res.headers.get('Content-Disposition')).toBe('attachment');
  });

  it('forces Content-Disposition: attachment for SVG even if metadata is missing (G5-6)', async () => {
    mockBucketGet.mockResolvedValue({
      body: bodyStream('<svg></svg>'),
      httpEtag: '"svg-etag"',
      httpMetadata: { contentType: 'image/svg+xml' },
    });
    const res = await GET({
      params: { path: 'legacy.svg' },
      locals: {},
      request: new Request('https://example.com/usr/uploads/legacy.svg'),
    } as any);
    expect(res.headers.get('Content-Disposition')).toBe('attachment');
  });

  it('attaches the strict upload CSP and CORP same-origin (G5-6)', async () => {
    mockBucketGet.mockResolvedValue({
      body: bodyStream('binary'),
      httpEtag: '"e"',
      httpMetadata: { contentType: 'image/png' },
    });
    const res = await GET({
      params: { path: 'a.png' },
      locals: {},
      request: new Request('https://example.com/usr/uploads/a.png'),
    } as any);
    expect(res.headers.get('Content-Security-Policy') || '').toContain("default-src 'none'");
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });
});
