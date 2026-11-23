import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@/db';
import { createCapabilityRuntimeContext } from '@/lib/capability';
import { createTestDb, disposeTestDb } from '../helpers';
import {
  HookPoints,
  type PluginInitContext,
  addHook,
  registerPluginInit,
  resetPluginInitState,
  setActivatedPlugins,
} from '@/lib/plugin';
import { findTask, listScheduledTasks } from '@/lib/tasks/registry';
import { TASK_QUEUE_CAPABILITY } from '@/lib/tasks/queue';
import { testQueueProvider } from '../helpers/task-provider';

const noopInitContext = { addHook, HookPoints };

describe('plugin task lifecycle bridge', () => {
  beforeEach(() => {
    resetPluginInitState();
  });

  it('binds scheduled and async registrations to the initializing plugin id', async () => {
    const scheduledHandler = vi.fn(async () => ({ status: 'success' as const }));
    const asyncHandler = vi.fn(async () => ({ status: 'success' as const }));

    registerPluginInit({
      'plugin-bound': ({ registerScheduledTask, registerAsyncTask }) => {
        registerScheduledTask({
          id: 'hourly',
          schedule: '0 * * * *',
          handler: scheduledHandler,
        });
        registerAsyncTask({ id: 'work', handler: asyncHandler });
      },
    }, noopInitContext);

    await setActivatedPlugins({ activatedPlugins: new Set() }, ['plugin-bound']);

    expect(findTask('plugin-bound', 'hourly', 'scheduled')).toMatchObject({
      pluginId: 'plugin-bound',
      kind: 'scheduled',
      handler: scheduledHandler,
    });
    expect(findTask('plugin-bound', 'work', 'async')).toMatchObject({
      pluginId: 'plugin-bound',
      kind: 'async',
      handler: asyncHandler,
    });
  });

  it('binds enqueue to its owner and observes freshly disabled providers', async () => {
    const provider = testQueueProvider();
    let enqueue: PluginInitContext['enqueueAsyncTask'] | undefined;
    registerPluginInit({
      'plugin-enqueue': ({ registerAsyncTask, enqueueAsyncTask }) => {
        registerAsyncTask({ id: 'work', handler: () => ({ status: 'success' }) });
        enqueue = enqueueAsyncTask;
      },
      'test-provider': ({ registerCapability }) => {
        registerCapability?.({
          capability: TASK_QUEUE_CAPABILITY, version: 1, scope: 'any', factory: () => provider,
        });
      },
    }, noopInitContext);
    const ids = ['plugin-enqueue', 'test-provider'];
    const activeOptions = { activatedPlugins: JSON.stringify(ids) };
    const db = await createTestDb();
    try {
      await db.insert(schema.options).values({
        name: 'activatedPlugins',
        user: 0,
        value: activeOptions.activatedPlugins,
      });
      await setActivatedPlugins({ activatedPlugins: new Set() }, ids);
      const runtime = createCapabilityRuntimeContext({
        request: new Request('https://example.com/'),
        db: db as never,
        activatedPlugins: new Set(ids),
        getPrimaryDb: () => db as never,
      });

      if (!enqueue) throw new Error('task enqueue was not initialized');
      const accepted = await enqueue(runtime, 'work', { value: 1 }, { idempotencyKey: 'business:1' });
      expect(accepted).toMatchObject({
        pluginId: 'plugin-enqueue',
        taskId: 'work',
        kind: 'async',
        source: 'request',
        idempotencyKey: 'business:1',
        localSlot: null,
      });
      expect(provider.send).toHaveBeenCalledExactlyOnceWith(accepted, undefined);

      await db.update(schema.options)
        .set({ value: '["plugin-enqueue"]' });
      await expect(enqueue(runtime, 'work', {}, { idempotencyKey: 'business:2' }))
        .rejects.toMatchObject({ status: 503, reason: 'unavailable' });
      expect(provider.send).toHaveBeenCalledTimes(1);
    } finally {
      await disposeTestDb(db);
    }
  });

  it('does not allow a plugin to register a different plugin identity', async () => {
    registerPluginInit({
      'plugin-owner': ({ registerAsyncTask }) => {
        registerAsyncTask({
          id: 'owned',
          handler: async () => ({ status: 'success' as const }),
        });

        try {
          (registerAsyncTask as unknown as (pluginId: string, definition: unknown) => void)(
            'plugin-forged',
            { id: 'forged', handler: async () => ({ status: 'success' as const }) },
          );
        } catch {
          // The public closure accepts only a definition and cannot redirect ownership.
        }
      },
    }, noopInitContext);

    await setActivatedPlugins({ activatedPlugins: new Set() }, ['plugin-owner']);

    expect(findTask('plugin-owner', 'owned', 'async')).toBeDefined();
    expect(findTask('plugin-forged', 'forged', 'async')).toBeUndefined();
  });

  it('does not retain task registrations after deactivation or reset', async () => {
    registerPluginInit({
      'plugin-reset': ({ registerScheduledTask }) => {
        registerScheduledTask({
          id: 'daily',
          schedule: '0 0 * * *',
          handler: async () => ({ status: 'success' as const }),
        });
      },
    }, noopInitContext);

    const context = { activatedPlugins: new Set<string>() };
    await setActivatedPlugins(context, ['plugin-reset']);
    expect(listScheduledTasks(context.activatedPlugins)).toHaveLength(1);

    await setActivatedPlugins(context, []);
    expect(listScheduledTasks(context.activatedPlugins)).toHaveLength(0);

    resetPluginInitState();
    expect(findTask('plugin-reset', 'daily', 'scheduled')).toBeUndefined();
  });

  it('rolls back partial task registrations when plugin initialization fails', async () => {
    registerPluginInit({
      'plugin-failure': ({ registerAsyncTask }) => {
        registerAsyncTask({
          id: 'partial',
          handler: async () => ({ status: 'success' as const }),
        });
        throw new Error('init failed after registration');
      },
    }, noopInitContext);

    await setActivatedPlugins({ activatedPlugins: new Set() }, ['plugin-failure']);

    expect(findTask('plugin-failure', 'partial', 'async')).toBeUndefined();
  });
});
