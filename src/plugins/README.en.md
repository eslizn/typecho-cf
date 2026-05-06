# Plugin Development Guide

> This document is the complete reference for Typecho-CF plugin development. `typecho-plugin-captcha/` serves as the working example.

[中文](README.md)

---

## Directory Structure

```
typecho-plugin-example/
├── package.json     # npm package manifest (keywords must include typecho + plugin)
├── plugin.json      # Plugin metadata (with optional config declaration)
└── index.ts         # Entry point (ESM, export default init function)
```

> The plugin loader discovers `index.ts` first, then falls back to `index.js` / `index.mjs` / `plugin.ts` / `plugin.js`. Built-in plugins in this repository use TypeScript. For standalone npm publishing, compile TS to JS and point `plugin.json.entry` at the compiled output.

---

## package.json

```json
{
  "name": "typecho-plugin-example",
  "version": "1.0.0",
  "description": "Plugin description",
  "keywords": ["typecho", "plugin"],
  "author": "Your Name",
  "license": "MIT",
  "type": "module",
  "main": "index.ts"
}
```

**Key constraints**:
- `keywords` must include both `"typecho"` and `"plugin"` — otherwise the build-time scanner won't discover it
- `"type": "module"` — use ESM (`export default`, not `module.exports`)
- `main` points to the entry file; local plugins in this repository use `index.ts`

---

## plugin.json

```json
{
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
```

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

---

## index.ts Entry Point

```ts
/**
 * Plugin entry function, called by the system at build time.
 * Register all hooks via addHook. Do NOT perform I/O here.
 */
import type { PluginInitContext } from '@/lib/plugin';

export default function init({ addHook, pluginId }: PluginInitContext): void {
  // filter hook: transform data and return it
  addHook('content:content', pluginId, (html: string) => {
    return html + '<!-- powered by example plugin -->';
  });

  // call hook: side effects, no return value needed
  addHook('feedback:finishComment', pluginId, (comment: { coid?: number }) => {
    console.log('New comment:', comment.coid);
  });
}
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `addHook(point, pluginId, handler, priority?)` | function | Register a hook handler. `priority` defaults to 10; lower = earlier execution |
| `pluginId` | string | This plugin's ID (from `plugin.json` `id` field) |

---

## Reading Plugin Config

Inside a filter/call handler, read config from the `extra.options` object passed in:

```ts
// Plugins in the main project can import loadPluginConfig from '@/lib/plugin'
// Standalone npm plugins should implement their own config parsing (see captcha example)

