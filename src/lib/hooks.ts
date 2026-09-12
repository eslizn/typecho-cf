/**
 * Hook registry plus the call/filter executors.
 *
 * Hook points are canonical strings owned by this module. Plugins register
 * through addHook(); the request pipeline dispatches through doHook(),
 * applyFilter(), and applyFilterSafely(). HookContext stays in ./plugin, so
 * this module keeps only a type-only import back to it.
 */
import type { HookContext } from './plugin';

export type CallHandler = (...args: any[]) => void | Promise<void>;
export type FilterHandler = (value: any, ...args: any[]) => any | Promise<any>;
interface HookRegistration {
  pluginId: string;
  handler: CallHandler | FilterHandler;
  priority: number;
}

// ==================== Hook Definitions ====================

/**
 * Canonical hook point definitions.
 *
 * Hook names intentionally describe the resource and lifecycle stage. The
 * deprecated aliases below remain accepted by the public API so existing
 * plugins keep working while new plugins can use one consistent vocabulary.
 */
const CanonicalHookPoints = {
  // --- Request lifecycle ---
  'request:begin': 'request:begin',
  'request:end': 'request:end',
  'request:route': 'request:route',

  // --- Admin UI ---
  'admin:head': 'admin:head',
  'admin:footer': 'admin:footer',
  'admin:nav': 'admin:nav',
  'admin:begin': 'admin:begin',
  'admin:end': 'admin:end',
  'admin:login:head': 'admin:login:head',
  'admin:login:form': 'admin:login:form',
  'admin:page': 'admin:page',
  'admin:writePost:option': 'admin:writePost:option',
  'admin:writePost:advanceOption': 'admin:writePost:advanceOption',
  'admin:writePost:bottom': 'admin:writePost:bottom',
  'admin:managePosts:titleActions': 'admin:managePosts:titleActions',
  'admin:writePage:option': 'admin:writePage:option',
  'admin:writePage:advanceOption': 'admin:writePage:advanceOption',
  'admin:writePage:bottom': 'admin:writePage:bottom',
  'admin:profile:bottom': 'admin:profile:bottom',
  'plugin:config:beforeSave': 'plugin:config:beforeSave',

  // --- Frontend archives and render lifecycle ---
  'archive:query': 'archive:query',
  'archive:init': 'archive:init',
  'archive:beforeRender': 'archive:beforeRender',
  'archive:afterRender': 'archive:afterRender',
  'archive:index': 'archive:index',
  'archive:single': 'archive:single',
  'archive:category': 'archive:category',
  'archive:tag': 'archive:tag',
  'archive:author': 'archive:author',
  'archive:search': 'archive:search',
  'frontend:head': 'frontend:head',
  'frontend:footer': 'frontend:footer',

  // --- Content and comment display ---
  'content:data': 'content:data',
  'content:title': 'content:title',
  'content:excerpt': 'content:excerpt',
  'content:markdown': 'content:markdown',
  'content:rendered': 'content:rendered',
  'comment:data': 'comment:data',
  'comment:rendered': 'comment:rendered',
  'comment:markdown': 'comment:markdown',

  // --- Content management ---
  'post:write': 'post:write',
  'post:afterPublish': 'post:afterPublish',
  'post:afterSave': 'post:afterSave',
  'post:beforeDelete': 'post:beforeDelete',
  'post:afterDelete': 'post:afterDelete',
  'page:write': 'page:write',
  'page:afterPublish': 'page:afterPublish',
  'page:afterSave': 'page:afterSave',
  'page:beforeDelete': 'page:beforeDelete',
  'page:afterDelete': 'page:afterDelete',

  // --- Comment and incoming feedback ---
  'comment:beforeSave': 'comment:beforeSave',
  'comment:afterCreate': 'comment:afterCreate',
  'feedback:trackback:before': 'feedback:trackback:before',
  'feedback:trackback:after': 'feedback:trackback:after',
  'feedback:pingback:before': 'feedback:pingback:before',
  'feedback:pingback:after': 'feedback:pingback:after',
  'comment:reply': 'comment:reply',
  'comment:action': 'comment:action',

  // --- User system ---
  'user:login:before': 'user:login:before',
  'user:login:success': 'user:login:success',
  'user:login:failure': 'user:login:failure',
  'user:logout': 'user:logout',
  'user:register:before': 'user:register:before',
  'user:register:after': 'user:register:after',

  // --- File upload ---
  'upload:before': 'upload:before',
  'upload:after': 'upload:after',
  'upload:delete': 'upload:delete',

  // --- Feed, sidebar, and infrastructure ---
  'feed:item': 'feed:item',
  'feed:render': 'feed:render',
  'sidebar:data': 'sidebar:data',
  'csp:directives': 'csp:directives',
} as const;

