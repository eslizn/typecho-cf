import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDb,
  getPrimaryDb,
  loadOptions,
  loadPluginSecurityOptions,
  setActivatedPlugins,
  getPluginInitFailures,
  parseActivatedPlugins,
  dispatchTaskMessages,
} = vi.hoisted(() => ({
  getDb: vi.fn(),
  getPrimaryDb: vi.fn(),
  loadOptions: vi.fn(),
  loadPluginSecurityOptions: vi.fn(),
  setActivatedPlugins: vi.fn(),
  getPluginInitFailures: vi.fn(),
  parseActivatedPlugins: vi.fn(),
  dispatchTaskMessages: vi.fn(),
}));

vi.mock('@/db', () => ({ getDb, getPrimaryDb }));
vi.mock('@/lib/options', () => ({ loadOptions }));
vi.mock('@/lib/security-options', () => ({ loadPluginSecurityOptions }));
vi.mock('@/lib/plugin', () => ({
  getPluginInitFailures,
  parseActivatedPlugins,
  setActivatedPlugins,
}));
vi.mock('@/lib/tasks/dispatcher', () => ({ dispatchTaskMessages }));

import { consumeTaskBatch, createTaskRuntime } from '@/lib/tasks/runtime';

const env = { DB: {} } as Cloudflare.Env;
const cachedDb = { name: 'cached' };
const primaryDb = { name: 'primary' };
const cachedOptions = { activatedPlugins: 'plugin-a', timezone: 'UTC' };
const freshOptions = { activatedPlugins: 'plugin-b', timezone: 'Asia/Shanghai' };

beforeEach(() => {
  vi.clearAllMocks();
  getDb.mockReturnValue(cachedDb);
  getPrimaryDb.mockReturnValue(primaryDb);
  loadOptions.mockResolvedValue(cachedOptions);
  loadPluginSecurityOptions.mockResolvedValue(freshOptions);
  parseActivatedPlugins.mockImplementation((value: string | undefined) =>
    value ? value.split(',') : []);
  setActivatedPlugins.mockImplementation(async (
    ctx: { activatedPlugins: Set<string>; activationDiagnostics?: unknown[] },
    ids: string[],
  ) => {
    ctx.activatedPlugins = new Set(ids);
    ctx.activationDiagnostics = [{
      pluginId: 'plugin-b',
      dependencyId: 'plugin-c',
      code: 'dependency-not-active',
      message: 'plugin-c is not active',
    }];
  });
  getPluginInitFailures.mockReturnValue({
    'plugin-c': { error: 'boom', attempts: 1, failedAt: 1 },
  });
  dispatchTaskMessages.mockResolvedValue(undefined);
});

describe('task runtime', () => {
  it('overlays plugin activation and config from the D1 primary', async () => {
    const runtime = await createTaskRuntime(env);

    expect(loadOptions).toHaveBeenCalledWith(cachedDb);
    expect(loadPluginSecurityOptions).toHaveBeenCalledWith(primaryDb, cachedOptions);
    expect(parseActivatedPlugins).toHaveBeenCalledWith('plugin-b');
    expect([...runtime.activatedPlugins]).toEqual(['plugin-b']);
    expect(runtime.options).toBe(freshOptions);
    expect(runtime.db).toBe(cachedDb);
    expect(runtime.initFailures).toEqual({
      'plugin-c': { error: 'boom', attempts: 1, failedAt: 1 },
    });
    expect(runtime.activationDiagnostics).toEqual([{
      pluginId: 'plugin-b',
      dependencyId: 'plugin-c',
      code: 'dependency-not-active',
      message: 'plugin-c is not active',
    }]);
  });

  it('skips runtime construction for an empty Queue batch', async () => {
    await consumeTaskBatch({ messages: [] } as never, env);

    expect(getDb).not.toHaveBeenCalled();
    expect(dispatchTaskMessages).not.toHaveBeenCalled();
  });

  it('dispatches non-empty batches with the freshly built runtime', async () => {
    const messages = [{ body: '{}' }];
    await consumeTaskBatch({ messages } as never, env);

    expect(dispatchTaskMessages).toHaveBeenCalledTimes(1);
    const [dispatched, runtime] = dispatchTaskMessages.mock.calls[0];
    expect(dispatched).toBe(messages);
    expect([...runtime.activatedPlugins]).toEqual(['plugin-b']);
  });
});
