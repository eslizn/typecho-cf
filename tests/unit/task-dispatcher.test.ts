import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskEnvelope } from '@/lib/tasks/envelope';
import {
  dispatchTaskMessages,
  type TaskMessageLike,
} from '@/lib/tasks/dispatcher';
import {
  registerAsyncTask,
  resetTaskRegistry,
} from '@/lib/tasks/registry';
import type { TaskRuntime } from '@/lib/tasks/runtime';

type FakeMessage = TaskMessageLike & {
  ack: ReturnType<typeof vi.fn<() => void>>;
  retry: ReturnType<typeof vi.fn<(options?: { delaySeconds?: number }) => void>>;
};

function makeMessage(body: unknown, attempts = 1): FakeMessage {
  return {
    body,
    attempts,
    ack: vi.fn<() => void>(),
    retry: vi.fn<(options?: { delaySeconds?: number }) => void>(),
  };
}

function makeRuntime(activePlugins: string[]): TaskRuntime {
  return {
    env: {} as Cloudflare.Env,
    db: {} as TaskRuntime['db'],
    options: {} as TaskRuntime['options'],
    activatedPlugins: new Set(activePlugins),
    initFailures: {},
  };
}

function envelope(pluginId: string, taskId: string, payload: unknown = {}): string {
  return JSON.stringify(createTaskEnvelope({
    pluginId,
    taskId,
    kind: 'async',
    source: 'request',
    idempotencyKey: `${pluginId}:${taskId}:idempotency`,
    payload,
    scheduledAt: 1_700_000_000,
    enqueuedAt: 1_700_000_000,
    localSlot: null,
  }));
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

describe('task dispatcher', () => {
  beforeEach(() => {
    resetTaskRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acks successful tasks and retries handler exceptions', async () => {
    const success = makeMessage(envelope('plugin-a', 'success'));
    registerAsyncTask('plugin-a', {
      id: 'success',
      handler: async () => ({ status: 'success' }),
    });
    await dispatchTaskMessages([success], makeRuntime(['plugin-a']));
    expect(success.ack).toHaveBeenCalledTimes(1);
    expect(success.retry).not.toHaveBeenCalled();

    const failed = makeMessage(envelope('plugin-a', 'failed'), 2);
    registerAsyncTask('plugin-a', {
      id: 'failed',
      handler: async () => {
        throw new Error('failure');
      },
    });
    await dispatchTaskMessages([failed], makeRuntime(['plugin-a']));
    expect(failed.retry).toHaveBeenCalledTimes(1);
    expect(failed.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(failed.ack).not.toHaveBeenCalled();
  });

  it('acks malformed and inactive messages to avoid poison loops', async () => {
    const malformed = makeMessage('{not-json}');
    const inactive = makeMessage(envelope('plugin-a', 'inactive'));
    registerAsyncTask('plugin-a', {
      id: 'inactive',
      handler: async () => ({ status: 'success' }),
    });

    await dispatchTaskMessages([malformed, inactive], makeRuntime([]));
    expect(malformed.ack).toHaveBeenCalledTimes(1);
    expect(inactive.ack).toHaveBeenCalledTimes(1);
    expect(malformed.retry).not.toHaveBeenCalled();
    expect(inactive.retry).not.toHaveBeenCalled();
  });

  it('runs different tasks concurrently but limits the same task', async () => {
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const handler = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
      return { status: 'success' as const };
    };
    registerAsyncTask('plugin-a', { id: 'one', handler, concurrency: 1 });
    registerAsyncTask('plugin-a', { id: 'two', handler, concurrency: 1 });

    const first = makeMessage(envelope('plugin-a', 'one'));
    const second = makeMessage(envelope('plugin-a', 'one'));
    const other = makeMessage(envelope('plugin-a', 'two'));
    const pending = dispatchTaskMessages([first, second, other], makeRuntime(['plugin-a']));
    await flush();
    expect(active).toBe(2);
    expect(peak).toBe(2);
    expect(second.ack).not.toHaveBeenCalled();

    release();
    await pending;
    expect(first.ack).toHaveBeenCalledTimes(1);
    expect(second.ack).toHaveBeenCalledTimes(1);
    expect(other.ack).toHaveBeenCalledTimes(1);
  });

  it('caps total handler concurrency at sixteen', async () => {
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const messages: TaskMessageLike[] = [];
    for (let i = 0; i < 20; i += 1) {
      const taskId = `task-${i}`;
      registerAsyncTask('plugin-a', {
        id: taskId,
        concurrency: 10,
        handler: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await gate;
          active -= 1;
          return { status: 'success' as const };
        },
      });
      messages.push(makeMessage(envelope('plugin-a', taskId)));
    }

    const pending = dispatchTaskMessages(messages, makeRuntime(['plugin-a']));
    await flush();
    expect(peak).toBe(16);
    expect(active).toBe(16);
    release();
    await pending;
    expect(messages.every(message => (message.ack as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true);
  });

  it('retries a task that exceeds its timeout', async () => {
    let release!: () => void;
    const lateCompletion = new Promise<void>(resolve => { release = resolve; });
    registerAsyncTask('plugin-a', {
      id: 'slow',
      timeoutSeconds: 0.01,
      handler: async () => {
        await lateCompletion;
        return { status: 'success' as const };
      },
    });
    const message = makeMessage(envelope('plugin-a', 'slow'));
    await dispatchTaskMessages([message], makeRuntime(['plugin-a']));
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    release();
    await flush();
  });

  it('retries queued messages while retaining the timed-out handler task slot', async () => {
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const lateCompletion = new Promise<void>(resolve => { release = resolve; });
    const handler = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await lateCompletion;
      active -= 1;
      return { status: 'success' as const };
    };
    registerAsyncTask('plugin-a', {
      id: 'late-timeout',
      concurrency: 1,
      timeoutSeconds: 0.01,
      handler,
    });

    const first = makeMessage(envelope('plugin-a', 'late-timeout'));
    const second = makeMessage(envelope('plugin-a', 'late-timeout'));
    const pending = dispatchTaskMessages([first, second], makeRuntime(['plugin-a']));
    await flush();
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    await flush();

    expect(first.retry).toHaveBeenCalledTimes(1);
    expect(second.ack).not.toHaveBeenCalled();
    expect(second.retry).toHaveBeenCalledTimes(1);
    expect(active).toBe(1);
    expect(peak).toBe(1);

    release();
    await pending;
    expect(active).toBe(0);
    expect(peak).toBe(1);
  });

  it('prevents a later Queue batch from overlapping a non-cooperative timed-out handler', async () => {
    let calls = 0;
    let release!: () => void;
    const lateCompletion = new Promise<void>(resolve => { release = resolve; });
    registerAsyncTask('plugin-a', {
      id: 'cross-batch-late-timeout',
      concurrency: 1,
      timeoutSeconds: 0.01,
      handler: async () => {
        calls += 1;
        if (calls === 1) await lateCompletion;
        return { status: 'success' as const };
      },
    });

    const first = makeMessage(envelope('plugin-a', 'cross-batch-late-timeout'));
    await dispatchTaskMessages([first], makeRuntime(['plugin-a']));
    expect(first.retry).toHaveBeenCalledTimes(1);

    const second = makeMessage(envelope('plugin-a', 'cross-batch-late-timeout'));
    await dispatchTaskMessages([second], makeRuntime(['plugin-a']));
    expect(second.retry).toHaveBeenCalledTimes(1);
    expect(second.ack).not.toHaveBeenCalled();
    expect(calls).toBe(1);

    release();
    await flush();

    const third = makeMessage(envelope('plugin-a', 'cross-batch-late-timeout'));
    await dispatchTaskMessages([third], makeRuntime(['plugin-a']));
    expect(third.ack).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });

  it('counts late handlers against the isolate-wide in-flight limit', async () => {
    let active = 0;
    let release!: () => void;
    const lateCompletion = new Promise<void>(resolve => { release = resolve; });
    const messages: FakeMessage[] = [];
    for (let index = 0; index < 16; index += 1) {
      const taskId = `late-global-slot-${index}`;
      registerAsyncTask('plugin-a', {
        id: taskId,
        concurrency: 1,
        timeoutSeconds: 0.01,
        handler: async () => {
          active += 1;
          await lateCompletion;
          active -= 1;
          return { status: 'success' as const };
        },
      });
      messages.push(makeMessage(envelope('plugin-a', taskId)));
    }
    let extraCalls = 0;
    registerAsyncTask('plugin-a', {
      id: 'late-global-overflow',
      handler: async () => {
        extraCalls += 1;
        return { status: 'success' as const };
      },
    });

    try {
      await dispatchTaskMessages(messages, makeRuntime(['plugin-a']));
      expect(active).toBe(16);
      expect(messages.every(message => message.retry.mock.calls.length === 1)).toBe(true);

      const overflow = makeMessage(envelope('plugin-a', 'late-global-overflow'));
      await dispatchTaskMessages([overflow], makeRuntime(['plugin-a']));
      expect(overflow.retry).toHaveBeenCalledTimes(1);
      expect(extraCalls).toBe(0);
    } finally {
      release();
      await flush();
    }

    const afterRelease = makeMessage(envelope('plugin-a', 'late-global-overflow'));
    await dispatchTaskMessages([afterRelease], makeRuntime(['plugin-a']));
    expect(afterRelease.ack).toHaveBeenCalledTimes(1);
    expect(extraCalls).toBe(1);
  });

  it('retries an explicit retry result with the requested delay', async () => {
    registerAsyncTask('plugin-a', {
      id: 'retry',
      handler: async () => ({ status: 'retry', delaySeconds: 42 }),
    });
    const message = makeMessage(envelope('plugin-a', 'retry'));
    await dispatchTaskMessages([message], makeRuntime(['plugin-a']));
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 42 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('redacts credential-like fields from plugin logs', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    registerAsyncTask('plugin-a', {
      id: 'log-secrets',
      handler: async context => {
        context.log('apiKey=message-secret key=generic-message-secret', {
          apiKey: 'api-secret',
          access_key: 'access-secret',
          privateKeyPem: 'private-secret',
          credential: 'credential-secret',
          signingKey: 'signing-secret',
          key: 'generic-secret',
          safeValue: 'visible',
          nested: { clientSecret: 'client-secret' },
        });
        return { status: 'success' as const };
      },
    });

    try {
      await dispatchTaskMessages([
        makeMessage(envelope('plugin-a', 'log-secrets')),
      ], makeRuntime(['plugin-a']));

      const output = consoleLog.mock.calls
        .map(([line]) => String(line))
        .join('\n');
      for (const secret of [
        'message-secret',
        'generic-message-secret',
        'api-secret',
        'access-secret',
        'private-secret',
        'credential-secret',
        'signing-secret',
        'generic-secret',
        'client-secret',
      ]) {
        expect(output).not.toContain(secret);
      }
      expect(output).toContain('apiKey=[redacted]');
      expect(output).toContain('safeValue');
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('falls back after a delivery-control failure and surfaces a second failure', async () => {
    registerAsyncTask('plugin-a', {
      id: 'retry-once',
      handler: async () => ({ status: 'retry', delaySeconds: 42 }),
    });
    const recovered = makeMessage(envelope('plugin-a', 'retry-once'));
    recovered.retry
      .mockImplementationOnce(() => {
        throw new Error('transient retry failure');
      })
      .mockImplementationOnce(() => undefined);

    await dispatchTaskMessages([recovered], makeRuntime(['plugin-a']));
    expect(recovered.retry).toHaveBeenNthCalledWith(1, { delaySeconds: 42 });
    expect(recovered.retry).toHaveBeenNthCalledWith(2, { delaySeconds: 5 });

    const failed = makeMessage(envelope('plugin-a', 'retry-once'));
    failed.retry.mockImplementation(() => {
      throw new Error('retry unavailable');
    });

    await expect(dispatchTaskMessages([failed], makeRuntime(['plugin-a'])))
      .rejects.toThrow('retry unavailable');
  });

  it('falls back to a safe retry delay when a plugin exceeds the Queue limit', async () => {
    registerAsyncTask('plugin-a', {
      id: 'invalid-delay',
      handler: async () => ({ status: 'retry', delaySeconds: 86_401 }),
    });
    const message = makeMessage(envelope('plugin-a', 'invalid-delay'));

    await dispatchTaskMessages([message], makeRuntime(['plugin-a']));

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
  });
});
