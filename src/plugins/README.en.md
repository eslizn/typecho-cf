# Plugin Development Guide

> This document is the complete reference for Typecho-CF plugin development. `typecho-plugin-antispam/` serves as the working example.

[中文](README.md)

---

## Directory Structure

```
typecho-plugin-example/
├── package.json     # npm package manifest (keywords must include typecho + plugin, typecho.plugin has metadata)
└── index.ts         # Entry point (ESM, export default init function)
```

> The plugin loader discovers `index.ts` first, then falls back to `index.js` / `index.mjs` / `plugin.ts` / `plugin.js`. Built-in plugins in this repository use TypeScript. For standalone npm publishing, compile TS to JS and point `package.json` `typecho.plugin.entry` at the compiled output.

---

## package.json

Plugin metadata belongs in the `typecho.plugin` field. Do not use the retired root-level `plugin.json`.

```json
{
  "name": "typecho-plugin-example",
  "version": "1.0.0",
  "description": "Plugin description",
  "keywords": ["typecho", "plugin"],
  "author": "Your Name",
  "license": "MIT",
  "type": "module",
  "main": "index.ts",
  "typecho": {
    "plugin": {
      "id": "typecho-plugin-example",
      "name": "Example Plugin",
      "description": "What the plugin does",
      "author": "Your Name",
      "authorUrl": "https://example.com",
      "version": "1.0.0",
      "homepage": "https://github.com/...",
      "license": "MIT",
      "tags": ["example"],
      "config": {
        "fieldName": {
          "type": "text",
          "label": "Field Label",
          "default": "",
          "description": "Help text (HTML supported)"
        }
      }
    }
  }
}
```

**Key constraints**:
- `keywords` must include both `"typecho"` and `"plugin"` — otherwise the build-time scanner won't discover it
- `"type": "module"` — use ESM (`export default`, not `module.exports`)
- `main` points to the entry file; local plugins in this repository use `index.ts`
- `typecho.plugin` contains the plugin metadata (id, name, config, etc.)

### Config Field Types

| Type | Description | Extra fields |
|------|-------------|-------------|
| `text` | Single-line text input | — |
| `textarea` | Multi-line text | — |
| `password` | Password input (masked) | — |
| `hidden` | Hidden field | — |
| `select` | Dropdown | `options: { value: label }` |
| `radio` | Radio buttons | `options: { value: label }` |
| `checkbox` | Checkboxes (multi-select) | `options: { value: label }`, default is array |
| `repeatable` | Repeatable config group | `itemFields: { fieldName: fieldDef }`, default is an object array |

When `config` is declared, the admin plugin list automatically shows a "Settings" link that navigates to `/admin/plugin-config?id=<pluginId>`.

Use `repeatable` for multiple same-shaped config items, such as storage mounts:

```json
{
  "type": "repeatable",
  "label": "Storage mounts",
  "default": [{ "mount": "media", "provider": "r2" }],
  "itemFields": {
    "mount": { "type": "text", "label": "Mount path", "default": "media" },
    "provider": {
      "type": "select",
      "label": "Provider",
      "default": "r2",
      "options": { "r2": "Cloudflare R2", "s3": "Amazon S3 compatible" }
    }
  }
}
```

Fields may use `showWhen` for conditional display. Select fields may use `optionsSource: "r2Bindings"` to populate options from R2 bucket bindings in the current Worker environment.

`password` and `hidden` values are returned to admin APIs and pages only as placeholders; plaintext is never sent to the browser. Secrets inside `repeatable` rows are masked recursively and restored to the correct row after removal or reordering through internal row metadata that is never stored. `plugin:config:beforeSave` receives restored values restricted to manifest-declared fields.

---

## index.ts Entry Point

