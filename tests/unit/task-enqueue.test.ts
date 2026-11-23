import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapabilityRuntimeContext, registerCapability, resetCapabilityRegistry } from '@/lib/capability';
import { createScheduledTaskMessage, enqueueAsyncTaskMessage } from '@/lib/tasks/enqueue';
import {
  CORE_TASK_OWNER_ID,
  registerAsyncTask,
  registerCoreAsyncTask,
  registerScheduledTask,
  resetTaskRegistry,
} from '@/lib/tasks/registry';
import {
  TASK_QUEUE_CAPABILITY,
  TASK_QUEUE_CAPABILITY_VERSION,
  TaskQueueUnavailableError,
} from '@/lib/tasks/queue';
import {
  TEST_TASK_PROVIDER_ID,
  registerTestTaskProvider,
  testQueueProvider,
  testTaskRuntime,
} from '../helpers/task-provider';

describe('task enqueue helpers', () => {
  beforeEach(() => {
    resetCapabilityRegistry();
    resetTaskRegistry();
  });

  it('sends an owner-validated message and returns the accepted envelope', async () => {
    const provider = testQueueProvider();
    registerTestTaskProvider(provider);
    const runtime = testTaskRuntime(['demo', TEST_TASK_PROVIDER_ID]);
    registerAsyncTask('demo', { id: 'delayed', handler: () => ({ status: 'success' }) });

    const sent = await enqueueAsyncTaskMessage(runtime, 'demo', 'delayed', { value: 1 }, {
      idempotencyKey: 'demo:delay:1',
      delaySeconds: 100,
    });
    expect(provider.send).toHaveBeenCalledWith(sent, 100);
    expect(sent).toMatchObject({
      schemaVersion: 1,
      pluginId: 'demo',
      taskKey: 'demo:delayed',
      idempotencyKey: 'demo:delay:1',
      payload: { value: 1 },
    });
    await expect(enqueueAsyncTaskMessage(runtime, 'demo', 'delayed', {}, {
      idempotencyKey: 'demo:delay:2',
      delaySeconds: -1,
    })).rejects.toThrow('non-negative safe integer');
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it('fails closed when no provider is available or multiple providers match', async () => {
    registerAsyncTask('demo', { id: 'job', handler: () => ({ status: 'success' }) });

    const enqueue = (runtime: ReturnType<typeof testTaskRuntime>) => (
      enqueueAsyncTaskMessage(runtime, 'demo', 'job', {}, { idempotencyKey: 'demo:job:1' })
    );
    await expect(enqueue(testTaskRuntime(['demo']))).rejects.toBeInstanceOf(TaskQueueUnavailableError);

    const unconfigured = testQueueProvider(false);
    const ready = testQueueProvider();
    registerTestTaskProvider(unconfigured);
    registerTestTaskProvider(ready, 'second-provider');
    await expect(enqueue(testTaskRuntime(['demo', TEST_TASK_PROVIDER_ID])))
      .rejects.toMatchObject({ status: 503, reason: 'unavailable' });
    await expect(enqueue(testTaskRuntime(['demo', TEST_TASK_PROVIDER_ID, 'second-provider'])))
      .rejects.toMatchObject({ status: 503, reason: 'ambiguous' });

    expect(unconfigured.send).not.toHaveBeenCalled();
    expect(ready.send).not.toHaveBeenCalled();
  });

  it('rejects a task provider that cannot resolve in background contexts', async () => {
    const provider = testQueueProvider();
    registerCapability(TEST_TASK_PROVIDER_ID, {
      capability: TASK_QUEUE_CAPABILITY,
      version: TASK_QUEUE_CAPABILITY_VERSION,
      factory: () => provider,
    });
    registerAsyncTask('demo', { id: 'job', handler: () => ({ status: 'success' }) });
    const activatedPlugins = new Set(['demo', TEST_TASK_PROVIDER_ID]);
    const capabilityRuntime = createCapabilityRuntimeContext({
      request: new Request('https://example.com/'),
      db: {} as never,
      activatedPlugins,
      activationGeneration: 1,
    });

    await expect(enqueueAsyncTaskMessage(
      { ...testTaskRuntime(['demo', TEST_TASK_PROVIDER_ID]), capabilityRuntime },
      'demo',
      'job',
      {},
      { idempotencyKey: 'demo:job:1' },
    )).rejects.toMatchObject({ status: 503, reason: 'unavailable' });
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('fails closed with the documented error when the owner is not active', async () => {
    const provider = testQueueProvider();
    registerTestTaskProvider(provider);
    registerAsyncTask('demo', { id: 'job', handler: () => ({ status: 'success' }) });

    await expect(enqueueAsyncTaskMessage(
      testTaskRuntime([TEST_TASK_PROVIDER_ID]),
      'demo',
      'job',
      {},
      { idempotencyKey: 'demo:job:1' },
    )).rejects.toMatchObject({ status: 503, reason: 'activation-unavailable' });
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('does not report success when the provider rejects submission', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const provider = testQueueProvider();
      provider.send.mockRejectedValueOnce(new Error('send failed'));
      registerTestTaskProvider(provider);
      registerAsyncTask('demo', { id: 'job', handler: () => ({ status: 'success' }) });
      await expect(enqueueAsyncTaskMessage(
        testTaskRuntime(['demo', TEST_TASK_PROVIDER_ID]),
        'demo',
        'job',
        {},
        { idempotencyKey: 'demo:job:1' },
      )).rejects.toMatchObject({ status: 503, reason: 'transport-failed' });
      expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
        event: 'task.enqueue_failed',
        ownerId: 'demo',
        taskId: 'job',
        errorType: 'Error',
      }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps the core task owner out of plugin registrations', async () => {
    const provider = testQueueProvider();
    registerTestTaskProvider(provider);
    const task = { id: 'owned', handler: () => ({ status: 'success' as const }) };
    expect(() => registerAsyncTask(CORE_TASK_OWNER_ID, task)).toThrow('owner is reserved');
    registerCoreAsyncTask(task);
    const message = await enqueueAsyncTaskMessage(
      testTaskRuntime([TEST_TASK_PROVIDER_ID]),
      CORE_TASK_OWNER_ID,
      'owned',
      {},
      { idempotencyKey: 'owned:1' },
    );
    expect(message.pluginId).toBe(CORE_TASK_OWNER_ID);
    expect(provider.send).toHaveBeenCalledWith(message, undefined);
  });

  it('includes the real scheduled instant in the default scheduled identity', () => {
    const task = registerScheduledTask('demo', {
      id: 'daily',
      schedule: '* * * * *',
      handler: () => ({ status: 'success' }),
    });
    const localSlot = {
      year: 2026,
      month: 11,
      day: 1,
      hour: 1,
      minute: 30,
      weekday: 0,
      timezone: 'America/New_York',
    };
    const first = createScheduledTaskMessage(task, localSlot, 1_700_000_000, 1_700_000_001);
    const second = createScheduledTaskMessage(task, localSlot, 1_700_003_600, 1_700_003_601);

    expect(first.taskKey).toBe('demo:daily:2026-11-01T01:30:1700000000');
    expect(second.taskKey).toBe('demo:daily:2026-11-01T01:30:1700003600');
    expect(first.idempotencyKey).toBe(`schedule:${first.taskKey}`);
    expect(second.idempotencyKey).toBe(`schedule:${second.taskKey}`);
  });
});
