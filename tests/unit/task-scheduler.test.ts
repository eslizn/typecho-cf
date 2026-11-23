import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCapabilityRegistry } from '@/lib/capability';
import { registerScheduledTask, resetTaskRegistry } from '@/lib/tasks/registry';
import { runScheduledTasks } from '@/lib/tasks/scheduler';
import {
  TEST_TASK_PROVIDER_ID,
  registerTestTaskProvider,
  testQueueProvider,
  testTaskRuntime,
} from '../helpers/task-provider';

const instant = Date.parse('2026-01-15T00:30:00Z');
const handle = () => ({ status: 'success' as const });

describe('task scheduler', () => {
  beforeEach(() => {
    resetCapabilityRegistry();
    resetTaskRegistry();
  });

  it('converts the Cron instant through the site timezone across a DST boundary', async () => {
    const provider = testQueueProvider();
    registerTestTaskProvider(provider);
    registerScheduledTask('demo', {
      id: 'after-spring-forward',
      schedule: '30 3 * * *',
      handler: handle,
    });
    const scheduled = Date.parse('2026-03-08T07:30:00Z');

    await runScheduledTasks(scheduled, testTaskRuntime(['demo', TEST_TASK_PROVIDER_ID], {
      timezone: 'America/New_York',
    }));

    expect(provider.sendBatch).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        localSlot: expect.objectContaining({
          year: 2026, month: 3, day: 8, hour: 3, minute: 30, timezone: 'America/New_York',
        }),
        scheduledAt: scheduled / 1000,
      }),
    ]);
  });

  it('enqueues only tasks matching the current site-local minute', async () => {
    const provider = testQueueProvider();
    registerTestTaskProvider(provider);
    registerScheduledTask('demo', { id: 'quarter-hour', schedule: '*/15 * * * *', handler: handle });
    registerScheduledTask('demo', { id: 'not-now', schedule: '31 * * * *', handler: handle });

    await runScheduledTasks(instant, testTaskRuntime(['demo', TEST_TASK_PROVIDER_ID], {
      timezone: 'Asia/Shanghai',
    }));

    expect(provider.sendBatch).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        taskKey: 'demo:quarter-hour:2026-01-15T08:30:1768437000',
        idempotencyKey: 'schedule:demo:quarter-hour:2026-01-15T08:30:1768437000',
        payload: {
          localSlot: expect.objectContaining({
            year: 2026, month: 1, day: 15, hour: 8, minute: 30, timezone: 'Asia/Shanghai',
          }),
          scheduledAt: instant / 1000,
        },
      }),
    ]);
  });

  it('skips empty schedules, disabled or unconfigured providers, and failing business plugins', async () => {
    const registrations = { id: 'job', schedule: '30 * * * *', handler: handle };
    registerScheduledTask('demo', registrations);
    const provider = testQueueProvider();
    registerTestTaskProvider(provider);
    const unconfigured = testQueueProvider(false);
    registerTestTaskProvider(unconfigured, 'unconfigured');

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await runScheduledTasks(instant, testTaskRuntime(['demo']));
      // A disabled provider is a valid state and must not log.
      expect(consoleError).not.toHaveBeenCalled();
      await runScheduledTasks(instant, testTaskRuntime(['demo', 'unconfigured']));
      // A provider that is active but unusable must be visible in logs.
      expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
        event: 'task.queue_unavailable',
        source: 'scheduler',
        reason: 'unavailable',
      }));
      await runScheduledTasks(instant - 60_000, testTaskRuntime(['demo', TEST_TASK_PROVIDER_ID]));
      await runScheduledTasks(instant, testTaskRuntime(['demo', TEST_TASK_PROVIDER_ID], {
        initFailures: { demo: { error: 'init failed', attempts: 1, failedAt: 1 } },
      }));
    } finally {
      consoleError.mockRestore();
    }

    expect(provider.sendBatch).not.toHaveBeenCalled();
    expect(unconfigured.sendBatch).not.toHaveBeenCalled();
  });

  it('uses a custom task key and derives its schedule idempotency key', async () => {
    const provider = testQueueProvider();
    registerTestTaskProvider(provider);
    registerScheduledTask('demo', {
      id: 'daily',
      schedule: '30 8 * * *',
      getTaskKey: ({ scheduledAt }) => `daily:${scheduledAt}`,
      handler: handle,
    });

    await runScheduledTasks(instant, testTaskRuntime(['demo', TEST_TASK_PROVIDER_ID], {
      timezone: 'Asia/Shanghai',
    }));

    expect(provider.sendBatch).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ taskKey: 'daily:1768437000', idempotencyKey: 'schedule:daily:1768437000' }),
    ]);
  });

  it('sends valid tasks when another scheduled task fails to build', async () => {
    const provider = testQueueProvider();
    registerTestTaskProvider(provider);
    registerScheduledTask('demo', {
      id: 'broken',
      schedule: '* * * * *',
      getTaskKey: () => { throw new Error('invalid task key'); },
      handler: handle,
    });
    registerScheduledTask('demo', { id: 'healthy', schedule: '* * * * *', handler: handle });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(runScheduledTasks(instant, testTaskRuntime(['demo', TEST_TASK_PROVIDER_ID])))
        .rejects.toThrow('1 scheduled task(s) failed to enqueue');
      expect(provider.sendBatch).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ taskId: 'healthy' }),
      ]);
      expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
        event: 'task.schedule_failed', pluginId: 'demo', taskId: 'broken', errorType: 'Error',
      }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('surfaces provider submission failures', async () => {
    const provider = testQueueProvider();
    registerTestTaskProvider(provider);
    provider.sendBatch.mockRejectedValueOnce(new Error('queue send failed'));
    registerScheduledTask('demo', { id: 'job', schedule: '* * * * *', handler: handle });

    await expect(runScheduledTasks(instant, testTaskRuntime(['demo', TEST_TASK_PROVIDER_ID])))
      .rejects.toThrow('queue send failed');
  });
});
