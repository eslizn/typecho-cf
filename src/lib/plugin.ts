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
 *     plugin.json        - Plugin metadata (required)
 *     index.ts/js        - Plugin entry point (required)
 *     package.json       - Must have keywords: ["typecho", "plugin"]
 */

// ==================== Types ====================

/**
 * Plugin configuration field definition.
 * Mirrors PHP Typecho's Form Element types (Text, Textarea, Select, Radio, Checkbox, Password, Hidden).
 */
export interface PluginConfigField {
  /** Field type */
  type: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'password' | 'hidden';
  /** Display label */
  label: string;
  /** Help text / description shown below the field */
  description?: string;
  /** Default value (string for most types, array for checkbox) */
  default?: string | number | string[];
  /** Options for select / radio / checkbox: { value: label } */
  options?: Record<string, string>;
}

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
  /** Plugin manifest from plugin.json */
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

interface HookRegistration {
  pluginId: string;
  handler: CallHandler | FilterHandler;
  priority: number;
}

// ==================== Hook Definitions ====================

/**
 * Complete hook point definitions, mapped from Typecho's original plugin system.
 * 
 * Naming convention: component:hookName
 * - Components map to Typecho's Widget classes
 * - Hook names match original Typecho names where applicable
 */
export const HookPoints = {
  // --- Core System ---
  'system:begin': 'system:begin',                    // System startup
  'system:end': 'system:end',                        // System shutdown

  // --- Admin UI ---
  'admin:header': 'admin:header',                    // Admin head section (inject CSS/meta)
  'admin:footer': 'admin:footer',                    // Admin footer (inject JS)
  'admin:navBar': 'admin:navBar',                    // Admin navigation extension
  'admin:begin': 'admin:begin',                      // Admin page begin
  'admin:end': 'admin:end',                          // Admin page end
  'admin:loginHead': 'admin:loginHead',              // Filter: HTML injected into login page <head>
  'admin:loginForm': 'admin:loginForm',              // Filter: HTML injected into login page form

  // --- Content Editing (Admin) ---
  'admin:writePost:option': 'admin:writePost:option',          // Post editor sidebar options
  'admin:writePost:advanceOption': 'admin:writePost:advanceOption', // Post editor advanced options
  'admin:writePost:bottom': 'admin:writePost:bottom',          // Post editor bottom area
  'admin:writePage:option': 'admin:writePage:option',          // Page editor sidebar options
  'admin:writePage:advanceOption': 'admin:writePage:advanceOption', // Page editor advanced options
  'admin:writePage:bottom': 'admin:writePage:bottom',          // Page editor bottom area
  'admin:profile:bottom': 'admin:profile:bottom',              // Profile page bottom area

  // --- Content Display (Frontend) ---
  'archive:select': 'archive:select',               // Filter: DB query for content listing
  'archive:handleInit': 'archive:handleInit',        // After content init
  'archive:header': 'archive:header',                // Frontend head section
  'archive:footer': 'archive:footer',                // Frontend footer section
  'archive:beforeRender': 'archive:beforeRender',    // Before template render
  'archive:afterRender': 'archive:afterRender',      // After template render
  'archive:indexHandle': 'archive:indexHandle',       // Index page processing
  'archive:singleHandle': 'archive:singleHandle',    // Single post/page processing
  'archive:categoryHandle': 'archive:categoryHandle', // Category archive processing
  'archive:tagHandle': 'archive:tagHandle',          // Tag archive processing
  'archive:searchHandle': 'archive:searchHandle',    // Search results processing

  // --- Content Filtering ---
  'content:filter': 'content:filter',                // Filter: raw content row data
  'content:title': 'content:title',                  // Filter: content title
  'content:excerpt': 'content:excerpt',              // Filter: content excerpt/summary
  'content:markdown': 'content:markdown',            // Filter: Markdown processing
  'content:content': 'content:content',              // Filter: rendered HTML content

  // --- Comment Filtering ---
  'comment:filter': 'comment:filter',                // Filter: raw comment row data
  'comment:content': 'comment:content',              // Filter: rendered comment content
  'comment:markdown': 'comment:markdown',            // Filter: comment Markdown

  // --- Content Management ---
  'post:write': 'post:write',                        // Filter: post data before save
  'post:finishPublish': 'post:finishPublish',        // After post published
  'post:finishSave': 'post:finishSave',              // After post saved (draft or publish)
  'post:delete': 'post:delete',                      // Before post delete
  'post:finishDelete': 'post:finishDelete',          // After post deleted
  'page:write': 'page:write',                        // Filter: page data before save
  'page:finishPublish': 'page:finishPublish',        // After page published
  'page:finishSave': 'page:finishSave',              // After page saved
  'page:delete': 'page:delete',                      // Before page delete
  'page:finishDelete': 'page:finishDelete',          // After page deleted

  // --- Comment Management ---
  'feedback:comment': 'feedback:comment',            // Filter: comment data before save
  'feedback:finishComment': 'feedback:finishComment', // After comment saved
  'feedback:reply': 'feedback:reply',                // On comment reply

  // --- User System ---
  'user:login': 'user:login',                        // Login attempt
  'user:loginSucceed': 'user:loginSucceed',          // Login success
  'user:loginFail': 'user:loginFail',                // Login failure
  'user:logout': 'user:logout',                      // User logout
  'user:register': 'user:register',                  // Filter: registration data
  'user:finishRegister': 'user:finishRegister',      // After registration

  // --- File Upload ---
  'upload:beforeUpload': 'upload:beforeUpload',      // Before file upload
  'upload:upload': 'upload:upload',                  // After file uploaded
  'upload:delete': 'upload:delete',                  // File deletion

  // --- Feed ---
  'feed:item': 'feed:item',                          // Filter: feed item data
  'feed:generate': 'feed:generate',                  // Filter: complete feed XML

  // --- Sidebar / Widgets ---
  'widget:sidebar': 'widget:sidebar',                // Filter: sidebar data
} as const;

