/**
 * Plugin system - discovers and manages plugins from npm packages
 * 
 * Plugin packages are identified by their package.json keywords
 * containing both "typecho" and "plugin".
 * 
 * Hook types (following Typecho conventions):
 * - call: Action hooks - execute side effects at specific points
 * - filter: Filter hooks - transform data through a chain of handlers
 * 
 * Plugin package structure:
 *   typecho-plugin-example/
 *     package.json       - Must have keywords: ["typecho", "plugin"] + typecho.plugin manifest
 *     index.ts/js        - Plugin entry point (required)
 */

import {
  getConfigDefaults,
  loadConfig,
  parseConfigFormData,
  type ConfigField,
} from '@/lib/config';
import {
  beginPluginTranslationStage,
  commitPluginTranslationStage,
  discardPluginTranslationStage,
  getAvailableTranslationLocales,
  getGlobalTranslationCatalogs,
  getTranslationCatalogVersion,
  resetPluginTranslationRegistry,
  stagePluginTranslation,
} from '@/lib/i18n-registry';
import type { I18n, ResolvedLocale } from '@/lib/i18n';
import { env as runtimeEnv } from 'cloudflare:workers';
import {
  enqueueAsyncTaskMessage,
  type EnqueueAsyncTaskOptions,
} from '@/lib/tasks/enqueue';
import {
  registerAsyncTask,
  registerScheduledTask,
  resetTaskRegistrations,
  resetTaskRegistry,
} from '@/lib/tasks/registry';
import type {
  AsyncTaskDefinition,
  ScheduledTaskDefinition,
} from '@/lib/tasks/types';
import {
  clearPluginRouteClaims,
  markPluginRouteResolverReady,
  registerPluginRouteResolver,
  resetPluginRouteRegistry,
} from '@/lib/plugin-routes';
import type { PluginRouteClaim, PluginRouteResolver } from '@/lib/plugin-routes';
export {
  getPluginRouteClaimsSnapshot,
  isPluginRoute,
  refreshPluginRoutes,
} from '@/lib/plugin-routes';
export type {
  PluginRouteClaim,
  PluginRouteResolver,
  PluginRouteResolverContext,
} from '@/lib/plugin-routes';
export {
  getAvailableTranslationLocales,
  getGlobalTranslationCatalogs,
  getTranslationCatalogVersion,
} from '@/lib/i18n-registry';
export type { AvailableTranslationLocale, PluginTranslationRegistration } from '@/lib/i18n-registry';

// ==================== Types ====================

/** Internal form metadata used to preserve repeatable rows across reordering. */
export { CONFIG_ROW_ID as PLUGIN_CONFIG_ROW_ID } from '@/lib/config';

/**
 * Plugin configuration field definition.
 * Mirrors PHP Typecho's Form Element types; shared with theme config.
 */
export type PluginConfigField = ConfigField;

export interface PluginManifest {
  /** Unique plugin identifier */
  id: string;
  /** Display name */
  name: string;
  /** Plugin description */
  description?: string;
  /** Author name */
  author?: string;
  /** Author URL */
  authorUrl?: string;
  /** Plugin version */
  version?: string;
  /** Plugin homepage / repository URL */
  homepage?: string;
  /** License */
  license?: string;
  /** Tags for categorization */
  tags?: string[];
  /** Required Typecho version */
  requires?: string;
  /**
   * Plugin configuration fields.
   * If present, the admin panel shows a "设置" link for this plugin.
   * Keys are field names, values are field definitions.
   * Stored as JSON in options table under key "plugin:<id>".
   */
  config?: Record<string, PluginConfigField>;
}

export interface PluginInfo {
  /** Plugin ID (slug) */
  id: string;
  /** npm package name */
  packageName: string;
  /** Plugin manifest from package.json's typecho.plugin */
  manifest: PluginManifest;
  /** Whether this plugin is currently activated */
  isActive: boolean;
}

/**
 * Hook handler function types
 * - CallHandler: Receives context, no return value expected
 * - FilterHandler: Receives value + context, must return the (possibly modified) value
 */
export type CallHandler = (...args: any[]) => void | Promise<void>;
export type FilterHandler = (value: any, ...args: any[]) => any | Promise<any>;

export interface HookContext {
  activatedPlugins: Set<string>;
  /** Request-local copy of the route claims used by middleware. */
  routeClaims?: ReadonlyArray<PluginRouteClaim>;
  /** Request-local plugin IDs whose route resolver init failed. */
  routeResolverFailures?: ReadonlySet<string>;
  /** Request-local translator. Minimal test/plugin contexts may omit it. */
  i18n?: I18n;
  resolvedLocale?: ResolvedLocale;
}

