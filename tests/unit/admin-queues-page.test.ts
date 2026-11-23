import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';
import type { CapabilityRuntimeContext } from '@/lib/capability';
import { isTaskQueueDashboardEnabled, readTaskQueueDashboard } from '@/lib/tasks/queue-dashboard';
import { resolveTaskQueue } from '@/lib/tasks/queue';

vi.mock('@/lib/tasks/queue', () => ({ resolveTaskQueue: vi.fn() }));

describe('admin Queue page wiring', () => {
  it('keeps the first version read-only and does not expose message mutation controls', () => {
    const observability = readFileSync(join(process.cwd(), 'src/plugins/typecho-plugin-queue/observability.ts'), 'utf8');

    expect(observability).not.toContain('/messages/pull');
    expect(observability).not.toContain('/messages/peek');
    expect(observability).not.toContain('/purge');
    expect(observability).not.toContain('DLQ');
  });

  it('keeps the single Queue aligned with the Wrangler resource', () => {
    const { rawConfig: config } = experimental_readRawConfig({ config: join(process.cwd(), 'wrangler.jsonc') });

    expect(config.vars).toBeUndefined();
    expect(config.queues?.producers).toEqual([{ binding: 'QUEUE', queue: 'typecho-cf-tasks' }]);
    expect(config.queues?.consumers).toHaveLength(1);
    expect(config.queues?.consumers?.[0]?.queue).toBe(config.queues?.producers?.[0]?.queue);
    expect(config.queues?.consumers?.[0]).not.toHaveProperty('dead_letter_queue');
  });
});


describe('admin Queue dashboard status', () => {
  const runtime = {} as CapabilityRuntimeContext;
  const providerId = 'typecho-plugin-queue';
  const defaultProvider = { requested: true, initializationFailed: false };

  it('exposes the page only when a provider is requested or registered', () => {
    expect(isTaskQueueDashboardEnabled(undefined, { requested: false })).toBe(false);
    expect(isTaskQueueDashboardEnabled(undefined, { requested: true })).toBe(true);

    vi.mocked(resolveTaskQueue).mockReturnValueOnce({
      ok: false, capability: 'tasks.queue', reason: 'unavailable',
    });
    expect(isTaskQueueDashboardEnabled(runtime, { requested: false })).toBe(false);

    vi.mocked(resolveTaskQueue).mockReturnValueOnce({
      ok: false,
      capability: 'tasks.queue',
      reason: 'unavailable',
      candidates: [{ ownerPluginId: providerId, version: 1 }],
    });
    expect(isTaskQueueDashboardEnabled(runtime, { requested: false })).toBe(true);

    vi.mocked(resolveTaskQueue).mockReturnValueOnce({
      ok: true,
      ownerPluginId: providerId,
      version: 1,
      backgroundAvailable: true,
      value: { isAvailable: true, send: vi.fn(), sendBatch: vi.fn() },
    });
    expect(isTaskQueueDashboardEnabled(runtime, { requested: false })).toBe(true);
  });

  it('distinguishes the disabled provider from a deployment without a queue', async () => {
    vi.mocked(resolveTaskQueue).mockReturnValueOnce({ ok: false, capability: 'tasks.queue', reason: 'unavailable' });
    expect(await readTaskQueueDashboard(runtime, { ...defaultProvider, requested: false }))
      .toEqual({ state: 'disabled', snapshot: null });

    vi.mocked(resolveTaskQueue).mockReturnValueOnce({
      ok: false,
      capability: 'tasks.queue',
      reason: 'unavailable',
      candidates: [{ ownerPluginId: providerId, version: 1 }],
    });
    expect(await readTaskQueueDashboard(runtime, defaultProvider))
      .toEqual({ state: 'unavailable', snapshot: null });
  });

  it('reports an initialization failure and multiple compatible providers', async () => {
    vi.mocked(resolveTaskQueue).mockReturnValueOnce({ ok: false, capability: 'tasks.queue', reason: 'unavailable' });
    expect((await readTaskQueueDashboard(runtime, { ...defaultProvider, initializationFailed: true })).state)
      .toBe('initialization-failed');

    vi.mocked(resolveTaskQueue).mockReturnValueOnce({ ok: false, capability: 'tasks.queue', reason: 'ambiguous' });
    expect((await readTaskQueueDashboard(runtime, defaultProvider)).state).toBe('ambiguous');
  });

  it('preserves transport availability when the read-only snapshot fails', async () => {
    vi.mocked(resolveTaskQueue).mockReturnValueOnce({
      ok: true,
      ownerPluginId: providerId,
      version: 1,
      backgroundAvailable: true,
      value: {
        isAvailable: true,
        send: vi.fn(),
        sendBatch: vi.fn(),
        getDashboardSnapshot: vi.fn().mockRejectedValueOnce(new Error('monitoring failed')),
      },
    });
    expect(await readTaskQueueDashboard(runtime, defaultProvider)).toEqual({ state: 'available', snapshot: null });
  });

  it('discards a provider snapshot that does not match the dashboard contract', async () => {
    vi.mocked(resolveTaskQueue).mockReturnValueOnce({
      ok: true,
      ownerPluginId: providerId,
      version: 1,
      backgroundAvailable: true,
      value: {
        isAvailable: true,
        send: vi.fn(),
        sendBatch: vi.fn(),
        getDashboardSnapshot: vi.fn().mockResolvedValueOnce({ queues: 'not-an-array', api: null }),
      },
    });
    expect(await readTaskQueueDashboard(runtime, defaultProvider)).toEqual({ state: 'available', snapshot: null });
  });
});
