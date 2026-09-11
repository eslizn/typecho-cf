import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPluginRouteClaims,
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

    refreshPluginRoutes(new Set(['resolver-error', 'config-error']), pluginId => {
      if (pluginId === 'config-error') throw new Error('config failed');
      return {};
    });

    expect(isPluginRoute('/resolver-error')).toBe(false);
    expect(isPluginRoute('/config-error')).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(2);
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