export interface PluginInitContext {
  addHook: typeof addHook;
  HookPoints: typeof HookPoints;
  pluginId: string;
  registerRouteResolver: (resolver: PluginRouteResolver) => void;
  registerTranslations: (
    locale: string,
    messages: Record<string, string>,
    displayName?: string,
  ) => void;
  registerScheduledTask: (definition: ScheduledTaskDefinition) => void;
  registerAsyncTask: <TPayload = unknown>(
    definition: AsyncTaskDefinition<TPayload>,
  ) => void;
  enqueueAsyncTask: <TPayload = unknown>(
    taskId: string,
    payload: TPayload,
    options: EnqueueAsyncTaskOptions,
  ) => Promise<{ jobId: string; taskKey: string; idempotencyKey: string }>;
}

export interface PluginRouteResult {
  handled?: boolean;
  response?: Response;
}

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
const pluginRegistry = new Map<string, PluginInfo>();

/**
 * Hook handlers registry
 * Key: hook point name, Value: sorted array of handlers
 */
const hookRegistry = new Map<string, HookRegistration[]>();

// ── Lazy initialiser table (G6-3) ────────────────────────────────────────
// Populated at module load by plugin-loader's injected
// `registerPluginLoaders` call. Initialisation and module evaluation are
// deferred to `setActivatedPlugins`, so disabled plugins stay out of the
// isolate startup path.

type PluginInitFn = (ctx: PluginInitContext) => void | Promise<void>;
type PluginInitLoader = () => PluginInitFn | Promise<PluginInitFn>;
const pluginInitLoaders = new Map<string, PluginInitLoader>();
const initialisedPlugins = new Set<string>();
const initialisingPlugins = new Map<string, Promise<void>>();
const failedPlugins = new Map<string, { error: string; failedAt: number; attempts: number }>();
/** Backoff base between init retries after a failure (doubles up to 5×). */
const PLUGIN_INIT_FAIL_BACKOFF_MS = 60_000;
let pluginInitContext: { addHook: typeof addHook; HookPoints: typeof HookPoints } | null = null;

/** Snapshot of plugins whose lazy init failed (for admin visibility). */
export function getPluginInitFailures(): Record<string, { error: string; attempts: number; failedAt: number }> {
  const out: Record<string, { error: string; attempts: number; failedAt: number }> = {};
  for (const [id, failure] of failedPlugins) {
    out[id] = { error: failure.error, attempts: failure.attempts, failedAt: failure.failedAt };
  }
  return out;
}

/** Test-only: clear init success/failure state. */
export function resetPluginInitState(): void {
  initialisedPlugins.clear();
  initialisingPlugins.clear();
  failedPlugins.clear();
  resetPluginRouteRegistry();
  resetTaskRegistry();
  resetPluginTranslationRegistry();
}

/**
 * Plugins can register admin paths that bypass the reserved-core-path guard
 * in middleware. Call this during plugin init() for each /admin/ or /api/admin/
 * path the plugin serves via request:route.
 */
const pluginAdminPaths = new Set<string>();

export function registerPluginAdminPath(path: string): void {
  pluginAdminPaths.add(path);
}

export function isPluginAdminPath(path: string): boolean {
  return pluginAdminPaths.has(path);
}

/**
 * Backward-compatible registration Interface for tests and integrations that
 * already imported plugin init functions.
 */
export function registerPluginInit(
  inits: Record<string, PluginInitFn>,
  ctx: { addHook: typeof addHook; HookPoints: typeof HookPoints },
): void {
  registerPluginLoaders(
    Object.fromEntries(
      Object.entries(inits).map(([id, init]) => [id, () => init]),
    ),
    ctx,
  );
}

/**
 * Register deferred module loaders generated by plugin-loader. Keeping the
 * loader behind this Interface prevents disabled plugin modules from being
 * evaluated during isolate startup.
 */
export function registerPluginLoaders(
  loaders: Record<string, PluginInitLoader>,
  ctx: { addHook: typeof addHook; HookPoints: typeof HookPoints },
): void {
  pluginInitContext = ctx;
  for (const [id, loader] of Object.entries(loaders)) {
    pluginInitLoaders.set(id, loader);
  }
}

// ==================== Plugin Management ====================

