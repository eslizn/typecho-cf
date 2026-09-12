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
): ReadonlySet<string> {
  ownerClaims.clear();
  const failedOwners = new Set<string>();
  const candidates = new Map<string, PluginRouteClaim[]>();

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
        candidates.set(pluginId, normalizedClaims);
      }
    } catch (error) {
      failedOwners.add(pluginId);
      console.error(`[plugin-routes] Failed to resolve routes for ${pluginId}:`, error);
    }
  }

  // Resolvers are one per plugin and this runs once per request bootstrap, so
  // the pairwise owner comparison stays cheap at the current plugin scale.
  const conflictedOwners = new Set<string>();
  const candidateEntries = [...candidates.entries()];
  for (let leftIndex = 0; leftIndex < candidateEntries.length; leftIndex += 1) {
    const [leftOwner, leftClaims] = candidateEntries[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < candidateEntries.length; rightIndex += 1) {
      const [rightOwner, rightClaims] = candidateEntries[rightIndex];
      const conflict = leftClaims.some(leftClaim =>
        rightClaims.some(rightClaim => claimsOverlap(leftClaim, rightClaim)),
      );
      if (!conflict) continue;

      conflictedOwners.add(leftOwner);
      conflictedOwners.add(rightOwner);
      console.error(
        `[plugin-routes] Conflicting route claims between ${leftOwner} and ${rightOwner}`,
      );
    }
  }

  for (const [pluginId, claims] of candidates) {
    if (conflictedOwners.has(pluginId)) {
      failedOwners.add(pluginId);
      continue;
    }
    ownerClaims.set(pluginId, claims);
  }

  return failedOwners;
}

/**
 * Copy the current claims for use by one request.
 *
 * The module-level registry is refreshed when a request is bootstrapped, but
 * request handlers can yield between routing decisions. A snapshot prevents
 * a later request (for example, one observing a newly saved route) from
 * changing the result for an earlier request that is still in flight.
 */
export function getPluginRouteClaimsSnapshot(): ReadonlyArray<PluginRouteClaim> {
  return Object.freeze(
    [...ownerClaims.values()]
      .flatMap(claims => claims.map(claim => Object.freeze({ ...claim }))),
  );
}

/** Return whether a request path is claimed by any active plugin route. */
export function isPluginRoute(
  path: string,
  routeClaims?: ReadonlyArray<PluginRouteClaim>,
): boolean {
  if (typeof path !== 'string') return false;

  const claims = routeClaims ?? [...ownerClaims.values()].flat();
  for (const claim of claims) {
    if (claim.match === 'exact') {
      if (path === claim.path) return true;
    } else if (path === claim.path || path.startsWith(`${claim.path}/`)) {
      return true;
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

function claimsOverlap(left: PluginRouteClaim, right: PluginRouteClaim): boolean {
  if (left.match === 'exact' && right.match === 'exact') {
    return left.path === right.path;
  }

  if (left.match === 'exact') return prefixClaimMatchesPath(right.path, left.path);
  if (right.match === 'exact') return prefixClaimMatchesPath(left.path, right.path);

  return (
    prefixClaimMatchesPath(left.path, right.path) ||
    prefixClaimMatchesPath(right.path, left.path)
  );
}

function prefixClaimMatchesPath(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}
