/**
 * Synchronous, owner-scoped route claims for plugins.
 *
 * Resolvers are registered during plugin initialisation, but their claims are
 * rebuilt from the current activation set and owner configuration before
 * request routing decisions are made.
 */

export interface PluginRouteClaim {
  path: string;
  match?: 'exact' | 'prefix';
}

export interface PluginRouteResolverContext {
  config: Readonly<Record<string, unknown>>;
}

export type PluginRouteResolver = (
  context: PluginRouteResolverContext,
) => ReadonlyArray<PluginRouteClaim>;

const resolvers = new Map<string, PluginRouteResolver>();
const readyOwners = new Set<string>();
const ownerClaims = new Map<string, PluginRouteClaim[]>();

/**
 * Register or replace one owner's resolver.
 *
 * A replacement is not ready until it is explicitly marked ready again, so a
 * stale claim cannot remain visible across an initialisation attempt.
 */
export function registerPluginRouteResolver(
  pluginId: string,
  resolver: PluginRouteResolver,
): void {
  resolvers.set(pluginId, resolver);
  readyOwners.delete(pluginId);
  ownerClaims.delete(pluginId);
}

/** Mark a registered resolver as safe to publish claims. */
export function markPluginRouteResolverReady(pluginId: string): void {
  if (resolvers.has(pluginId)) readyOwners.add(pluginId);
}

/** Remove the current claims while retaining the resolver for reactivation. */
export function clearPluginRouteClaims(pluginId: string): void {
  ownerClaims.delete(pluginId);
}

/**
 * Rebuild all active route claims from the current activation set.
 *
 * This function is intentionally synchronous. Resolvers may inspect only the
 * already-loaded owner configuration; they must not perform I/O.
 */
export function refreshPluginRoutes(
  activePluginIds: ReadonlySet<string>,
  getConfig: (pluginId: string) => Readonly<Record<string, unknown>>,
): void {
  ownerClaims.clear();

  for (const pluginId of activePluginIds) {
    if (!readyOwners.has(pluginId)) continue;

    const resolver = resolvers.get(pluginId);
    if (!resolver) continue;

    try {
      const claims = resolver({ config: getConfig(pluginId) });
      if (!Array.isArray(claims)) {
        throw new TypeError('route resolver must return an array');
      }

      const normalizedClaims: PluginRouteClaim[] = [];
      const seen = new Set<string>();
      for (const claim of claims) {
        if (!claim || typeof claim !== 'object') continue;

        const path = normalizeRoutePath(claim.path);
        if (!path) continue;

        const match = claim.match ?? 'prefix';
        if (match !== 'exact' && match !== 'prefix') continue;

        const key = `${match}:${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        normalizedClaims.push({ path, match });
      }

      if (normalizedClaims.length > 0) {
        ownerClaims.set(pluginId, normalizedClaims);
      }
    } catch (error) {
      console.error(`[plugin-routes] Failed to resolve routes for ${pluginId}:`, error);
    }
  }
}

/** Return whether a request path is claimed by any active plugin route. */
export function isPluginRoute(path: string): boolean {
  if (typeof path !== 'string') return false;

  for (const claims of ownerClaims.values()) {
    for (const claim of claims) {
      if (claim.match === 'exact') {
        if (path === claim.path) return true;
      } else if (path === claim.path || path.startsWith(`${claim.path}/`)) {
        return true;
      }
    }
  }
  return false;
}

/** Test-only reset for the module-level registry. */
export function resetPluginRouteRegistry(): void {
  resolvers.clear();
  readyOwners.clear();
  ownerClaims.clear();
}

function normalizeRoutePath(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0) return null;
  if (!path.startsWith('/') || path === '/') return null;
  if (path.startsWith('//')) return null;
  if (path.includes('?') || path.includes('#') || path.includes('\\')) return null;

  const segments = path.split('/');
  if (segments.some(segment => segment === '..')) return null;

  const normalized = path.replace(/\/+$/, '');
  return normalized === '/' ? null : normalized;
}
