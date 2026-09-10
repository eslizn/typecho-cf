import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env, _resetTaskQueue } from '../__mocks__/cloudflare-workers';
import { TablesMissingError } from '@/lib/isolate-boot';
import type { TaskRuntime } from '@/lib/tasks/runtime';
import { registerScheduledTask, resetTaskRegistry } from '@/lib/tasks/registry';
import {
  MAX_SCHEDULED_BATCH_BYTES,
  runScheduledTasks,
} from '@/lib/tasks/scheduler';

const { createTaskRuntimeMock, ensureTablesReadyMock } = vi.hoisted(() => ({
  createTaskRuntimeMock: vi.fn(),
  ensureTablesReadyMock: vi.fn(),
}));

vi.mock('@/lib/tasks/runtime', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tasks/runtime')>('@/lib/tasks/runtime');
  return { ...actual, createTaskRuntime: createTaskRuntimeMock };
});

vi.mock('@/lib/isolate-boot', async () => {
  const actual = await vi.importActual<typeof import('@/lib/isolate-boot')>('@/lib/isolate-boot');
  return { ...actual, ensureTablesReady: ensureTablesReadyMock };
});

function makeRuntime(
  timezone: string,
  activePlugins: string[],
  initFailures: TaskRuntime['initFailures'] = {},
): TaskRuntime {
  return {
    env: env as unknown as Cloudflare.Env,
    db: {} as TaskRuntime['db'],
    options: { timezone } as TaskRuntime['options'],
    activatedPlugins: new Set(activePlugins),
    initFailures,
  };
}

