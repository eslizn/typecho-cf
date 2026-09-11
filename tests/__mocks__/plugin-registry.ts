/**
 * Vitest stand-in for `virtual:typecho-plugin-registry`.
 *
 * In production the plugin-loader Astro integration generates this module:
 * registerPluginLoaders() with one lazy dynamic import per plugin. The
 * middleware statically imports it so plugin loaders are registered before
 * the first request of a cold isolate runs setActivatedPlugins. Production
 * gets the equivalent generated module from plugin-loader.ts.
 *
 * Vitest does not run Astro integrations, so this file mirrors the generated
 * registry for the workspace plugins. Keep it in sync with src/plugins/*.
 * Loaders stay lazy: a plugin module is only evaluated once activated, which
 * keeps unrelated tests free of plugin side effects.
 */
import { registerPluginLoaders, addHook, HookPoints } from '@/lib/plugin';

registerPluginLoaders({
  'typecho-plugin-ai': () => import('@/plugins/typecho-plugin-ai/index').then((module) => module.default),
  'typecho-plugin-antispam': () => import('@/plugins/typecho-plugin-antispam/index').then((module) => module.default),
  'typecho-plugin-scribe': () => import('@/plugins/typecho-plugin-scribe/index').then((module) => module.default),
  'typecho-plugin-turnstile': () => import('@/plugins/typecho-plugin-turnstile/index').then((module) => module.default),
  'typecho-plugin-webdav': () => import('@/plugins/typecho-plugin-webdav/index').then((module) => module.default),
  'typecho-plugin-wechat-publisher': () => import('@/plugins/typecho-plugin-wechat-publisher/index').then((module) => module.default),
}, { addHook, HookPoints });

export {};