/**
 * Register a plugin into the registry.
 * Called by the plugin-loader integration at build time.
 */
export function registerPlugin(
  packageName: string,
  manifest: PluginManifest,
): void {
  const id = manifest.id || packageName;
  pluginRegistry.set(id, {
    id,
    packageName,
    manifest: { ...manifest, id },
    isActive: false,
  });
}

/**
 * Set the list of activated plugin IDs (loaded from DB).
 *
 * G6-3: the first time we see a given plugin in the activated set, we
 * call its init function so its hooks land in hookRegistry. Plugins
 * that are never activated never have their init code run, which keeps
 * the per-isolate startup cost proportional to active plugin count.
 */
export async function setActivatedPlugins(ctx: HookContext, ids: string[]): Promise<void> {
  const orderedIds = [...new Set(ids.filter(id => typeof id === 'string' && id.length > 0))];
  ctx.activatedPlugins = new Set(orderedIds);
  if (!pluginInitContext) return;
  for (const id of orderedIds) {
    if (initialisedPlugins.has(id)) continue;
    const failure = failedPlugins.get(id);
    if (failure) {
      const backoff = PLUGIN_INIT_FAIL_BACKOFF_MS * Math.min(failure.attempts, 5);
      if (Date.now() - failure.failedAt < backoff) {
        // A failed plugin is not active for this request, including while its
        // retry backoff is in effect. The activation set is rebuilt on every
        // request, so this guard must be applied here as well as in catch().
        ctx.activatedPlugins.delete(id);
        continue;
      }
    }
    const existingInit = initialisingPlugins.get(id);
    if (existingInit) {
      await existingInit;
      // Another request may have owned the init attempt. Its catch() only
      // has access to that request's context, so mirror the outcome here.
      if (!initialisedPlugins.has(id)) ctx.activatedPlugins.delete(id);
      continue;
    }
    const loader = pluginInitLoaders.get(id);
    if (!loader) continue;
    const pending = Promise.resolve()
      .then(() => {
        beginPluginTranslationStage(id);
        return loader();
      })
      .then(init => init({
          addHook: pluginInitContext!.addHook,
          HookPoints: pluginInitContext!.HookPoints,
          pluginId: id,
          registerRouteResolver: (resolver: PluginRouteResolver) => {
            registerPluginRouteResolver(id, resolver);
          },
          registerTranslations: (locale, messages, displayName) => {
            stagePluginTranslation(id, locale, messages, displayName);
          },
          registerScheduledTask: (definition: ScheduledTaskDefinition) => {
            registerScheduledTask(id, definition);
          },
          registerAsyncTask: <TPayload>(definition: AsyncTaskDefinition<TPayload>) => {
            registerAsyncTask(id, definition);
          },
          enqueueAsyncTask: <TPayload>(
            taskId: string,
            payload: TPayload,
            options: EnqueueAsyncTaskOptions,
          ) => enqueueAsyncTaskMessage(runtimeEnv, id, taskId, payload, options),
        }))
      .then(() => {
        commitPluginTranslationStage(id);
        initialisedPlugins.add(id);
        markPluginRouteResolverReady(id);
        failedPlugins.delete(id);
      })
      .catch(err => {
        removePluginHooks(id);
        ctx.activatedPlugins.delete(id);
        discardPluginTranslationStage(id);
        clearPluginRouteClaims(id);
        resetTaskRegistrations(id);
        const message = err instanceof Error ? err.message : String(err);
        const prior = failedPlugins.get(id);
        failedPlugins.set(id, {
          error: message,
          failedAt: Date.now(),
          attempts: (prior?.attempts ?? 0) + 1,
        });
        console.error(`[plugin] Failed to init ${id}:`, err);
      })
      .finally(() => {
        initialisingPlugins.delete(id);
      });
    initialisingPlugins.set(id, pending);
    await pending;
  }
}

/**
 * Check if a plugin is activated
 */
export function isPluginActive(ctx: HookContext, pluginId: string): boolean {
  return ctx.activatedPlugins.has(pluginId);
}

/**
 * Get all available plugins
 */
export function getAvailablePlugins(ctx: HookContext): PluginInfo[] {
  const plugins: PluginInfo[] = [];
  for (const [, info] of pluginRegistry) {
    plugins.push({
      ...info,
      isActive: ctx.activatedPlugins.has(info.id),
    });
  }
  return plugins;
}

/**
 * Get a specific plugin
 */
export function getPlugin(pluginId: string): PluginInfo | undefined {
  return pluginRegistry.get(pluginId);
}