addHook('feedback:comment', pluginId, async (commentData: { _rejected?: string }, extra?: { options?: Record<string, unknown> }) => {
  if (!extra?.options) return commentData;

  // Read this plugin's config (auto-merged with plugin.json defaults)
  const raw = extra.options[`plugin:${pluginId}`];
  const config = typeof raw === 'string' ? JSON.parse(raw) : {};

  if (!config.apiKey) return commentData;  // Not configured, skip

  // ... business logic
  return commentData;
});
```

Config storage: `typecho_options` table, `name = "plugin:<pluginId>"`, value is a JSON string.

---

## Complete Hook Reference

### call type (side effects, no return value)

| Hook | Trigger Location | Arguments |
|------|-----------------|-----------|
| `system:begin` | Every request init | `(context)` |
| `admin:header` | Admin `<head>` | — |
| `admin:footer` | Admin footer | — |
| `admin:navBar` | Admin navigation | — |
| `admin:writePost:option` | Post editor sidebar options | `(post)` |
| `admin:writePost:advanceOption` | Post editor advanced options | `(post)` |
| `admin:writePost:bottom` | Post editor bottom area | `(post)` |
| `admin:writePage:option` | Page editor sidebar options | `(page)` |
| `admin:writePage:advanceOption` | Page editor advanced options | `(page)` |
| `admin:writePage:bottom` | Page editor bottom area | `(page)` |
| `post:finishPublish` | After post published | `(post)` |
| `post:finishSave` | After post saved | `(post)` |
| `post:delete` | Before post deleted | `(post)` |
| `post:finishDelete` | After post deleted | `(cid)` |
| `page:finishPublish` | After page published | `(page)` |
| `page:finishSave` | After page saved | `(page)` |
| `page:delete` | Before page deleted | `(page)` |
| `page:finishDelete` | After page deleted | `(cid)` |
| `feedback:finishComment` | After comment saved | `(comment)` |
| `upload:beforeUpload` | Before file upload | `(file)` |
| `upload:upload` | After file uploaded | `(file)` |
| `upload:delete` | File deletion | `(path)` |

### filter type (must return a value)

| Hook | Trigger Location | Arguments | Description |
|------|-----------------|-----------|-------------|
| `content:markdown` | Before Markdown render | `(markdown, post)` | Filter raw Markdown text |
| `content:content` | After Markdown render | `(html, post)` | Filter output HTML |
| `content:title` | Title output | `(title, post)` | Filter post title |
| `content:excerpt` | Excerpt output | `(excerpt, post)` | Filter post excerpt |
| `comment:content` | Comment content output | `(html, comment)` | Filter comment HTML |
| `comment:markdown` | Comment Markdown | `(markdown, comment)` | Filter raw comment text |
| `post:write` | Before post save | `(data, extra)` | Filter post write data |
| `page:write` | Before page save | `(data, extra)` | Filter page write data |
| `feedback:comment` | Before comment save | `(commentData, extra)` | Validate/modify comment; set `_rejected` to reject |
| `feed:item` | RSS/Atom generation | `(item, post)` | Filter feed item |
| `widget:sidebar` | Sidebar render | `(sidebarData, context)` | Filter sidebar data |
| `plugin:config:beforeSave` | Before plugin config save | `(result, extra)` | Validate or normalize plugin config; return `{ success, settings?, error? }` |

`applyFilter` propagates plugin exceptions by default. Business flows such as content saving, comments, login, and plugin configuration will stop and surface the error. Presentation-only injection points can be wrapped by `applyFilterSafely`; when one plugin fails, that plugin output is skipped and rendering continues.

---

## Rejecting Comments

In a `feedback:comment` filter, set `commentData._rejected` to reject the comment:

```ts
addHook('feedback:comment', pluginId, async (commentData, extra) => {
  if (spamDetected) {
    commentData._rejected = 'Spam detected';  // Non-empty string = rejected with 403
  }
  return commentData;
});
```

---

## Providing Client-Side Code to Themes

Plugins can automatically inject HTML/JS into frontend pages via `archive:header` and `archive:footer` filters — no theme modification required:

```ts
// index.ts
import type { PluginInitContext } from '@/lib/plugin';

export default function init({ addHook, pluginId }: PluginInitContext): void {
  // Inject <head> content (e.g., SDK scripts)
  addHook('archive:header', pluginId, (headHtml: string, extra?: { options?: Record<string, unknown> }) => {
    const config = getPluginConfig(extra?.options);
    if (!config.sitekey) return headHtml;
    return headHtml + '<script src="..."></script>';
  });

  // Inject content before </body> (e.g., interaction scripts)
  addHook('archive:footer', pluginId, (bodyHtml: string, extra?: { options?: Record<string, unknown> }) => {
    const config = getPluginConfig(extra?.options);
    if (!config.sitekey) return bodyHtml;
    return bodyHtml + '<script>/* ... */</script>';
  });
}
```

The `Base.astro` layout automatically calls `getClientSnippets(options)` to collect injections from all activated plugins — themes need no additional code.

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

---

## Reference Example

`typecho-plugin-captcha/` demonstrates:
- `plugin.json` config declaration (7 field types in use)
- `feedback:comment` filter hook (token validation + comment rejection)
- Reading plugin config (with DEFAULTS fallback)
- Named export `getClientSnippet()` for theme integration
- Correct client IP extraction (CF-Connecting-IP priority)
