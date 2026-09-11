/**
 * Tests for the plugin runtime helpers introduced in Group 6.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addHook,
  doHook,
  applyFilter,
  applyFilterSafely,
  hasHook,
  normalizeHookPoint,
  removePluginHooks,
  setActivatedPlugins,
  registerPluginInit,
  registerPluginLoaders,
  registerPlugin,
  isPluginAdminPath,
  isPluginRoute,
  refreshPluginRoutes,
  getPluginInitFailures,
  resetPluginInitState,
  type HookContext,
} from '@/lib/plugin';
import {
  markPluginRouteResolverReady,
  registerPluginRouteResolver,
} from '@/lib/plugin-routes';
import { createCapabilityRuntimeContext, resolveCapability } from '@/lib/capability';

function mockCtx(): HookContext {
  return { activatedPlugins: new Set<string>() };
}

describe('canonical Hook point names', () => {
  it('exposes canonical values and deprecated aliases', () => {
    expect(normalizeHookPoint('system:begin')).toBe('request:begin');
    expect(normalizeHookPoint('content:content')).toBe('content:rendered');
    expect(normalizeHookPoint('content:filter')).toBe('content:data');
    expect(normalizeHookPoint('upload:upload')).toBe('upload:after');
    expect(normalizeHookPoint('plugin:demo:action:auth')).toBe('plugin:demo:action:authorize');
    expect(normalizeHookPoint('plugin:demo:action')).toBe('plugin:demo:action');
  });

  it('returns canonical values from the public constants for legacy keys', async () => {
    const { HookPoints } = await import('@/lib/plugin');
    expect(HookPoints['request:begin']).toBe('request:begin');
    expect(HookPoints['system:begin']).toBe('request:begin');
    expect(HookPoints['content:rendered']).toBe('content:rendered');
    expect(HookPoints['content:content']).toBe('content:rendered');
  });

  it('deduplicates a handler registered through canonical and legacy names', async () => {
    const pluginId = 'p-canonical-dedupe';
    registerPlugin(pluginId, { id: pluginId, name: pluginId });
    const ctx = mockCtx();
    await setActivatedPlugins(ctx, [pluginId]);
    const handler = vi.fn();

    addHook('request:begin', pluginId, handler);
    addHook('system:begin', pluginId, handler);
    await doHook(ctx, 'system:begin');

    expect(handler).toHaveBeenCalledOnce();
    removePluginHooks(pluginId);
  });
});

describe('addHook deduplication (G6-1)', () => {
  let ctx: HookContext;
  beforeEach(async () => {
    ctx = mockCtx();
    registerPlugin('p-dedupe', { id: 'p-dedupe', name: 'p-dedupe' });
    await setActivatedPlugins(ctx, ['p-dedupe']);
  });

  it('does not register the same handler twice for the same plugin', async () => {
    const calls: string[] = [];
    const handler = () => { calls.push('hit'); };
    addHook('post:finishPublish', 'p-dedupe', handler);
    addHook('post:finishPublish', 'p-dedupe', handler);
    expect(hasHook(ctx, 'post:finishPublish')).toBe(true);
    await doHook(ctx, 'post:finishPublish', { cid: 1 });
    expect(calls).toEqual(['hit']);
  });

  it('still registers different handlers from the same plugin', async () => {
    const calls: string[] = [];
    addHook('post:finishSave', 'p-dedupe', () => calls.push('a'));
    addHook('post:finishSave', 'p-dedupe', () => calls.push('b'));
    await doHook(ctx, 'post:finishSave', {});
    expect(calls.sort()).toEqual(['a', 'b']);
  });
});

describe('lazy plugin init (G6-3)', () => {
  it('only runs init for plugins listed as active', async () => {
    const inits = {
      'lazy-a': vi.fn(),
      'lazy-b': vi.fn(),
    };
    registerPluginInit(inits, { addHook, HookPoints: {} as any });

    const ctx = mockCtx();
    await setActivatedPlugins(ctx, ['lazy-a']);
    expect(inits['lazy-a']).toHaveBeenCalledTimes(1);
    expect(inits['lazy-b']).not.toHaveBeenCalled();

    // Reactivating the same plugin must not run init twice — the
    // module is already side-effected.
    await setActivatedPlugins(ctx, ['lazy-a']);
    expect(inits['lazy-a']).toHaveBeenCalledTimes(1);

    // Activating a previously dormant plugin runs its init now.
    await setActivatedPlugins(ctx, ['lazy-a', 'lazy-b']);
    expect(inits['lazy-b']).toHaveBeenCalledTimes(1);
  });

  it('isolates init failures per plugin', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good = vi.fn();
    const failedHook = vi.fn();
    const bad = vi.fn(({ addHook: register, pluginId }) => {
      register('request:begin', pluginId, failedHook);
      throw new Error('boom');
    });
    registerPluginInit({ 'lazy-good': good, 'lazy-bad': bad }, { addHook, HookPoints: {} as any });
    const ctx: HookContext = {
      activatedPlugins: new Set<string>(),
      routeResolverFailures: new Set<string>(),
    };
    await expect(setActivatedPlugins(ctx, ['lazy-bad', 'lazy-good'])).resolves.toBeUndefined();
    expect(good).toHaveBeenCalled();
    expect(bad).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    expect(getPluginInitFailures()['lazy-bad']?.error).toBe('boom');
    expect(ctx.activatedPlugins.has('lazy-bad')).toBe(false);
    await doHook(ctx, 'request:begin');
    expect(failedHook).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('backs off retrying a failed plugin init', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = vi.fn(() => { throw new Error('still-bad'); });
    registerPluginInit({ 'lazy-retry': bad }, { addHook, HookPoints: {} as any });
    const ctx = mockCtx();
    await setActivatedPlugins(ctx, ['lazy-retry']);
    await setActivatedPlugins(ctx, ['lazy-retry']);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(ctx.activatedPlugins.has('lazy-retry')).toBe(false);
    expect(getPluginInitFailures()['lazy-retry']?.attempts).toBe(1);
    errSpy.mockRestore();
    resetPluginInitState();
  });

  it('waits for async init before hooks are used', async () => {
    const handler = vi.fn();
    registerPluginInit({
      'lazy-async': async ({ addHook: register, pluginId }) => {
        await Promise.resolve();
        register('post:finishSave', pluginId, handler);
      },
    }, { addHook, HookPoints: {} as any });
    const ctx = mockCtx();

    await setActivatedPlugins(ctx, ['lazy-async']);
    await doHook(ctx, 'post:finishSave', {});

    expect(handler).toHaveBeenCalledOnce();
  });

  it('loads an active plugin module once and keeps inactive modules unloaded', async () => {
    const activeInit = vi.fn();
    const activeLoader = vi.fn(async () => activeInit);
    const inactiveLoader = vi.fn(async () => vi.fn());
    registerPluginLoaders({
      'dynamic-active': activeLoader,
      'dynamic-inactive': inactiveLoader,
    }, { addHook, HookPoints: {} as any });
    const ctx = mockCtx();

    await setActivatedPlugins(ctx, ['dynamic-active']);
    await setActivatedPlugins(ctx, ['dynamic-active']);

    expect(activeLoader).toHaveBeenCalledOnce();
    expect(activeInit).toHaveBeenCalledOnce();
    expect(inactiveLoader).not.toHaveBeenCalled();
  });

  it('tears down owner capabilities on deactivation and reinitializes on reactivation', async () => {
    const pluginId = 'capability-lifecycle-owner';
    const init = vi.fn(({ registerCapability }: any) => {
      registerCapability({
        capability: 'lifecycle.service',
        version: 1,
        factory: () => ({ generation: init.mock.calls.length }),
      });
    });
    registerPlugin(pluginId, { id: pluginId, name: pluginId });
    registerPluginInit({ [pluginId]: init }, { addHook, HookPoints: {} as any });
    const ctx = mockCtx();

    await setActivatedPlugins(ctx, [pluginId]);
    const firstRuntime = createCapabilityRuntimeContext({
      request: new Request('https://example.com/'),
      db: {} as any,
      activatedPlugins: new Set([pluginId]),
      activationGeneration: ctx.activationGeneration,
    });
    expect(resolveCapability(firstRuntime, { capability: 'lifecycle.service' })).toMatchObject({
      ok: true,
      value: { generation: 1 },
    });

    await setActivatedPlugins(ctx, []);
    const inactiveRuntime = createCapabilityRuntimeContext({
      request: new Request('https://example.com/'),
      db: {} as any,
      activatedPlugins: new Set(),
      activationGeneration: ctx.activationGeneration,
    });
    expect(resolveCapability(inactiveRuntime, { capability: 'lifecycle.service' }))
      .toMatchObject({ ok: false, reason: 'unavailable' });

    await setActivatedPlugins(ctx, [pluginId]);
    expect(init).toHaveBeenCalledTimes(2);
    const secondRuntime = createCapabilityRuntimeContext({
      request: new Request('https://example.com/'),
      db: {} as any,
      activatedPlugins: new Set([pluginId]),
      activationGeneration: ctx.activationGeneration,
    });
    expect(resolveCapability(secondRuntime, { capability: 'lifecycle.service' })).toMatchObject({
      ok: true,
      value: { generation: 2 },
    });
  });

  it('skips request route handlers for request-local resolver failures', async () => {
    const failedHandler = vi.fn((value: string) => `${value}:failed`);
    const healthyHandler = vi.fn((value: string) => `${value}:healthy`);
    addHook('request:route', 'route-failed-owner', failedHandler);
    addHook('request:route', 'route-healthy-owner', healthyHandler);
    const ctx: HookContext = {
      activatedPlugins: new Set(['route-failed-owner', 'route-healthy-owner']),
      routeResolverFailures: new Set(['route-failed-owner']),
    };

    expect(await applyFilter(ctx, 'request:route', 'start')).toBe('start:healthy');
    expect(await applyFilterSafely(ctx, 'request:route', 'start')).toBe('start:healthy');
    expect(failedHandler).not.toHaveBeenCalled();
    expect(healthyHandler).toHaveBeenCalledTimes(2);

    removePluginHooks('route-failed-owner');
    removePluginHooks('route-healthy-owner');
  });
});

describe('plugin route resolver lifecycle', () => {
  beforeEach(() => {
    resetPluginInitState();
  });

  it('publishes claims after successful plugin init', async () => {
    registerPluginInit({
      'route-owner': ({ registerRouteResolver }) => {
        registerRouteResolver(({ config }) => (
          config.enabled ? [{ path: '/route-owner', match: 'prefix' }] : []
        ));
      },
    }, { addHook, HookPoints: {} as any });

    const ctx = mockCtx();
    await setActivatedPlugins(ctx, ['route-owner']);

    expect(isPluginRoute('/route-owner')).toBe(false);
    refreshPluginRoutes(ctx.activatedPlugins, () => ({ enabled: true }));
    expect(isPluginRoute('/route-owner')).toBe(true);
    expect(isPluginRoute('/route-owner/child')).toBe(true);
    expect(isPluginRoute('/route-ownerish')).toBe(false);
  });

  it('clears stale claims when plugin init fails', async () => {
    registerPluginRouteResolver('route-failed', () => [
      { path: '/stale-route', match: 'prefix' },
    ]);
    markPluginRouteResolverReady('route-failed');
    refreshPluginRoutes(new Set(['route-failed']), () => ({}));
    expect(isPluginRoute('/stale-route')).toBe(true);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerPluginInit({
      'route-failed': ({ registerRouteResolver }) => {
        registerRouteResolver(() => [{ path: '/new-route' }]);
        throw new Error('route init failed');
      },
    }, { addHook, HookPoints: {} as any });

    const ctx = mockCtx();
    await setActivatedPlugins(ctx, ['route-failed']);
    refreshPluginRoutes(ctx.activatedPlugins, () => ({}));

    expect(isPluginRoute('/stale-route')).toBe(false);
    expect(isPluginRoute('/new-route')).toBe(false);
    errorSpy.mockRestore();
  });

  it('resets route resolver state with plugin init state', async () => {
    registerPluginInit({
      'route-reset': ({ registerRouteResolver }) => {
        registerRouteResolver(() => [{ path: '/reset-route' }]);
      },
    }, { addHook, HookPoints: {} as any });

    const ctx = mockCtx();
    await setActivatedPlugins(ctx, ['route-reset']);
    refreshPluginRoutes(ctx.activatedPlugins, () => ({}));
    expect(isPluginRoute('/reset-route')).toBe(true);

    resetPluginInitState();
    expect(isPluginRoute('/reset-route')).toBe(false);
  });

  it('scopes admin path claims to the owning plugin lifecycle', async () => {
    registerPluginInit({
      'admin-path-owner': ({ registerAdminPath }) => {
        registerAdminPath('/api/admin/owned');
      },
      'admin-path-failed': ({ registerAdminPath }) => {
        registerAdminPath('/api/admin/failed');
        throw new Error('admin path init failed');
      },
    }, { addHook, HookPoints: {} as any });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = mockCtx();

    await setActivatedPlugins(ctx, ['admin-path-owner']);
    expect(isPluginAdminPath('/api/admin/owned')).toBe(true);

    // A failed owner never keeps its claim, and other owners are untouched.
    await setActivatedPlugins(ctx, ['admin-path-owner', 'admin-path-failed']);
    expect(isPluginAdminPath('/api/admin/failed')).toBe(false);
    expect(isPluginAdminPath('/api/admin/owned')).toBe(true);

    // Disabling the owner releases its claim...
    await setActivatedPlugins(ctx, ['admin-path-failed']);
    expect(isPluginAdminPath('/api/admin/owned')).toBe(false);

    // ...and re-enabling re-registers it before the registry is reset.
    await setActivatedPlugins(ctx, ['admin-path-owner']);
    expect(isPluginAdminPath('/api/admin/owned')).toBe(true);
    resetPluginInitState();
    expect(isPluginAdminPath('/api/admin/owned')).toBe(false);
    errorSpy.mockRestore();
  });
});