/** @deprecated Hook names retained for third-party plugin compatibility. */
export const DeprecatedHookPointAliases = {
  'system:begin': 'request:begin',
  'system:end': 'request:end',
  'route:request': 'request:route',
  'admin:header': 'admin:head',
  'admin:navBar': 'admin:nav',
  'admin:loginHead': 'admin:login:head',
  'admin:loginForm': 'admin:login:form',
  'archive:select': 'archive:query',
  'archive:handleInit': 'archive:init',
  'archive:header': 'frontend:head',
  'archive:footer': 'frontend:footer',
  'archive:indexHandle': 'archive:index',
  'archive:singleHandle': 'archive:single',
  'archive:categoryHandle': 'archive:category',
  'archive:tagHandle': 'archive:tag',
  'archive:searchHandle': 'archive:search',
  'content:filter': 'content:data',
  'content:content': 'content:rendered',
  'comment:filter': 'comment:data',
  'comment:content': 'comment:rendered',
  'post:finishPublish': 'post:afterPublish',
  'post:finishSave': 'post:afterSave',
  'post:delete': 'post:beforeDelete',
  'post:finishDelete': 'post:afterDelete',
  'page:finishPublish': 'page:afterPublish',
  'page:finishSave': 'page:afterSave',
  'page:delete': 'page:beforeDelete',
  'page:finishDelete': 'page:afterDelete',
  'feedback:comment': 'comment:beforeSave',
  'feedback:finishComment': 'comment:afterCreate',
  'feedback:trackback': 'feedback:trackback:before',
  'feedback:finishTrackback': 'feedback:trackback:after',
  'feedback:pingback': 'feedback:pingback:before',
  'feedback:finishPingback': 'feedback:pingback:after',
  'feedback:reply': 'comment:reply',
  'user:login': 'user:login:before',
  'user:loginSucceed': 'user:login:success',
  'user:loginFail': 'user:login:failure',
  'user:register': 'user:register:before',
  'user:finishRegister': 'user:register:after',
  'upload:beforeUpload': 'upload:before',
  'upload:upload': 'upload:after',
  'feed:generate': 'feed:render',
  'widget:sidebar': 'sidebar:data',
} as const satisfies Record<string, typeof CanonicalHookPoints[keyof typeof CanonicalHookPoints]>;

/**
 * Public constants include canonical names and deprecated keys whose values
 * already point at the canonical registry key.
 */
export const HookPoints = {
  ...CanonicalHookPoints,
  ...DeprecatedHookPointAliases,
} as const;

export type HookPoint = typeof CanonicalHookPoints[keyof typeof CanonicalHookPoints];

/** Normalize static aliases and the dynamic plugin action authorization hook. */
export function normalizeHookPoint(hookPoint: string): string {
  const alias = DeprecatedHookPointAliases[hookPoint as keyof typeof DeprecatedHookPointAliases];
  if (alias) return alias;
  if (hookPoint.endsWith(':action:auth')) {
    return `${hookPoint.slice(0, -':auth'.length)}:authorize`;
  }
  return hookPoint;
}

// ==================== Plugin Registry ====================

/**
 * Module-level state — safe in Cloudflare Workers because:
 * 1. Workers are single-threaded: only one request executes at a time per isolate
 * 2. pluginRegistry and hookRegistry are populated once at module init (build time)
 *    and are effectively read-only at runtime
 * 3. Per-request state (activatedPlugins) lives on RequestContext and is passed
 *    explicitly as the first argument to hook functions.
 */

/**
 * Registry of all discovered plugins
 * Key: plugin ID, Value: PluginInfo
 */
const hookRegistry = new Map<string, HookRegistration[]>();

// ── Lazy initialiser table (G6-3) ────────────────────────────────────────
// Populated at module load by plugin-loader's injected
// `registerPluginLoaders` call. Initialisation and module evaluation are
// deferred to `setActivatedPlugins`, so disabled plugins stay out of the
// isolate startup path.
export function addHook(
  hookPoint: string,
  pluginId: string,
  handler: CallHandler | FilterHandler,
  priority = 10,
): void {
  const normalizedPoint = normalizeHookPoint(hookPoint);
  if (!hookRegistry.has(normalizedPoint)) {
    hookRegistry.set(normalizedPoint, []);
  }
  const handlers = hookRegistry.get(normalizedPoint)!;
  if (handlers.some(h => h.pluginId === pluginId && h.handler === handler)) {
    return;
  }
  handlers.push({ pluginId, handler, priority });
  // Keep sorted by priority
  handlers.sort((a, b) => a.priority - b.priority);
}

