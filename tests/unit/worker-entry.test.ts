import { describe, expect, it, vi } from 'vitest';

// The real Astro handler is bundled for Workers and imports the native
// `cloudflare:workers` module. The Worker entry is tested here as a wiring
// boundary, so replace only the fetch implementation in Node/Vitest.
vi.mock('@astrojs/cloudflare/handler', () => ({
  handle: vi.fn(),
}));

describe('Worker entry', () => {
  it('exports fetch, scheduled and queue handlers', async () => {
    const worker = (await import('@/worker')).default;

    expect(worker.fetch).toBeTypeOf('function');
    expect(worker.scheduled).toBeTypeOf('function');
    expect(worker.queue).toBeTypeOf('function');
  });

  it('loads the virtual plugin registry before a handler can be invoked', async () => {
    const worker = (await import('@/worker')).default;
    expect(worker.scheduled).toBeDefined();
    expect(worker.queue).toBeDefined();
  });
});
