import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueueAsyncTaskMessage, enqueueScheduledTaskMessage } from '@/lib/tasks/enqueue';
import {
  registerAsyncTask,
  registerScheduledTask,
  resetTaskRegistry,
} from '@/lib/tasks/registry';

function makeEnvironment() {
  return {
    QUEUE: {
      send: vi.fn(async () => undefined),
    },
  } as unknown as Cloudflare.Env;
}

describe('task enqueue helpers', () => {
  beforeEach(() => {
    resetTaskRegistry();
  });

  it('accepts the Cloudflare maximum delivery delay and rejects larger values', async () => {
    const environment = makeEnvironment();
    registerAsyncTask('demo', {
      id: 'delayed',
      handler: async () => ({ status: 'success' }),
    });

    await enqueueAsyncTaskMessage(environment, 'demo', 'delayed', { value: 1 }, {
      idempotencyKey: 'demo:delayed:1',
      delaySeconds: 86_400,
      nowSeconds: 1_700_000_000,
    });
    expect(environment.QUEUE.send).toHaveBeenCalledWith(
      expect.anything(),
      { contentType: 'json', delaySeconds: 86_400 },
    );

    await expect(enqueueAsyncTaskMessage(environment, 'demo', 'delayed', {}, {
      idempotencyKey: 'demo:delayed:2',
      delaySeconds: 86_401,
    })).rejects.toThrow('between 0 and 86400');
  });

  it('includes the real scheduled instant in the default scheduled identity', async () => {
    const environment = makeEnvironment();
    const task = registerScheduledTask('demo', {
      id: 'daily',
      schedule: '* * * * *',
      handler: async () => ({ status: 'success' }),
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

    const first = await enqueueScheduledTaskMessage(
      environment,
      task,
      localSlot,
      1_700_000_000,
    );

    const second = await enqueueScheduledTaskMessage(
      environment,
      task,
      localSlot,
      1_700_003_600,
      { nowSeconds: 1_700_000_001 },
    );

    expect(first.taskKey).toBe('demo:daily:2026-11-01T01:30:1700000000');
    expect(second.taskKey).toBe('demo:daily:2026-11-01T01:30:1700003600');
    expect(first.idempotencyKey).toBe('schedule:demo:daily:2026-11-01T01:30:1700000000');
    expect(second.idempotencyKey).toBe('schedule:demo:daily:2026-11-01T01:30:1700003600');
  });
});