export type HookPoint = typeof HookPoints[keyof typeof HookPoints];

// ==================== Plugin Registry ====================

/**
 * Module-level state — safe in Cloudflare Workers because:
 * 1. Workers are single-threaded: only one request executes at a time per isolate
 * 2. pluginRegistry and hookRegistry are populated once at module init (build time)
 *    and are effectively read-only at runtime
 * 3. activatedPlugins is re-initialized at the start of every request via
 *    setActivatedPlugins() called from context.ts
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

/**
 * Set of activated plugin IDs
 * Loaded from DB options at runtime
 */
let activatedPlugins = new Set<string>();

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
    isActive: activatedPlugins.has(id),
  });
}

/**
 * Set the list of activated plugin IDs (loaded from DB)
 */
export function setActivatedPlugins(ids: string[]): void {
  activatedPlugins = new Set(ids);
  // Update isActive flag on all registered plugins
  for (const [id, info] of pluginRegistry) {
    info.isActive = activatedPlugins.has(id);
  }
}

/**
 * Check if a plugin is activated
 */
export function isPluginActive(pluginId: string): boolean {
  return activatedPlugins.has(pluginId);
}

/**
 * Get all available plugins
 */
export function getAvailablePlugins(): PluginInfo[] {
  const plugins: PluginInfo[] = [];
  for (const [, info] of pluginRegistry) {
    plugins.push({
      ...info,
      isActive: activatedPlugins.has(info.id),
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
 */
export function addHook(
  hookPoint: string,
  pluginId: string,
  handler: CallHandler | FilterHandler,
  priority = 10,
): void {
  if (!hookRegistry.has(hookPoint)) {
    hookRegistry.set(hookPoint, []);
  }
  const handlers = hookRegistry.get(hookPoint)!;
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
export async function doHook(hookPoint: string, ...args: any[]): Promise<void> {
  const handlers = hookRegistry.get(hookPoint);
  if (!handlers || handlers.length === 0) return;

  for (const reg of handlers) {
    if (!activatedPlugins.has(reg.pluginId)) continue;
    try {
      await (reg.handler as CallHandler)(...args);
    } catch (err) {
      console.error(`[plugin] Error in hook ${hookPoint} from plugin ${reg.pluginId}:`, err);
    }
  }
}

/**
 * Execute a "filter" hook - passes a value through all handlers.
 * Each handler receives the current value and must return the (possibly modified) value.
 * Only executes handlers from activated plugins.
 * 
 * @param hookPoint - The hook point name
 * @param value - The initial value to filter
 * @param args - Additional arguments to pass to handlers
 * @returns The filtered value
 */
export async function applyFilter(hookPoint: string, value: any, ...args: any[]): Promise<any> {
  const handlers = hookRegistry.get(hookPoint);
  if (!handlers || handlers.length === 0) return value;

  let result = value;
  for (const reg of handlers) {
    if (!activatedPlugins.has(reg.pluginId)) continue;
    try {
      result = await (reg.handler as FilterHandler)(result, ...args);
    } catch (err) {
      console.error(`[plugin] Error in filter ${hookPoint} from plugin ${reg.pluginId}:`, err);
    }
  }
  return result;
}

/**
 * Check if a hook point has any registered handlers
 */
export function hasHook(hookPoint: string): boolean {
  const handlers = hookRegistry.get(hookPoint);
  if (!handlers) return false;
  return handlers.some(h => activatedPlugins.has(h.pluginId));
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
export function serializeActivatedPlugins(): string {
  return JSON.stringify(Array.from(activatedPlugins));
}

/**
 * Parse activated plugins list from DB string
 */
export function parseActivatedPlugins(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr) ? arr.filter(id => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

// ==================== Client Snippets ====================

/**
 * Collect client-side HTML snippets from all activated plugins.
 *
 * Plugins register their frontend output by hooking into:
 *   - archive:header (filter): receives current headHtml, returns headHtml with appended content
 *   - archive:footer (filter): receives current bodyHtml, returns bodyHtml with appended content
 *
 * This function applies both filters and returns the aggregated result.
 * Themes should call this once and inject the HTML into <head> and before </body>.
 *
 * @param options - Site options object from loadOptions()
 * @returns {{ headHtml: string, bodyHtml: string }}
 */
export async function getClientSnippets(
  options: Record<string, any>,
): Promise<{ headHtml: string; bodyHtml: string }> {
  let headHtml = await applyFilter('archive:header', '', { options });
  let bodyHtml = await applyFilter('archive:footer', '', { options });
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
  const info = pluginRegistry.get(pluginId);
  if (!info?.manifest.config) return {};

  const defaults: Record<string, any> = {};
  for (const [key, field] of Object.entries(info.manifest.config)) {
    if (field.default !== undefined) {
      defaults[key] = field.default;
    } else if (field.type === 'checkbox') {
      defaults[key] = [];
    } else {
      defaults[key] = '';
    }
  }
  return defaults;
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
  const defaults = getPluginConfigDefaults(pluginId);
  const raw = options?.[`plugin:${pluginId}`];

  if (!raw) return { ...defaults };

  try {
    const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { ...defaults, ...saved };
  } catch {
    return { ...defaults };
  }
}
