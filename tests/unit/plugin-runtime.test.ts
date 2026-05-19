/**
 * Tests for the plugin runtime helpers introduced in Group 6.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addHook,
  doHook,
  applyFilter,
  hasHook,
  setActivatedPlugins,
  registerPluginInit,
} from '@/lib/plugin';

describe('addHook deduplication (G6-1)', () => {
  beforeEach(() => {
    setActivatedPlugins(['p-dedupe']);
  });

  it('does not register the same handler twice for the same plugin', async () => {
    const calls: string[] = [];
    const handler = () => { calls.push('hit'); };
    addHook('post:finishPublish', 'p-dedupe', handler);
    addHook('post:finishPublish', 'p-dedupe', handler);
    expect(hasHook('post:finishPublish')).toBe(true);
    await doHook('post:finishPublish', { cid: 1 });
    expect(calls).toEqual(['hit']);
  });

  it('still registers different handlers from the same plugin', async () => {
    const calls: string[] = [];
    addHook('post:finishSave', 'p-dedupe', () => calls.push('a'));
    addHook('post:finishSave', 'p-dedupe', () => calls.push('b'));
    await doHook('post:finishSave', {});
    expect(calls.sort()).toEqual(['a', 'b']);
  });
});

describe('lazy plugin init (G6-3)', () => {
  it('only runs init for plugins listed as active', () => {
    const inits = {
      'lazy-a': vi.fn(),
      'lazy-b': vi.fn(),
    };
    registerPluginInit(inits, { addHook, HookPoints: {} as any });

    setActivatedPlugins(['lazy-a']);
    expect(inits['lazy-a']).toHaveBeenCalledTimes(1);
    expect(inits['lazy-b']).not.toHaveBeenCalled();

    // Reactivating the same plugin must not run init twice — the
    // module is already side-effected.
    setActivatedPlugins(['lazy-a']);
    expect(inits['lazy-a']).toHaveBeenCalledTimes(1);

    // Activating a previously dormant plugin runs its init now.
    setActivatedPlugins(['lazy-a', 'lazy-b']);
    expect(inits['lazy-b']).toHaveBeenCalledTimes(1);
  });

  it('isolates init failures per plugin', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good = vi.fn();
    const bad = vi.fn(() => { throw new Error('boom'); });
    registerPluginInit({ 'lazy-good': good, 'lazy-bad': bad }, { addHook, HookPoints: {} as any });
    expect(() => setActivatedPlugins(['lazy-bad', 'lazy-good'])).not.toThrow();
    expect(good).toHaveBeenCalled();
    expect(bad).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