```ts
/**
 * Plugin entry function. Build registers only a lazy loader; init runs on first activation.
 * Register all hooks via addHook. Do NOT perform I/O here.
 */
import type { PluginInitContext } from 'typecho/plugin-sdk';

export default function init({ addHook, pluginId }: PluginInitContext): void {
  // filter hook: transform data and return it
  addHook('content:rendered', pluginId, (html: string) => {
    return html + '<!-- powered by example plugin -->';
  });

  // call hook: side effects, no return value needed
  addHook('comment:afterCreate', pluginId, (comment: { coid?: number }) => {
    console.log('New comment:', comment.coid);
  });
}
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `addHook(point, pluginId, handler, priority?)` | function | Register a hook handler. `priority` defaults to 10; lower = earlier execution |
| `pluginId` | string | This plugin's ID (from `package.json` `typecho.plugin.id` field) |

---

## Scheduled and Asynchronous Tasks

Tasks are integrated through the methods on `PluginInitContext`. A task must be registered during the plugin's `init()` before it can be dispatched by the scheduler or enqueued by a request. Every task handler has the `(context, payload)` signature. Registration does not run at build time; it takes effect when the plugin is initialized as an active plugin.

### `registerScheduledTask()`: Register a scheduled task

Use `registerScheduledTask(definition)` only for tasks driven by the global Cron scheduler:

```typescript
registerScheduledTask({
  id: 'daily-sync',
  schedule: '0 2 * * *',
  concurrency: 1,
  timeoutSeconds: 60,
  handler: async (context, payload) => {
    // The scheduled payload contains only core-generated localSlot and scheduledAt;
    // the same time data is also available on context.
    context.log('daily sync started', {
      task: context.taskId,
      hasPayload: payload !== undefined,
    });
    if (!context.localSlot) {
      return { status: 'discard', reason: 'missing local slot' };
    }
    // ...perform short, re-entrant synchronization work
    return { status: 'success' };
  },
});
```

- `id` must be unique within the plugin; the task identity is `{pluginId}:{taskId}`.
- `schedule` must use exactly five Cron fields: `minute hour day-of-month month day-of-week`; seconds are not supported.
- `concurrency` and `timeoutSeconds` are optional, with defaults of `1` and `30`; `concurrency` limits this task identity.
- The scheduled handler's `payload` type is fixed as `ScheduledTaskPayload` and contains only the core-generated `localSlot` and `scheduledAt`; read business parameters from the plugin's own configuration or data source.
- `getTaskKey(context)` is optional and can split scheduled work by business dimension. The default `taskKey` is `{pluginId}:{taskId}:{localSlot}:{scheduledAt}`, where `scheduledAt` is the real UTC instant; the default idempotency key is `schedule:{taskKey}`. Repeated delivery of the same Cron instant still receives the same default key.
- The Cloudflare Cron Trigger runs once per minute (`* * * * *`) and invokes the Worker's `scheduled` entry; it is not an HTTP request. The scheduler converts the current UTC instant with the site's `options.timezone` IANA timezone to produce `localSlot`, applying the timezone's DST rules rather than a fixed offset. During a fall-back transition, the two real instants are enqueued separately even when their local-minute slots match; the core does not merge slots across isolates, so plugins should use a business idempotency mechanism when they want to merge them.

### `registerAsyncTask()`: Register a request-originated async task

Use `registerAsyncTask(definition)` for an asynchronous task explicitly enqueued by a request; it has no Cron expression:

```typescript
registerAsyncTask<{ postId: number; revision: number }>({
  id: 'reindex-post',
  concurrency: 4,
  timeoutSeconds: 30,
  handler: async (context, payload) => {
    context.log('reindexing post', { postId: payload.postId });
    if (context.signal.aborted) {
      return { status: 'retry', reason: 'execution was cancelled' };
    }
    // ...work with payload.postId / payload.revision
    return { status: 'success' };
  },
});
```

It must be paired with `enqueueAsyncTask()`. If the task is not registered, the plugin is disabled, or the task kind does not match, the message is not executed.

### `enqueueAsyncTask()`: Enqueue from a request

`enqueueAsyncTask(taskId, payload, options)` is the request-originated enqueue method on `PluginInitContext`. It can enqueue only a task already registered with `registerAsyncTask()`. The method always marks the message source as `request`; a plugin cannot forge a `scheduled` source or bypass activation through its arguments.

`options.idempotencyKey` is required and must be a stable business-unique key. `taskKey`, `jobId`, and `delaySeconds` are optional. The method returns `{ jobId, taskKey, idempotencyKey }`. A normal request must provide an explicit stable idempotency key; do not replace it with a newly generated random value on every request:

```typescript
addHook('post:afterSave', pluginId, async (post: { id?: number; modified?: number }) => {
  if (post.id == null || post.modified == null) return;

  await enqueueAsyncTask(
    'reindex-post',
    { postId: post.id, revision: post.modified },
    {
      idempotencyKey: 'post-reindex:' + post.id + ':' + post.modified,
    },
  );
});
```

Request-originated async tasks and scheduled tasks are separate interfaces. Do not map arbitrary request parameters directly to task names, and do not use `enqueueAsyncTask()` as a replacement for scheduled registration. The core validates the versioned `TaskEnvelope` both when sending and when consuming.

### Results, retries, and concurrency

A handler must return `TaskResult`:

| Return value | Behavior |
|--------------|----------|
| `{ status: 'success' }` | Acknowledge the Queue message; do not retry |
| `{ status: 'retry', reason?, delaySeconds? }` | Request a Queue retry, optionally with a delay |
| `{ status: 'discard', reason? }` | Intentionally acknowledge and drop the message; do not retry |

If a handler throws, returns an invalid result, or exceeds `timeoutSeconds`, the core treats the execution as failed and requests a Queue retry. A timeout also aborts `context.signal`; the core keeps that task identity's concurrency slot occupied for at most one second after the underlying handler promise times out, giving the plugin a short chance to stop while releasing global dispatcher capacity so other task identities can continue. If the handler is still running after that grace period, the core releases the task slot so a non-cooperative handler cannot block the whole Queue batch indefinitely; its late work may overlap the retry, so plugins must promptly honor `context.signal` and make tasks idempotent. Queue provides at-least-once delivery, batching, and retries; this deployment does not configure a DLQ, so a message that still fails after `max_retries` is discarded by Cloudflare. Do not assume exactly-once execution, and do not treat Queue as a task-history or idempotency-record store. The scheduler limits each `sendBatch` call to 100 messages and 256,000 bytes total, splitting at whichever limit is reached first. `delaySeconds` must be an integer from 0 through 86,400 seconds.

`concurrency` limits only the same `{pluginId}:{taskId}` identity within the current dispatcher. Different tasks may run in parallel, while the core applies a global limit of at most `16` in-flight tasks for the dispatcher. The Queue consumer's outer `max_concurrency = 1` does not make all tasks serial. This is not a distributed lock across PoPs or isolates; plugins that need global mutual exclusion must provide their own business mechanism.

Malformed messages, unknown tasks, and messages for disabled plugins are acknowledged and dropped rather than retried forever. A task whose plugin initialization failed follows the Queue retry policy.

### Payload, idempotency, and security

- `payload` must be JSON-serializable JSON data, and its serialized UTF-8 size must not exceed `32 KiB`; do not pass functions, circular references, non-finite numbers, or other runtime objects.
- Queue delivery is at least once, so a message may run again after an exception, timeout, or network retry. `idempotencyKey` is a stable business identifier, not automatic deduplication; the core does not create a D1 deduplication table. Plugins must use a business-unique key, a provider idempotency key, or naturally idempotent writes to make repeats safe.
- Never put passwords, access tokens, cookies, CSRF tokens, complete request headers, or other secrets in a payload, and never write them to `context.log()` or other logs. Log only necessary task metadata and redact business data.
- A single Queue message is for short, re-entrant work. Long-running, multi-step, waiting, or stateful-recovery flows should not be forced into Queue; Workflow is reserved for a future solution for those long flows, waits, and persisted state, and is not the default path in the first phase.

## Translations

A plugin can register static catalogs from its `init()` function. Keep the catalogs in the plugin's own `locales/` directory and register them synchronously during initialization:

```ts
import type { PluginInitContext } from 'typecho/plugin-sdk';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