/**
 * Remove all hook handlers for a specific plugin
 */
export function removePluginHooks(pluginId: string): void {
  for (const [hookPoint, handlers] of hookRegistry) {
    const filtered = handlers.filter(h => h.pluginId !== pluginId);
    if (filtered.length === 0) {
      hookRegistry.delete(hookPoint);
    } else {
      hookRegistry.set(hookPoint, filtered);
    }
  }
}

/**
 * Execute a "call" hook - runs all handlers for the given hook point.
 * Only executes handlers from activated plugins.
 * 
 * @param hookPoint - The hook point name
 * @param args - Arguments to pass to handlers
 */
export async function doHook(ctx: HookContext, hookPoint: string, ...args: any[]): Promise<void> {
  const normalizedPoint = normalizeHookPoint(hookPoint);
  if (!hasHook(ctx, normalizedPoint)) return;

  for (const reg of hookRegistry.get(normalizedPoint)!) {
    if (!ctx.activatedPlugins.has(reg.pluginId)) continue;
    try {
      await (reg.handler as CallHandler)(...args);
    } catch (err) {
      console.error(`[plugin] Error in hook ${normalizedPoint} from plugin ${reg.pluginId}:`, err);
    }
  }
}

/**
 * Execute a "filter" hook - passes a value through all handlers.
 * Each handler receives the current value and must return the (possibly modified) value.
 * Only executes handlers from activated plugins.
 *
 * @param ctx - Request context (or minimal HookContext)
 * @param hookPoint - The hook point name
 * @param value - The initial value to filter
 * @param args - Additional arguments to pass to handlers
 * @returns The filtered value
 */
export async function applyFilter(ctx: HookContext, hookPoint: string, value: any, ...args: any[]): Promise<any> {
  const normalizedPoint = normalizeHookPoint(hookPoint);
  if (!hasHook(ctx, normalizedPoint)) return value;

  let result = value;
  for (const reg of hookRegistry.get(normalizedPoint)!) {
    if (!ctx.activatedPlugins.has(reg.pluginId)) continue;
    if (normalizedPoint === 'request:route' && ctx.routeResolverFailures?.has(reg.pluginId)) {
      continue;
    }
    try {
      result = await (reg.handler as FilterHandler)(result, ...args);
    } catch (err) {
      console.error(`[plugin] Error in filter ${normalizedPoint} from plugin ${reg.pluginId}:`, err);
      throw err;
    }
  }
  return result;
}

/**
 * Execute a filter hook while isolating plugin failures.
 * Use only for non-critical presentation hooks where missing plugin output is
 * preferable to failing the entire page.
 */
export async function applyFilterSafely(ctx: HookContext, hookPoint: string, value: any, ...args: any[]): Promise<any> {
  const normalizedPoint = normalizeHookPoint(hookPoint);
  if (!hasHook(ctx, normalizedPoint)) return value;

  let result = value;
  for (const reg of hookRegistry.get(normalizedPoint)!) {
    if (!ctx.activatedPlugins.has(reg.pluginId)) continue;
    if (normalizedPoint === 'request:route' && ctx.routeResolverFailures?.has(reg.pluginId)) {
      continue;
    }
    try {
      result = await (reg.handler as FilterHandler)(result, ...args);
    } catch (err) {
      console.error(`[plugin] Error in safe filter ${normalizedPoint} from plugin ${reg.pluginId}:`, err);
    }
  }
  return result;
}

/**
 * Check if a hook point has any registered handlers
 */
export function hasHook(ctx: HookContext, hookPoint: string): boolean {
  const handlers = hookRegistry.get(normalizeHookPoint(hookPoint));
  if (!handlers) return false;
  return handlers.some(h => ctx.activatedPlugins.has(h.pluginId));
}

/**
 * Get all registered hook points (for debugging/admin)
 */
export function getRegisteredHooks(): Map<string, { pluginId: string; priority: number }[]> {
  const result = new Map<string, { pluginId: string; priority: number }[]>();
  for (const [hookPoint, handlers] of hookRegistry) {
    result.set(hookPoint, handlers.map(h => ({
      pluginId: h.pluginId,
      priority: h.priority,
    })));
  }
  return result;
}

// ==================== Plugin Activation Helpers ====================

/**
 * Serialize activated plugins list to string for DB storage
 */
