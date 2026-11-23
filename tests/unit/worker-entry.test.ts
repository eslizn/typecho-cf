import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TASK_QUEUE_NAME, MAX_QUEUE_DELAY_SECONDS } from '@/plugins/typecho-plugin-queue/binding';

const mocks = vi.hoisted(() => {
  class TablesMissingError extends Error {}
  const runtime = { initialized: true, options: {} as Record<string, unknown> };
  const registry = { loaded: false };
  const primaryDb = {};
  const db = {};
  return {
    TablesMissingError,
    runtime,
    registry,
    db,
    primaryDb,
    getDb: vi.fn(() => db),
    getPrimaryDb: vi.fn(() => primaryDb),
    ensureTablesReady: vi.fn<() => Promise<void>>(),
    createTaskRuntime: vi.fn(async () => runtime),
    consumeTaskBatch: vi.fn(),
    runScheduledTasks: vi.fn(),
  };
});

vi.mock('@astrojs/cloudflare/handler', () => ({ handle: vi.fn() }));
vi.mock('virtual:typecho-plugin-registry', () => {
  mocks.registry.loaded = true;
  return {};
});
vi.mock('@/db', () => ({ getDb: mocks.getDb, getPrimaryDb: mocks.getPrimaryDb }));
vi.mock('@/lib/isolate-boot', () => ({
  TablesMissingError: mocks.TablesMissingError,
  ensureTablesReady: mocks.ensureTablesReady,
}));
vi.mock('@/lib/tasks/runtime', () => ({
  consumeTaskBatch: mocks.consumeTaskBatch,
  createTaskRuntime: mocks.createTaskRuntime,
}));
vi.mock('@/lib/tasks/scheduler', () => ({ runScheduledTasks: mocks.runScheduledTasks }));

function messageBatch(queue = DEFAULT_TASK_QUEUE_NAME) {
  const message: Message = {
    id: 'message-1',
    timestamp: new Date(123_000),
    body: { jobId: 'job-1' },
    attempts: 2,
    ack: vi.fn(),
    retry: vi.fn(),
  };
  const batch: MessageBatch = {
    queue,
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
    metadata: { metrics: { backlogCount: 1, backlogBytes: 64 } },
  };
  return { batch, message };
}

describe('Worker entry', () => {
  const env = { DB: {} } as Env;
  const context = {} as ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtime.options = {};
  });

  it('exports the fetch, scheduled and queue handlers after loading the virtual registry', async () => {
    const worker = (await import('@/worker')).default;

    expect(mocks.registry.loaded).toBe(true);
    expect(worker.fetch).toBeTypeOf('function');
    expect(worker.scheduled).toBeTypeOf('function');
    expect(worker.queue).toBeTypeOf('function');
  });

  it('applies the one-time provider upgrade before handing the Cron instant to task core', async () => {
    const worker = (await import('@/worker')).default;
    const event = { scheduledTime: 123_000, cron: '* * * * *' } as ScheduledController;
    await worker.scheduled(event, env, context);

    expect(mocks.ensureTablesReady).toHaveBeenCalledWith(env.DB);
    expect(mocks.createTaskRuntime).toHaveBeenCalledWith({ db: mocks.db, primaryDb: mocks.primaryDb, env });
    expect(mocks.runScheduledTasks).toHaveBeenCalledWith(event.scheduledTime, mocks.runtime);
  });

  it('translates Queue deliveries and native retry options for task core', async () => {
    const worker = (await import('@/worker')).default;
    const { batch, message } = messageBatch();
    await worker.queue(batch, env, context);

    expect(mocks.consumeTaskBatch).toHaveBeenCalledWith(
      [expect.objectContaining({ body: message.body, attempts: 2 })],
      'typecho-plugin-queue',
      mocks.runtime,
    );
    const [[delivery]] = mocks.consumeTaskBatch.mock.calls[0];
    delivery.ack();
    delivery.retry({ delaySeconds: 0 });
    delivery.retry({ delaySeconds: MAX_QUEUE_DELAY_SECONDS + 1 });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).toHaveBeenNthCalledWith(1, { delaySeconds: 0 });
    expect(message.retry).toHaveBeenNthCalledWith(2, { delaySeconds: MAX_QUEUE_DELAY_SECONDS });
  });

  it('skips Cron work before the site has been installed', async () => {
    const worker = (await import('@/worker')).default;
    const event = { scheduledTime: 123_000, cron: '* * * * *' } as ScheduledController;
    mocks.ensureTablesReady.mockRejectedValueOnce(new mocks.TablesMissingError());

    await worker.scheduled(event, env, context);

    expect(mocks.createTaskRuntime).not.toHaveBeenCalled();
    expect(mocks.runScheduledTasks).not.toHaveBeenCalled();
  });

  it('retries Queue deliveries before the site has been installed', async () => {
    const worker = (await import('@/worker')).default;
    const { batch } = messageBatch();
    mocks.ensureTablesReady.mockRejectedValueOnce(new mocks.TablesMissingError());

    await worker.queue(batch, env, context);

    expect(batch.retryAll).toHaveBeenCalledOnce();
    expect(vi.mocked(batch.retryAll).mock.calls[0]?.[0]?.delaySeconds).toBeGreaterThan(0);
    expect(mocks.createTaskRuntime).not.toHaveBeenCalled();
    expect(mocks.consumeTaskBatch).not.toHaveBeenCalled();
  });

  it('processes a delivery from a different Queue and warns about the drift', async () => {
    const worker = (await import('@/worker')).default;
    const { batch } = messageBatch('unexpected-queue');
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await worker.queue(batch, env, context);
      expect(consoleWarn).toHaveBeenCalledWith(expect.objectContaining({
        event: 'task.unexpected_queue',
        actual: 'unexpected-queue',
      }));
    } finally {
      consoleWarn.mockRestore();
    }

    expect(batch.retryAll).not.toHaveBeenCalled();
    expect(mocks.consumeTaskBatch).toHaveBeenCalledOnce();
  });

  it('uses the plugin-configured queue name for drift warnings', async () => {
    const worker = (await import('@/worker')).default;
    mocks.runtime.options = {
      'plugin:typecho-plugin-queue': JSON.stringify({ queueName: 'custom-queue' }),
    };
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { batch } = messageBatch('custom-queue');
      await worker.queue(batch, env, context);
      expect(consoleWarn).not.toHaveBeenCalledWith(expect.objectContaining({
        event: 'task.unexpected_queue',
      }));
    } finally {
      consoleWarn.mockRestore();
    }

    expect(mocks.consumeTaskBatch).toHaveBeenCalledOnce();
  });

  it('explicitly retries deliveries when the activation state cannot be loaded', async () => {
    const worker = (await import('@/worker')).default;
    const { batch } = messageBatch();
    mocks.createTaskRuntime.mockRejectedValueOnce(new Error('D1 unavailable'));
    await worker.queue(batch, env, context);

    expect(batch.retryAll).toHaveBeenCalledOnce();
    expect(vi.mocked(batch.retryAll).mock.calls[0]?.[0]?.delaySeconds).toBeGreaterThan(0);
    expect(batch.ackAll).not.toHaveBeenCalled();
    expect(mocks.consumeTaskBatch).not.toHaveBeenCalled();
  });
});