export default function init({ addHook, pluginId, registerTranslations }: PluginInitContext): void {
  registerTranslations('en', en, 'English');
  registerTranslations('zh-CN', zhCN, '中文（简体）');

  addHook('frontend:footer', pluginId, (html, extra) => {
    const label = extra?.i18n?.t('plugin.typecho-plugin-example.label', {}, 'Example');
    return html + `<span>${label}</span>`; // escape before inserting into HTML
  });
}
```

`registerTranslations(locale, messages, displayName?)` supports new locales, additional keys, full overrides, and partial overrides of core or other plugin keys. Merge order is core catalogs → plugin order in `options.activatedPlugins` → registration-call order within each plugin; a later registration wins for duplicate keys, with no separate translation `priority`. Only active plugins contribute to the global catalog. Missing keys continue through the current locale, language-family, and `en` fallback chain. Prefer the `plugin.<pluginId>.*` namespace; document intentional overrides of system keys.

`extra.i18n` is the request-local translator for the current request. Use `i18n.t(key, variables, fallbackText)` or `i18n.tPlural(...)`. Catalog values are plain text with simple `{name}` / `{count}` interpolation; ICU is not parsed and translations do not carry HTML semantics.

For inline scripts rendered by the server, do not read `navigator.language` or scan the DOM. Inject only a finite message bag resolved for the current request and serialize it with the SDK's `safeJsonForScript()`; the script should use those values directly for prompts.

---

## Reading Plugin Config

Inside a filter/call handler, read config from the `extra.options` object passed in:

```ts
import { loadPluginConfig } from 'typecho/plugin-sdk';

