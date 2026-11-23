import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@/db';
import { createCapabilityRuntimeContext, getCapabilityActivationGeneration, resetCapabilityRegistry } from '@/lib/capability';
import { addHook, HookPoints, registerPluginInit } from '@/lib/plugin';
import { createTestDb, disposeTestDb } from '../helpers';
import type { TaskMessageLike } from '@/lib/tasks/dispatcher';
import { createTaskEnvelope } from '@/lib/tasks/envelope';
import { registerAsyncTask, resetTaskRegistry } from '@/lib/tasks/registry';
import { consumeTaskBatch, createTaskRuntime, refreshTaskRuntime } from '@/lib/tasks/runtime';
import {
  TEST_TASK_PROVIDER_ID,
  registerTestTaskProvider,
  testQueueProvider,
  testTaskRuntime,
} from '../helpers/task-provider';

function makeMessage(): TaskMessageLike {
  return {
    body: createTaskEnvelope({
      kind: 'async',
      source: 'request',
      pluginId: 'plugin-b',
      taskId: 'test',
      idempotencyKey: 'business:1',
      scheduledAt: 1_700_000_000,
      enqueuedAt: 1_700_000_000,
      localSlot: null,
      payload: {},
    }),
    attempts: 2,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

beforeEach(() => {
  resetCapabilityRegistry();
  resetTaskRegistry();
});

describe('task runtime', () => {
  it('overlays activation and config from the primary without fabricating an HTTP request', async () => {
    const cached = await createTestDb();
    const primary = await createTestDb();
    try {
      await cached.insert(schema.options).values([
        { name: 'activatedPlugins', user: 0, value: '["old-plugin"]' },
        { name: 'timezone', user: 0, value: 'Asia/Shanghai' },
        { name: 'plugin:plugin-b', user: 0, value: '{"token":"old"}' },
      ]);
      await primary.insert(schema.options).values([
        { name: 'activatedPlugins', user: 0, value: '["plugin-b"]' },
        { name: 'plugin:plugin-b', user: 0, value: '{"token":"fresh"}' },
      ]);
      registerPluginInit({ 'plugin-b': () => undefined }, { addHook, HookPoints });

      const runtime = await createTaskRuntime({ db: cached as never, primaryDb: primary as never });

      expect([...runtime.activatedPlugins]).toEqual(['plugin-b']);
      expect(runtime.options['plugin:plugin-b']).toBe('{"token":"fresh"}');
      expect(runtime.options.timezone).toBe('Asia/Shanghai');
      expect(runtime.db).toBe(cached);
      expect(runtime.capabilityRuntime).not.toHaveProperty('request');
      expect(runtime.capabilityRuntime.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await disposeTestDb(cached);
      await disposeTestDb(primary);
    }
  });

  it('refreshes submission activation without mutating isolate plugin state', async () => {
    const cached = await createTestDb();
    const primary = await createTestDb();
    try {
      await cached.insert(schema.options).values([
        { name: 'activatedPlugins', user: 0, value: '["cached-plugin"]' },
      ]);
      await primary.insert(schema.options).values([
        { name: 'activatedPlugins', user: 0, value: '["primary-plugin"]' },
        { name: 'plugin:primary-plugin', user: 0, value: '{"token":"fresh"}' },
      ]);
      const init = vi.fn();
      registerPluginInit({ 'primary-plugin': init }, { addHook, HookPoints });
      const generationBefore = getCapabilityActivationGeneration();
      const context = createCapabilityRuntimeContext({
        request: new Request('https://example.com/'),
        db: cached as never,
        activatedPlugins: new Set(['cached-plugin']),
        activationGeneration: generationBefore,
        getPrimaryDb: () => primary as never,
      });

      const runtime = await refreshTaskRuntime(context);

      expect([...runtime.activatedPlugins]).toEqual(['primary-plugin']);
      expect(runtime.options['plugin:primary-plugin']).toBe('{"token":"fresh"}');
      expect(getCapabilityActivationGeneration()).toBe(generationBefore);
      expect(init).not.toHaveBeenCalled();
    } finally {
      await disposeTestDb(cached);
      await disposeTestDb(primary);
    }
  });

  it('fails closed if loading the authoritative database context throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const context = createCapabilityRuntimeContext({
        request: new Request('https://example.com/'),
        db: {} as never,
        activatedPlugins: new Set(['plugin-a']),
        getPrimaryDb: () => { throw new Error('not available'); },
      });
      await expect(refreshTaskRuntime(context))
        .rejects.toMatchObject({ status: 503, reason: 'activation-unavailable' });
      expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
        event: 'task.runtime_unavailable',
        source: 'submission',
      }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('dispatches an old message from the selected provider', async () => {
    registerTestTaskProvider(testQueueProvider());
    const runtime = testTaskRuntime(['plugin-b', TEST_TASK_PROVIDER_ID]);
    const handler = vi.fn(() => ({ status: 'success' as const }));
    registerAsyncTask('plugin-b', { id: 'test', handler });
    const message = makeMessage();

    await consumeTaskBatch([message], TEST_TASK_PROVIDER_ID, runtime);

    expect(handler).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('explicitly retries deliveries when the provider is disabled or changes', async () => {
    registerTestTaskProvider(testQueueProvider());
    const handler = vi.fn(() => ({ status: 'success' as const }));
    registerAsyncTask('plugin-b', { id: 'test', handler });
    const stopped = makeMessage();
    const stale = makeMessage();

    await consumeTaskBatch([stopped], TEST_TASK_PROVIDER_ID, testTaskRuntime(['plugin-b']));
    await consumeTaskBatch([stale], 'previous-provider',
      testTaskRuntime(['plugin-b', TEST_TASK_PROVIDER_ID]));

    expect(handler).not.toHaveBeenCalled();
    for (const message of [stopped, stale]) {
      expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 10 });
      expect(message.ack).not.toHaveBeenCalled();
    }
  });
});
