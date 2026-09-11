import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPluginRouteClaims,
  getPluginRouteClaimsSnapshot,
  isPluginRoute,
  markPluginRouteResolverReady,
  refreshPluginRoutes,
  registerPluginRouteResolver,
  resetPluginRouteRegistry,
} from '@/lib/plugin-routes';

describe('owner-scoped plugin route registry', () => {
  beforeEach(() => {
    resetPluginRouteRegistry();
  });

  it('refreshes claims from current owner config and releases the previous path', () => {
    registerPluginRouteResolver('owner', ({ config }) => [
      { path: String(config.path), match: 'prefix' },
    ]);
    markPluginRouteResolverReady('owner');

    refreshPluginRoutes(new Set(['owner']), () => ({ path: '/first' }));
    expect(isPluginRoute('/first/file')).toBe(true);

    refreshPluginRoutes(new Set(['owner']), () => ({ path: '/second' }));
    expect(isPluginRoute('/first/file')).toBe(false);
    expect(isPluginRoute('/second/file')).toBe(true);
  });

  it('keeps a request snapshot stable when the registry is refreshed later', () => {
    registerPluginRouteResolver('owner', ({ config }) => [
      { path: String(config.path), match: 'prefix' },
    ]);
    markPluginRouteResolverReady('owner');

    refreshPluginRoutes(new Set(['owner']), () => ({ path: '/first' }));
    const snapshot = getPluginRouteClaimsSnapshot();
    refreshPluginRoutes(new Set(['owner']), () => ({ path: '/second' }));

    expect(isPluginRoute('/first/file', snapshot)).toBe(true);
    expect(isPluginRoute('/second/file', snapshot)).toBe(false);
    expect(isPluginRoute('/first/file')).toBe(false);
    expect(isPluginRoute('/second/file')).toBe(true);
  });

  it('does not expose claims from inactive or unready owners', () => {
    registerPluginRouteResolver('owner', () => [{ path: '/private' }]);
    refreshPluginRoutes(new Set(['owner']), () => ({}));
    expect(isPluginRoute('/private')).toBe(false);

    markPluginRouteResolverReady('owner');
    refreshPluginRoutes(new Set(), () => ({}));
    expect(isPluginRoute('/private')).toBe(false);
  });

  it('supports exact claims and rejects malformed paths', () => {
    registerPluginRouteResolver('owner', () => [
      { path: '/exact', match: 'exact' },
      { path: 'bad?query', match: 'prefix' },
    ]);
    markPluginRouteResolverReady('owner');
    refreshPluginRoutes(new Set(['owner']), () => ({}));

    expect(isPluginRoute('/exact')).toBe(true);
    expect(isPluginRoute('/exact/child')).toBe(false);
    expect(isPluginRoute('/bad')).toBe(false);
  });

  it('normalizes trailing slashes and deduplicates claims', () => {
    const resolver = vi.fn(() => [
      { path: '/files/', match: 'prefix' as const },
      { path: '/files', match: 'prefix' as const },
    ]);
    registerPluginRouteResolver('owner', resolver);
    markPluginRouteResolverReady('owner');

    refreshPluginRoutes(new Set(['owner']), () => ({}));

    expect(resolver).toHaveBeenCalledOnce();
    expect(isPluginRoute('/files')).toBe(true);
    expect(isPluginRoute('/files/item')).toBe(true);
    expect(isPluginRoute('/files-other')).toBe(false);
  });

  it('clears claims without removing the resolver', () => {
    registerPluginRouteResolver('owner', () => [{ path: '/temporary' }]);
    markPluginRouteResolverReady('owner');
    refreshPluginRoutes(new Set(['owner']), () => ({}));
    expect(isPluginRoute('/temporary')).toBe(true);

    clearPluginRouteClaims('owner');
    expect(isPluginRoute('/temporary')).toBe(false);

    refreshPluginRoutes(new Set(['owner']), () => ({}));
    expect(isPluginRoute('/temporary')).toBe(true);
  });

  it('fails closed when a resolver or config getter throws', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerPluginRouteResolver('resolver-error', () => {
      throw new Error('resolver failed');
    });
    registerPluginRouteResolver('config-error', () => [{ path: '/config-error' }]);
    markPluginRouteResolverReady('resolver-error');
    markPluginRouteResolverReady('config-error');

    const failedOwners = refreshPluginRoutes(
      new Set(['resolver-error', 'config-error']),
      pluginId => {
        if (pluginId === 'config-error') throw new Error('config failed');
        return {};
      },
    );

    expect(isPluginRoute('/resolver-error')).toBe(false);
    expect(isPluginRoute('/config-error')).toBe(false);
    expect(failedOwners).toEqual(new Set(['resolver-error', 'config-error']));
    expect(errorSpy).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });

  it('fails closed for overlapping claims from different owners', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerPluginRouteResolver('exact-left', () => [{ path: '/same', match: 'exact' }]);
    registerPluginRouteResolver('exact-right', () => [{ path: '/same', match: 'exact' }]);
    registerPluginRouteResolver('exact-child', () => [{ path: '/mount/item', match: 'exact' }]);
    registerPluginRouteResolver('prefix-parent', () => [{ path: '/mount', match: 'prefix' }]);
    registerPluginRouteResolver('prefix-root', () => [{ path: '/tree', match: 'prefix' }]);
    registerPluginRouteResolver('prefix-child', () => [{ path: '/tree/branch', match: 'prefix' }]);
    registerPluginRouteResolver('safe', () => [{ path: '/foo', match: 'prefix' }]);
    registerPluginRouteResolver('boundary', () => [{ path: '/foo-bar', match: 'exact' }]);

    for (const owner of [
      'exact-left',
      'exact-right',
      'exact-child',
      'prefix-parent',
      'prefix-root',
      'prefix-child',
      'safe',
      'boundary',
    ]) {
      markPluginRouteResolverReady(owner);
    }

    const failedOwners = refreshPluginRoutes(
      new Set([
        'exact-left',
        'exact-right',
        'exact-child',
        'prefix-parent',
        'prefix-root',
        'prefix-child',
        'safe',
        'boundary',
      ]),
      () => ({}),
    );

    expect(failedOwners).toEqual(
      new Set([
        'exact-left',
        'exact-right',
        'exact-child',
        'prefix-parent',
        'prefix-root',
        'prefix-child',
      ]),
    );
    expect(isPluginRoute('/same')).toBe(false);
    expect(isPluginRoute('/mount')).toBe(false);
    expect(isPluginRoute('/mount/item')).toBe(false);
    expect(isPluginRoute('/tree/branch/file')).toBe(false);
    expect(isPluginRoute('/foo')).toBe(true);
    expect(isPluginRoute('/foo/file')).toBe(true);
    expect(isPluginRoute('/foo-bar')).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('rejects root, query, fragment, backslash, traversal, and invalid match claims', () => {
    registerPluginRouteResolver('owner', () => [
      { path: '/', match: 'prefix' },
      { path: '/query?x=1', match: 'prefix' },
      { path: '/fragment#section', match: 'prefix' },
      { path: '/back\\slash', match: 'prefix' },
      { path: '/safe/../private', match: 'prefix' },
      { path: '/invalid-match', match: 'contains' as 'prefix' },
      { path: '/valid', match: 'prefix' },
    ]);
    markPluginRouteResolverReady('owner');
    refreshPluginRoutes(new Set(['owner']), () => ({}));

    expect(isPluginRoute('/')).toBe(false);
    expect(isPluginRoute('/query')).toBe(false);
    expect(isPluginRoute('/fragment')).toBe(false);
    expect(isPluginRoute('/back/slash')).toBe(false);
    expect(isPluginRoute('/private')).toBe(false);
    expect(isPluginRoute('/invalid-match')).toBe(false);
    expect(isPluginRoute('/valid')).toBe(true);
  });

  it('reset removes resolvers, readiness, and claims', () => {
    registerPluginRouteResolver('owner', () => [{ path: '/reset-me' }]);
    markPluginRouteResolverReady('owner');
    refreshPluginRoutes(new Set(['owner']), () => ({}));
    expect(isPluginRoute('/reset-me')).toBe(true);

    resetPluginRouteRegistry();
    refreshPluginRoutes(new Set(['owner']), () => ({}));
    expect(isPluginRoute('/reset-me')).toBe(false);
  });
});