addHook('comment:beforeSave', pluginId, async (commentData: { _rejected?: string }, extra?: { options?: Record<string, unknown> }) => {
  if (!extra?.options) return commentData;

  // Read this plugin's config (auto-merged with typecho.plugin.config defaults)
  const config = loadPluginConfig(extra.options, pluginId);

  if (!config.apiKey) return commentData;  // Not configured, skip

  // ... business logic
  return commentData;
});
```

> Plugins in the main project can also parse `extra.options[\`plugin:${pluginId}\`]` (a JSON string) directly. Standalone npm plugins should prefer the SDK-provided `loadPluginConfig`.

Config storage: `typecho_options` table, `name = "plugin:<pluginId>"`, value is a JSON string.

---

## Currently Wired Hook Reference

The following is the complete list of canonical hook names with explicit runtime call sites. New plugins should use these names; unlisted `HookPoints` constants have no call guarantee.

Adding a hook requires updating `HookPoints`, the call site, and this guide together.

### call type (side effects, no return value)

| Hook | Trigger Location | Arguments |
|------|-----------------|-----------|
| `request:begin` / `request:end` | Request context ready / response finalized | `(context)` / `({ request, response })` |
| `admin:begin` / `admin:end` | Admin layout starts / admin layout data is ready | `(context)` |
| `archive:init` | Archive or single-content initialization | `(context)` |
| `archive:index` / `archive:single` / `archive:category` / `archive:tag` / `archive:author` / `archive:search` | Before the corresponding archive or single-content preparation | `(context)` |
| `archive:beforeRender` / `archive:afterRender` | Frontend document response before / after rendering | `(context)` / `({ ..., response })` |
| `post:afterPublish` / `post:afterSave` | After post publish / save | `(post)` |
| `post:beforeDelete` / `post:afterDelete` | Before / after post deletion | `(post)` |
| `page:afterPublish` / `page:afterSave` | After page publish / save | `(page)` |
| `page:beforeDelete` / `page:afterDelete` | Before / after page deletion | `(page)` |
| `comment:afterCreate` | After comment save | `(comment)` |
| `feedback:trackback:after` | After Trackback persistence | `(comment, extra)` |
| `feedback:pingback:after` | After Pingback persistence | `(comment, extra)` |
| `comment:reply` | After a reply comment is saved | `(comment, { parent })` |
| `comment:action` | After a moderation action | `(comment, extra)` |
| `user:login:success` / `user:login:failure` | Login success / rejection | `(summary)` / `({ request, reason })` |
| `user:logout` | After logout cookies are cleared | `({ request })` |
| `user:register:after` | After user persistence | `(userSummary)` |
| `upload:after` | After file upload persistence | `(upload, extra)` |
| `upload:delete` | After attachment deletion | `(attachment, extra)` |

### filter type (must return a value)

| Hook | Trigger Location | Arguments | Description |
|------|-----------------|-----------|-------------|
| `request:route` | Middleware route dispatch | `(result, extra)` | Handles plugin routes; admin/API paths also require `registerPluginAdminPath` |
| `admin:head` / `admin:footer` | Admin head/footer | `(html, extra)` | Safe display-oriented HTML injection |
| `admin:nav` | Admin navigation generation | `(groups, extra)` | Adjusts menu groups/items; hrefs are checked to stay on same-origin admin paths or anchors |
| `admin:login:head` / `admin:login:form` | Login head/form | `(html, extra)` | Login-page HTML injection |
| `admin:page` | `/admin/plugin/[slug]` | `(html, extra)` | Renders a plugin-owned admin page |
| `admin:writePost:option` / `admin:writePost:advanceOption` / `admin:writePost:bottom` | Post editor option/advanced/footer areas | `(html, extra)` | Injects editor UI |
| `admin:writePage:option` / `admin:writePage:advanceOption` / `admin:writePage:bottom` | Page editor option/advanced/footer areas | `(html, extra)` | Injects editor UI |
| `admin:managePosts:titleActions` | Post-list title actions | `(html, extra)` | Adds per-post admin actions |
| `admin:profile:bottom` | Profile-page footer | `(html, extra)` | Injects profile UI |
| `plugin:config:beforeSave` | Before plugin config save | `(result, extra)` | Validate or normalize plugin config; return `{ success, settings?, error? }` |
| `archive:query` | Before archive query construction | `(state, context)` | Adjusts page/page size or supplies safe extra SQL; visibility and archive scope remain protected |
| `frontend:head` / `frontend:footer` | Frontend head/footer | `(html, extra)` | Theme-independent frontend HTML/JS injection |
| `content:data` | After content data is loaded | `(content, extra)` | Changes display data; query, permission, identity, and permalink fields are protected |
| `content:title` | Before displaying a content title | `(title, extra)` | Changes the display title |
| `content:excerpt` | Before displaying a content excerpt | `(excerpt, extra)` | Changes the display excerpt |
| `content:markdown` | Before Markdown rendering | `(markdown, extra?)` | Filters raw Markdown text |
| `content:rendered` | After Markdown sanitization | `(html, extra?)` | Filters final post HTML |
| `comment:data` | After comment display data is loaded | `(comment, extra)` | Changes display fields; identity, moderation, and tree fields are protected |
| `comment:markdown` | Before comment Markdown rendering | `(markdown, extra?)` | Filters raw comment Markdown |
| `comment:rendered` | After comment HTML sanitization | `(html, extra?)` | Filters final comment HTML |
| `post:write` | Before post save | `(data, extra)` | Filters declared post fields; the result is revalidated |
| `page:write` | Before page save | `(data, extra)` | Filters declared page fields; authorId, type, cid, and relations are protected |
| `comment:beforeSave` | Before comment save | `(commentData, extra)` | Validates/modifies author, mail, url, text, and status; `_rejected` rejects |
| `feedback:trackback:before` | Before Trackback persistence | `(data, extra)` | Validates or normalizes incoming feedback data |
| `feedback:pingback:before` | Before Pingback persistence | `(data, extra)` | Validates or normalizes incoming feedback data |
| `user:login:before` | Before password verification | `(context, extra)` | Set `_rejected` to reject login; the password is never passed to the hook |
| `user:register:before` | Before user persistence | `(data, extra)` | Validates/normalizes public registration fields; password, permissions, and auth code remain system-owned |
| `upload:before` | Before upload persistence | `(result, extra)` | Return a rejection reason to stop upload |
| `feed:item` | After each RSS/Atom/RSS1 item is built | `(item, extra?)` | Filters one feed item |
| `feed:render` | After the complete XML document is built | `(xml, extra)` | Filters the complete RSS/Atom/RSS1 document; content type and cache headers remain system-owned |
| `sidebar:data` | After sidebar data is built | `(sidebarData, extra)` | Filters sidebar data |
| `csp:directives` | Security-header generation | `(directives, extra)` | Append required CSP sources without clearing defaults |
| `plugin:<id>:action:authorize` | Plugin-action authorization | `(role, extra)` | Declares the minimum role for an action; default is administrator |
| `plugin:<id>:action` | `/api/admin/plugin-action` | `(result, extra)` | Runs a plugin admin action and returns a handled result |

### Compatibility aliases

Legacy names are normalized to their canonical names so existing plugins continue to work, but new code should not register them. Important mappings include: `system:begin → request:begin`, `system:end → request:end`, `route:request → request:route`, `archive:header/footer → frontend:head/footer`, `content:filter → content:data`, `content:content → content:rendered`, `feedback:comment → comment:beforeSave`, `upload:beforeUpload → upload:before`, `upload:upload → upload:after`, `feed:generate → feed:render`, and `widget:sidebar → sidebar:data`. See `DeprecatedHookPointAliases` for the complete mapping.

`applyFilter` propagates plugin exceptions by default. Business flows such as content saving, comments, login, and plugin configuration will stop and surface the error. Presentation-only injection points can be wrapped by `applyFilterSafely`; when one plugin fails, that plugin output is skipped and rendering continues.

---

## Rejecting Comments

In a `comment:beforeSave` filter, set `commentData._rejected` to reject the comment:

```ts
addHook('comment:beforeSave', pluginId, async (commentData, extra) => {
  if (spamDetected) {
    commentData._rejected = 'Spam detected';  // Non-empty string = rejected with 403
  }
  return commentData;
});
```

---

## Providing Client-Side Code to Themes

Plugins can automatically inject HTML/JS into frontend pages via `frontend:head` and `frontend:footer` filters — no theme modification required:

```ts
// index.ts
import type { PluginInitContext } from 'typecho/plugin-sdk';
import { loadPluginConfig } from 'typecho/plugin-sdk';

export default function init({ addHook, pluginId }: PluginInitContext): void {
  // Inject <head> content (e.g., SDK scripts)
  addHook('frontend:head', pluginId, (headHtml: string, extra?: { options?: Record<string, unknown> }) => {
    const config = loadPluginConfig(extra?.options, pluginId);
    if (!config.sitekey) return headHtml;
    return headHtml + '<script src="..."></script>';
  });

  // Inject content before </body> (e.g., interaction scripts)
  addHook('frontend:footer', pluginId, (bodyHtml: string, extra?: { options?: Record<string, unknown> }) => {
    const config = loadPluginConfig(extra?.options, pluginId);
    if (!config.sitekey) return bodyHtml;
    return bodyHtml + '<script>/* ... */</script>';
  });
}
```

The `Base.astro` layout automatically calls `getClientSnippets(options)` to collect injections from all activated plugins — themes need no additional code.

---

## Plugin SDK

Plugins in this repository import the public API from `typecho/plugin-sdk`, a barrel export that re-exports commonly used types and utilities.

### Import style

```ts
// Inside the monorepo (resolved via tsconfig paths + Vite alias)
import { parsePluginOption, escapeAttr, fetchWithTimeout } from 'typecho/plugin-sdk';
import type { PluginInitContext } from 'typecho/plugin-sdk';

// Plugins that need direct database schema access
import type { Database } from 'typecho/db';
import { schema } from 'typecho/db';
```

### Standalone npm packages

When publishing a plugin as a standalone npm package, declare `typecho` as a `peerDependency` in `package.json`:

```json
{
  "name": "typecho-plugin-example",
  "peerDependencies": {
    "typecho": ">=0.1.0"
  }
}
```

The host project supplies the `typecho` package at install time, and `typecho/plugin-sdk` resolves via the `package.json` `exports` field.

### SDK exports overview

| Category | Exports |
|----------|---------|
| Types | `PluginInitContext`, `PluginRouteResult`, `PluginManifest`, `PluginConfigField`, `AttachmentMeta`, `Database`, `IanaTimezone`, `TimezoneSetting` |
| Task types | `AsyncTaskDefinition`, `RegisteredAsyncTask`, `RegisteredScheduledTask`, `ScheduledTaskDefinition`, `ScheduledTaskKeyContext`, `ScheduledTaskPayload`, `TaskEnvelope`, `TaskExecutionContext`, `TaskHandler`, `TaskKind`, `TaskLocalSlot`, `TaskResult`, `TaskSource`, `EnqueueAsyncTaskOptions` |
| Plugin system | `HookPoints`, `parsePluginOption`, `parsePluginConfigFormData`, `loadPluginConfig`, `escapeAttr`, `registerPluginAdminPath`, `getClientIp` |
| Auth | `hasPermission`, `verifyPassword` |
| Content | `buildPermalink`, `formatDate`, `buildAuthorLink`, `buildCategoryLink` |
| Markdown/HTML | `escapeHtml`, `renderMarkdown`, `renderMarkdownFiltered`, `renderContentExcerpt`, `generateExcerpt`, `autop`, `stripTypechoMarkers`, `stripHtmlTags` |
| Network | `fetchWithTimeout` |
| Attachments | `parseAttachmentMeta` |
| URL | `normalizeHttpUrl` |
| Options | `getOption`, `setOption` |

`formatDate(timestamp, format, timezone, locale)` uses an IANA identifier
(for example `Asia/Shanghai` or `America/New_York`) so regional DST rules are applied.

---

## Installing into the Project

### Local development (workspace package)

1. Place the plugin directory under `src/plugins/`
2. Add `"<packageName>": "file:src/plugins/<packageName>"` to the root `package.json` `dependencies`
3. Run `pnpm install`
4. Rebuild with `pnpm run build`

### Install from npm

```bash
pnpm add typecho-plugin-example
pnpm run build
```

> Standalone plugins must declare `typecho` as a `peerDependency`. The SDK is provided by the host project when the plugin is installed.

---

## Testing

Every plugin must include an `index.test.ts` alongside `index.ts` using vitest.

### Test Infrastructure

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import init from './index';

// Collect registered hooks by mocking the PluginInitContext
function collectHooks() {
  const hooks = new Map<string, Function>();
  init({
    pluginId: 'typecho-plugin-<name>',
    HookPoints: {} as any,
    addHook: (point: string, _pluginId: string, handler: Function) => {
      hooks.set(point, handler);
    },
    registerTranslations: () => {},
    registerScheduledTask: () => {},
    registerAsyncTask: () => {},
    enqueueAsyncTask: async () => ({
      jobId: 'test-job',
      taskKey: 'test-task',
      idempotencyKey: 'test-idempotency',
    }),
  });
  return hooks;
}

// Build the options bag shaped like what the plugin reads at runtime
function options(settings: Record<string, unknown>) {
  return {
    'plugin:typecho-plugin-<name>': JSON.stringify(settings),
    // Include any site-level options the plugin reads (e.g. siteUrl, secret)
  };
}
```

### Required Test Categories

1. **Hook registration** — verify `hooks.keys()` matches the expected set
2. **Guard clauses** — no config → skip, logged-in skip, pageContext skip
3. **Happy path** — each feature works with valid input
4. **Rejection path** — each guard/check rejects appropriately
5. **Mode dispatch** — if the plugin supports multiple modes (e.g. spam/waiting/discard), each mode is covered
6. **Edge cases** — zero values, empty strings, missing tokens, API failures
7. **External API mocking** — use `vi.stubGlobal('fetch', mock)` and call `vi.unstubAllGlobals()` in `afterEach`
8. **Config validation** — `plugin:config:beforeSave` accepts good config, rejects bad, ignores other plugins

### File Naming

- `index.test.ts` — in the same directory as `index.ts`

### Running

```sh
npx vitest run src/plugins/<plugin-name>/index.test.ts
```

### Checklist for New Plugins

- [ ] `index.test.ts` exists
- [ ] All hooks registered are verified
- [ ] Each check branch has at least one test
- [ ] Default mode/spam path is covered
- [ ] Discard/reject path is covered (if applicable)
- [ ] Logged-in user skip is tested
- [ ] Missing config skip is tested
- [ ] API failure (mocked) does not crash the handler
- [ ] `pageContext` guard is tested (for `frontend:head`/`frontend:footer` hooks)

## Reference Example

`typecho-plugin-antispam/` demonstrates:
- `package.json` config declaration (under `typecho.plugin`)
- `comment:beforeSave` filter hook (anti-spam)
- Reading plugin config
- Correct client IP extraction (CF-Connecting-IP priority)
