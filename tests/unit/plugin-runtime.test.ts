/**
 * Tests for the plugin runtime helpers introduced in Group 6.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addHook,
  doHook,
  applyFilter,
  hasHook,
  normalizeHookPoint,
  removePluginHooks,
  setActivatedPlugins,
  registerPluginInit,
  registerPluginLoaders,
  registerPluginRoute,
  isPluginRoute,
  getPluginInitFailures,
  resetPluginInitState,
  type HookContext,
} from '@/lib/plugin';

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
    const bad = vi.fn(() => { throw new Error('boom'); });
    registerPluginInit({ 'lazy-good': good, 'lazy-bad': bad }, { addHook, HookPoints: {} as any });
    const ctx = mockCtx();
    await expect(setActivatedPlugins(ctx, ['lazy-bad', 'lazy-good'])).resolves.toBeUndefined();
    expect(good).toHaveBeenCalled();
    expect(bad).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    expect(getPluginInitFailures()['lazy-bad']?.error).toBe('boom');
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
});

describe('plugin front-end route table', () => {
  it('matches registered routes and their sub-paths', () => {
    registerPluginRoute('/unit-test-route');
    expect(isPluginRoute('/unit-test-route')).toBe(true);
    expect(isPluginRoute('/unit-test-route/sub/path')).toBe(true);
    expect(isPluginRoute('/unit-test-routeish')).toBe(false);
    expect(isPluginRoute('/unrelated')).toBe(false);
  });
});