/**
 * Get plugin count
 */
export function getPluginCount(): number {
  return pluginRegistry.size;
}

/**
 * Check if a plugin exists
 */
export function pluginExists(pluginId: string): boolean {
  return pluginRegistry.has(pluginId);
}

// ==================== Hook System ====================

/**
 * Register a hook handler for a specific hook point.
 * Only handlers from activated plugins will be executed.
 *
 * @param hookPoint - The hook point name (use HookPoints constants)
 * @param pluginId - The plugin ID registering this handler
 * @param handler - The handler function
 * @param priority - Execution priority (lower = earlier, default 10)
 *
 * G6-1: dedupes (pluginId, handler-by-reference) so repeated hook
 * registration does not run the handler twice on every request.
 */
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
export function serializeActivatedPlugins(ctx: HookContext): string {
  return JSON.stringify(Array.from(ctx.activatedPlugins));
}

/**
 * Parse activated plugins list from DB string
 */
export function parseActivatedPlugins(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr)
      ? [...new Set(arr.filter(id => typeof id === 'string' && id.length > 0))]
      : [];
  } catch {
    return [];
  }
}

// ==================== Client Snippets ====================

/**
 * Collect client-side HTML snippets from all activated plugins.
 *
 * Plugins register their frontend output by hooking into:
 *   - frontend:head (filter): receives current headHtml, returns headHtml with appended content
 *   - frontend:footer (filter): receives current bodyHtml, returns bodyHtml with appended content
 *
 * This function applies both filters and returns the aggregated result.
 * Themes should call this once and inject the HTML into <head> and before </body>.
 *
 * @param options - Site options object from loadOptions()
 * @returns {{ headHtml: string, bodyHtml: string }}
 */
export interface PageContext {
  /** Whether the current page includes a comment form */
  hasComments?: boolean;
  /** Page type hint for plugins */
  pageType?: 'index' | 'post' | 'page' | 'archive' | 'search' | 'notfound';
}

export async function getClientSnippets(
  ctx: HookContext,
  options: Record<string, any>,
  pageContext?: PageContext,
): Promise<{ headHtml: string; bodyHtml: string }> {
  const extra = { options, pageContext, i18n: ctx.i18n, resolvedLocale: ctx.resolvedLocale };
  let headHtml = await applyFilterSafely(ctx, 'frontend:head', '', extra);
  let bodyHtml = await applyFilterSafely(ctx, 'frontend:footer', '', extra);
  return { headHtml, bodyHtml };
}

// ==================== Plugin Configuration ====================

/**
 * Check if a plugin has configuration fields defined in its manifest.
 */
export function pluginHasConfig(pluginId: string): boolean {
  const info = pluginRegistry.get(pluginId);
  if (!info) return false;
  return !!info.manifest.config && Object.keys(info.manifest.config).length > 0;
}

/**
 * Get default values from plugin's config definition.
 * Returns a flat object { fieldName: defaultValue }.
 */
export function getPluginConfigDefaults(pluginId: string): Record<string, any> {
  return getConfigDefaults(pluginRegistry.get(pluginId)?.manifest.config);
}

/**
 * Parse a plugin configuration form according to the plugin manifest.
 */
export function parsePluginConfigFormData(
  configDef: Record<string, PluginConfigField>,
  formData: FormData,
): Record<string, any> {
  return parseConfigFormData(configDef, formData);
}

/**
 * Load plugin configuration from the options table.
 * Key format: "plugin:<pluginId>", value is a JSON string.
 * Falls back to defaults from manifest if not yet saved.
 *
 * @param options - Site options object from loadOptions() (contains all option rows)
 * @param pluginId - Plugin identifier
 * @returns Merged config object (saved values + defaults for missing keys)
 */
export function loadPluginConfig(
  options: Record<string, any>,
  pluginId: string,
): Record<string, any> {
  return loadConfig(options, `plugin:${pluginId}`, pluginRegistry.get(pluginId)?.manifest.config);
}

// ==================== Shared Plugin Utilities ====================

/**
 * Parse a plugin config value from the options store.
 * Handles both raw objects and JSON-encoded strings.
 */
export function parsePluginOption(value: unknown, label?: string): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    if (label) console.error(`[${label}] Failed to parse plugin config`);
    return {};
  }
}

/**
 * Escape a string for use in HTML attribute values.
 */
export { escapeAttr } from '@/lib/escape';

export { getClientIp } from '@/lib/client-ip';