function makeContext() {
  return {
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext;
}

function makeController(iso: string): ScheduledController {
  return {
    scheduledTime: Date.parse(iso),
  } as ScheduledController;
}

describe('task scheduler', () => {
  beforeEach(() => {
    resetTaskRegistry();
    _resetTaskQueue();
    createTaskRuntimeMock.mockReset();
    ensureTablesReadyMock.mockReset();
    ensureTablesReadyMock.mockResolvedValue(undefined);
  });

  it('converts the Cron instant through the site timezone across a DST boundary', async () => {
    registerScheduledTask('demo', {
      id: 'after-spring-forward',
      schedule: '30 3 * * *',
      handler: async () => ({ status: 'success' }),
    });
    createTaskRuntimeMock.mockResolvedValue(makeRuntime('America/New_York', ['demo']));
    const context = makeContext();

    await runScheduledTasks(
      makeController('2026-03-08T07:30:00Z'),
      env as unknown as Cloudflare.Env,
      context,
    );

    expect(env.QUEUE.sendBatch).toHaveBeenCalledTimes(1);
    const [messages] = env.QUEUE.sendBatch.mock.calls[0] as [Array<{ body: Record<string, unknown>; contentType: string }>];
    expect(messages[0]).toEqual(expect.objectContaining({ contentType: 'json' }));
    expect(messages[0].body).toEqual(expect.objectContaining({
      localSlot: expect.objectContaining({
        year: 2026,
        month: 3,
        day: 8,
        hour: 3,
        minute: 30,
        timezone: 'America/New_York',
      }),
      scheduledAt: Math.floor(Date.parse('2026-03-08T07:30:00Z') / 1000),
    }));
    expect(context.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('enqueues only tasks matching the current site-local minute', async () => {
    registerScheduledTask('demo', {
      id: 'quarter-hour',
      schedule: '*/15 * * * *',
      handler: async () => ({ status: 'success' }),
    });
    registerScheduledTask('demo', {
      id: 'not-now',
      schedule: '31 * * * *',
      handler: async () => ({ status: 'success' }),
    });
    createTaskRuntimeMock.mockResolvedValue(makeRuntime('Asia/Shanghai', ['demo']));

    await runScheduledTasks(
      makeController('2026-01-15T00:30:00Z'),
      env as unknown as Cloudflare.Env,
      makeContext(),
    );

    expect(env.QUEUE.sendBatch).toHaveBeenCalledTimes(1);
    const [messages] = env.QUEUE.sendBatch.mock.calls[0] as [Array<{ body: Record<string, unknown> }>];
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toEqual(expect.objectContaining({
      taskKey: 'demo:quarter-hour:2026-01-15T08:30:1768437000',
      idempotencyKey: 'schedule:demo:quarter-hour:2026-01-15T08:30:1768437000',
      payload: {
        localSlot: expect.objectContaining({
          year: 2026,
          month: 1,
          day: 15,
          hour: 8,
          minute: 30,
          timezone: 'Asia/Shanghai',
        }),
        scheduledAt: Math.floor(Date.parse('2026-01-15T00:30:00Z') / 1000),
      },
    }));
    expect(Object.keys(messages[0].body.payload as object)).toEqual(['localSlot', 'scheduledAt']);
  });

  it('skips scheduling before the site has been installed', async () => {
    ensureTablesReadyMock.mockRejectedValueOnce(new TablesMissingError());

    await expect(runScheduledTasks(
      makeController('2026-01-15T00:30:00Z'),
      env as unknown as Cloudflare.Env,
      makeContext(),
    )).resolves.toBeUndefined();

    expect(createTaskRuntimeMock).not.toHaveBeenCalled();
    expect(env.QUEUE.sendBatch).not.toHaveBeenCalled();
  });

  it('does not call Queue when no task is due', async () => {
    registerScheduledTask('demo', {
      id: 'hourly',
      schedule: '0 * * * *',
      handler: async () => ({ status: 'success' }),
    });
    createTaskRuntimeMock.mockResolvedValue(makeRuntime('UTC', ['demo']));

    await runScheduledTasks(
      makeController('2026-01-15T00:30:00Z'),
      env as unknown as Cloudflare.Env,
      makeContext(),
    );

    expect(env.QUEUE.send).not.toHaveBeenCalled();
    expect(env.QUEUE.sendBatch).not.toHaveBeenCalled();
  });

  it('does not schedule tasks from a plugin whose initialization failed', async () => {
    registerScheduledTask('demo', {
      id: 'partially-registered',
      schedule: '* * * * *',
      handler: async () => ({ status: 'success' }),
    });
    createTaskRuntimeMock.mockResolvedValue(makeRuntime('UTC', ['demo'], {
      demo: { error: 'init failed', attempts: 1, failedAt: Date.now() },
    }));

    await runScheduledTasks(
      makeController('2026-01-15T00:30:00Z'),
      env as unknown as Cloudflare.Env,
      makeContext(),
    );

    expect(env.QUEUE.sendBatch).not.toHaveBeenCalled();
  });

  it('uses a custom task key and derives its schedule idempotency key', async () => {
    registerScheduledTask('demo', {
      id: 'daily',
      schedule: '30 8 * * *',
      getTaskKey: ({ scheduledAt }) => `daily:${scheduledAt}`,
      handler: async () => ({ status: 'success' }),
    });
    createTaskRuntimeMock.mockResolvedValue(makeRuntime('Asia/Shanghai', ['demo']));

    await runScheduledTasks(
      makeController('2026-01-15T00:30:00Z'),
      env as unknown as Cloudflare.Env,
      makeContext(),
    );

    const [messages] = env.QUEUE.sendBatch.mock.calls[0] as [Array<{ body: Record<string, unknown> }>];
    expect(messages[0].body).toEqual(expect.objectContaining({
      taskKey: 'daily:1768437000',
      idempotencyKey: 'schedule:daily:1768437000',
    }));
  });

  it('still enqueues valid tasks when another scheduled task fails to build', async () => {
    registerScheduledTask('demo', {
      id: 'broken',
      schedule: '* * * * *',
      getTaskKey: () => {
        throw new Error('invalid task key');
      },
      handler: async () => ({ status: 'success' }),
    });
    registerScheduledTask('demo', {
      id: 'healthy',
      schedule: '* * * * *',
      handler: async () => ({ status: 'success' }),
    });
    createTaskRuntimeMock.mockResolvedValue(makeRuntime('UTC', ['demo']));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(runScheduledTasks(
        makeController('2026-01-15T00:30:00Z'),
        env as unknown as Cloudflare.Env,
        makeContext(),
      )).rejects.toThrow('1 scheduled task(s) failed to enqueue');

      expect(env.QUEUE.sendBatch).toHaveBeenCalledTimes(1);
      const [messages] = env.QUEUE.sendBatch.mock.calls[0] as [Array<{ body: Record<string, unknown> }>];
      expect(messages).toHaveLength(1);
      expect(messages[0].body).toEqual(expect.objectContaining({ taskId: 'healthy' }));
      expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
        event: 'task.schedule_failed',
        pluginId: 'demo',
        taskId: 'broken',
        errorType: 'Error',
      }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('sends scheduled messages in batches of at most one hundred', async () => {
    for (let index = 0; index < 205; index += 1) {
      registerScheduledTask('demo', {
        id: `task-${index}`,
        schedule: '* * * * *',
        handler: async () => ({ status: 'success' }),
      });
    }
    createTaskRuntimeMock.mockResolvedValue(makeRuntime('UTC', ['demo']));

    await runScheduledTasks(
      makeController('2026-01-15T00:30:00Z'),
      env as unknown as Cloudflare.Env,
      makeContext(),
    );

    expect(env.QUEUE.sendBatch).toHaveBeenCalledTimes(3);
    expect(env.QUEUE.sendBatch.mock.calls.map(([messages]) => (messages as unknown[]).length))
      .toEqual([100, 100, 5]);
    expect(env.QUEUE.send).not.toHaveBeenCalled();
  });

  it('splits scheduled batches before the aggregate Queue size limit', async () => {
    const largeKey = 'k'.repeat(480);
    for (let index = 0; index < 250; index += 1) {
      registerScheduledTask('demo', {
        id: `large-task-${index}`,
        schedule: '* * * * *',
        getTaskKey: () => largeKey,
        handler: async () => ({ status: 'success' }),
      });
    }
    createTaskRuntimeMock.mockResolvedValue(makeRuntime('UTC', ['demo']));

    await runScheduledTasks(
      makeController('2026-01-15T00:30:00Z'),
      env as unknown as Cloudflare.Env,
      makeContext(),
    );

    const batches = env.QUEUE.sendBatch.mock.calls.map(([messages]) => messages as Array<{
      body: unknown;
      contentType: string;
    }>);
    expect(batches.reduce((total, batch) => total + batch.length, 0)).toBe(250);
    expect(batches.every(batch => batch.length <= 100)).toBe(true);
    expect(batches.every(batch => (
      batch.reduce(
        (total, message) => total + new TextEncoder().encode(JSON.stringify(message)).byteLength,
        0,
      ) <= MAX_SCHEDULED_BATCH_BYTES
    ))).toBe(true);
    expect(batches.some(batch => batch.length < 100)).toBe(true);
  });

  it('propagates Queue sendBatch failures while waitUntil observes the same promise', async () => {
    const error = new Error('queue unavailable');
    env.QUEUE.sendBatch.mockRejectedValueOnce(error);
    registerScheduledTask('demo', {
      id: 'failing-send',
      schedule: '* * * * *',
      handler: async () => ({ status: 'success' }),
    });
    createTaskRuntimeMock.mockResolvedValue(makeRuntime('UTC', ['demo']));
    const context = makeContext();

    const pending = runScheduledTasks(
      makeController('2026-01-15T00:30:00Z'),
      env as unknown as Cloudflare.Env,
      context,
    );

    await expect(pending).rejects.toBe(error);
    expect(context.waitUntil).toHaveBeenCalledWith(pending);
  });
});
