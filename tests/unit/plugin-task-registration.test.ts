import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  HookPoints,
  addHook,
  registerPluginInit,
  resetPluginInitState,
  setActivatedPlugins,
} from '@/lib/plugin';
import { findTask, listScheduledTasks } from '@/lib/tasks/registry';
import { _resetTaskQueue } from '../__mocks__/cloudflare-workers';

const noopInitContext = { addHook, HookPoints };

describe('plugin task lifecycle bridge', () => {
  beforeEach(() => {
    _resetTaskQueue();
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

  it('uses a core-owned request source and current plugin identity for enqueue', async () => {
    registerPluginInit({
      'plugin-enqueue': async ({ registerAsyncTask, enqueueAsyncTask }) => {
        registerAsyncTask({
          id: 'work',
          handler: async () => ({ status: 'success' as const }),
        });
        await enqueueAsyncTask('work', { value: 1 }, { idempotencyKey: 'business:1' });
      },
    }, noopInitContext);

    await setActivatedPlugins({ activatedPlugins: new Set() }, ['plugin-enqueue']);

    expect(env.QUEUE.send).toHaveBeenCalledTimes(1);
    expect(env.QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'plugin-enqueue',
        taskId: 'work',
        kind: 'async',
        source: 'request',
        idempotencyKey: 'business:1',
        localSlot: null,
      }),
      expect.objectContaining({ contentType: 'json' }),
    );
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
