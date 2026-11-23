import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TASK_QUEUE_CAPABILITY, TASK_QUEUE_CAPABILITY_VERSION, type PluginInitContext } from 'typecho/plugin-sdk';
import { DEFAULT_QUEUE_PROVIDER_ID } from '@/lib/default-queue-provider';
import { createTaskEnvelope } from '@/lib/tasks/envelope';
import { MAX_QUEUE_BATCH_BYTES, MAX_QUEUE_BATCH_SIZE, MAX_QUEUE_DELAY_SECONDS } from './binding';
import init, { createCloudflareTaskQueue } from './index';

function task(payload: unknown = { cid: 123 }) {
  return createTaskEnvelope({
    pluginId: 'sample',
    taskId: 'publish',
    source: 'request',
    kind: 'async',
    payload,
    idempotencyKey: 'post:123',
    scheduledAt: 123,
    enqueuedAt: 123,
  });
}

function fixture() {
  const send = vi.fn(async (_envelope: unknown, _options?: QueueSendOptions) => {});
  const sendBatch = vi.fn(async (_batch: readonly MessageSendRequest[]) => {});
  const metrics = vi.fn(async () => ({ backlogCount: 2, backlogBytes: 512 }));
  const service = createCloudflareTaskQueue(
    { QUEUE: { send, sendBatch, metrics } },
    { queueName: 'custom' },
  );
  return { service, send, sendBatch, metrics };
}

// The provider constructs its handle only through the owner-scoped loader.
describe('Cloudflare task queue provider', () => {
  it('keeps the manifest id aligned with the core default provider id', () => {
    const manifest = JSON.parse(readFileSync(
      join(process.cwd(), 'src/plugins/typecho-plugin-queue/package.json'),
      'utf8',
    )) as { name?: string; typecho?: { plugin?: { id?: string } } };

    expect(manifest.name).toBe(DEFAULT_QUEUE_PROVIDER_ID);
    expect(manifest.typecho?.plugin?.id).toBe(DEFAULT_QUEUE_PROVIDER_ID);
  });

  it('registers the versioned capability for both HTTP and background invocations', () => {
    const registerCapability = vi.fn();
    init({ registerCapability } as unknown as PluginInitContext);
    expect(registerCapability).toHaveBeenCalledWith({
      capability: TASK_QUEUE_CAPABILITY,
      version: TASK_QUEUE_CAPABILITY_VERSION,
      scope: 'any',
      factory: expect.any(Function),
    });
  });

  it('registers the plugin name, description, and config translations', () => {
    const registerTranslations = vi.fn();
    init({
      registerCapability: vi.fn(),
      registerTranslations,
    } as unknown as PluginInitContext);

    expect(registerTranslations).toHaveBeenCalledWith('en', expect.objectContaining({
      'plugin.typecho-plugin-queue.name': 'Queue',
      'plugin.typecho-plugin-queue.description': expect.any(String),
      'plugin.typecho-plugin-queue.config.queueName.label': expect.any(String),
    }));
    expect(registerTranslations).toHaveBeenCalledWith('zh-CN', expect.objectContaining({
      'plugin.typecho-plugin-queue.name': 'Queue',
      'plugin.typecho-plugin-queue.description': expect.any(String),
      'plugin.typecho-plugin-queue.config.apiToken.label': expect.any(String),
    }));
  });

  it('reports initialization failure if the host cannot register capabilities', () => {
    expect(() => init({} as PluginInitContext)).toThrow('does not provide generic capability registration');
  });

  it('awaits a native JSON send and preserves explicit zero delay', async () => {
    const { service, send } = fixture();
    const envelope = task();
    expect(service.isAvailable).toBe(true);
    await service.send(envelope, 0);
    await service.send(envelope, MAX_QUEUE_DELAY_SECONDS);
    await service.send(envelope);
    expect(send.mock.calls).toEqual([
      [envelope, { contentType: 'json', delaySeconds: 0 }],
      [envelope, { contentType: 'json', delaySeconds: MAX_QUEUE_DELAY_SECONDS }],
      [envelope, { contentType: 'json' }],
    ]);
    send.mockRejectedValueOnce(new Error('transport failed'));
    await expect(service.send(envelope)).rejects.toThrow('transport failed');
  });

  it('rejects out-of-range delays without invoking the binding', async () => {
    const { service, send } = fixture();
    const envelope = task();
    await expect(service.send(envelope, MAX_QUEUE_DELAY_SECONDS + 1)).rejects.toThrow(RangeError);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports unavailable when there is no producer binding', async () => {
    const service = createCloudflareTaskQueue({}, {});
    expect(service.isAvailable).toBe(false);
    await expect(service.send(task())).rejects.toThrow('binding is unavailable');
  });

  it('splits sends by message count', async () => {
    const { service, sendBatch } = fixture();
    const envelopes = Array.from({ length: MAX_QUEUE_BATCH_SIZE + 1 }, () => task());
    await service.sendBatch(envelopes);
    expect(sendBatch.mock.calls.map(([batch]) => batch.length)).toEqual([MAX_QUEUE_BATCH_SIZE, 1]);
    expect(sendBatch.mock.calls.flatMap(([batch]) => batch.map(message => message.body))).toEqual(envelopes);
  });

  it('splits large payload batches by UTF-8 byte length', async () => {
    const { service, sendBatch } = fixture();
    const envelopes = Array.from({ length: 9 }, () => task({ text: '字'.repeat(10_000) }));
    await service.sendBatch(envelopes);
    expect(sendBatch.mock.calls.map(([batch]) => batch.length)).toEqual([8, 1]);
    for (const [batch] of sendBatch.mock.calls) {
      expect(new TextEncoder().encode(JSON.stringify(batch)).byteLength).toBeLessThan(MAX_QUEUE_BATCH_BYTES);
    }
  });

  it('keeps queue state and metric access within the provider', async () => {
    const { service, metrics } = fixture();
    const dashboard = await service.getDashboardSnapshot?.();
    expect(metrics).toHaveBeenCalledOnce();
    expect(dashboard?.queues[0]).toMatchObject({
      name: 'custom',
      metricsSource: 'binding',
      metrics: { backlogCount: 2, backlogBytes: 512 },
    });
  });
});
