# 插件开发规范

> 本文档是 Typecho-CF 插件开发的完整参考。以 `typecho-plugin-captcha/` 目录为示例。

[English](README.en.md)

---

## 目录结构

```
typecho-plugin-example/
├── package.json     # npm 包声明（keywords 必须包含 typecho + plugin）
├── plugin.json      # 插件元数据（含可选配置声明）
└── index.ts         # 入口文件（ESM，export default init 函数）
```

> 插件加载器优先发现 `index.ts`，然后才回退到 `index.js` / `index.mjs` / `plugin.ts` / `plugin.js`。本仓库内置插件统一使用 TypeScript；发布为独立 npm 包时，可将 TS 编译为 JS 并在 `plugin.json` 的 `entry` 中指向编译产物。

---

## package.json

```json
{
  "name": "typecho-plugin-example",
  "version": "1.0.0",
  "description": "插件描述",
  "keywords": ["typecho", "plugin"],
  "author": "Your Name",
  "license": "MIT",
  "type": "module",
  "main": "index.ts"
}
```

**关键约束**：
- `keywords` 必须同时包含 `"typecho"` 和 `"plugin"`，否则构建时不会被发现
- `"type": "module"` — 使用 ESM（`export default`，不用 `module.exports`）
- `main` 指向入口文件；本仓库本地插件使用 `index.ts`

---

## plugin.json

```json
{
  "id": "typecho-plugin-example",
  "name": "示例插件",
  "description": "插件功能描述",
  "author": "Your Name",
  "authorUrl": "https://example.com",
  "version": "1.0.0",
  "homepage": "https://github.com/...",
  "license": "MIT",
  "tags": ["example"],
  "config": {
    "fieldName": {
      "type": "text",
      "label": "字段标签",
      "default": "",
      "description": "帮助文本（支持 HTML）"
    }
  }
}
```

### 配置字段类型

| 类型 | 说明 | 额外字段 |
|------|------|---------|
| `text` | 单行文本 | — |
| `textarea` | 多行文本 | — |
| `password` | 密码（掩码显示） | — |
| `hidden` | 隐藏字段 | — |
| `select` | 下拉选择 | `options: { value: label }` |
| `radio` | 单选按钮 | `options: { value: label }` |
| `checkbox` | 多选框 | `options: { value: label }`，default 为数组 |
| `repeatable` | 可重复配置组 | `itemFields: { fieldName: fieldDef }`，default 为对象数组 |

声明了 `config` 后，管理插件列表中自动显示「设置」链接，跳转到 `/admin/plugin-config?id=<pluginId>`。

`repeatable` 用于多个同结构配置项，例如多个后端存储挂载：

```json
{
  "type": "repeatable",
  "label": "后端存储挂载",
  "default": [{ "mount": "media", "provider": "r2" }],
  "itemFields": {
    "mount": { "type": "text", "label": "挂载目录", "default": "media" },
    "provider": {
      "type": "select",
      "label": "存储类型",
      "default": "r2",
      "options": { "r2": "Cloudflare R2", "s3": "Amazon S3 兼容" }
    }
  }
}
```

字段可选 `showWhen` 做条件显示，可选 `optionsSource: "r2Bindings"` 将下拉选项填充为当前 Worker 环境中的 R2 bucket binding。

---

## index.ts 入口

```ts
/**
 * 插件入口函数，由系统在构建时调用。
 * 所有 Hook 注册通过 addHook 完成，此处不要执行 I/O。
 */
import type { PluginInitContext } from 'typecho/plugin-sdk';

export default function init({ addHook, pluginId }: PluginInitContext): void {
  // filter 钩子：修改数据并返回
  addHook('content:content', pluginId, (html: string) => {
    return html + '<!-- powered by example plugin -->';
  });

  // call 钩子：执行副作用，不需要返回值
  addHook('feedback:finishComment', pluginId, (comment: { coid?: number }) => {
    console.log('新评论：', comment.coid);
  });
}
```

### 参数说明

| 参数 | 类型 | 说明 |
|------|------|------|
| `addHook(point, pluginId, handler, priority?)` | function | 注册钩子处理函数。`priority` 默认 10，越小越早执行 |
| `pluginId` | string | 当前插件 ID（来自 `plugin.json` 的 `id` 字段） |

---

## 读取插件配置

在 filter/call 处理函数中，从传入的 `extra.options` 读取配置：

```ts
import { loadPluginConfig } from 'typecho/plugin-sdk';

addHook('feedback:comment', pluginId, async (commentData: { _rejected?: string }, extra?: { options?: Record<string, unknown> }) => {
  if (!extra?.options) return commentData;

  // 读取本插件配置（已与 plugin.json 默认值合并）
  const config = loadPluginConfig(extra.options, pluginId);

  if (!config.apiKey) return commentData;  // 未配置，跳过

  // ... 业务逻辑
  return commentData;
});
```

> 主项目内插件也可直接解析 `extra.options[\`plugin:${pluginId}\`]`（JSON 字符串）。独立 npm 插件推荐使用 SDK 提供的 `loadPluginConfig`。

配置存储：`typecho_options` 表，`name = "plugin:<pluginId>"`，值为 JSON 字符串。

---

## 完整 Hook 参考

### call 类型（副作用，无需返回值）

| Hook | 触发位置 | 参数 |
|------|---------|------|
| `system:begin` | 每次请求初始化 | `(context)` |
| `admin:header` | 管理后台 `<head>` | — |
| `admin:footer` | 管理后台底部 | — |
| `admin:navBar` | 管理后台导航 | — |
| `admin:writePost:option` | 文章编辑器侧边栏选项 | `(post)` |
| `admin:writePost:advanceOption` | 文章编辑器高级选项 | `(post)` |
| `admin:writePost:bottom` | 文章编辑器底部区域 | `(post)` |
| `admin:writePage:option` | 页面编辑器侧边栏选项 | `(page)` |
| `admin:writePage:advanceOption` | 页面编辑器高级选项 | `(page)` |
| `admin:writePage:bottom` | 页面编辑器底部区域 | `(page)` |
| `post:finishPublish` | 文章发布后 | `(post)` |
| `post:finishSave` | 文章保存后 | `(post)` |
| `post:delete` | 文章删除前 | `(post)` |
| `post:finishDelete` | 文章删除后 | `(cid)` |
| `page:finishPublish` | 页面发布后 | `(page)` |
| `page:finishSave` | 页面保存后 | `(page)` |
| `page:delete` | 页面删除前 | `(page)` |
| `page:finishDelete` | 页面删除后 | `(cid)` |
| `feedback:finishComment` | 评论保存后 | `(comment)` |
| `upload:beforeUpload` | 文件上传前 | `(file)` |
| `upload:upload` | 文件上传后 | `(file)` |
| `upload:delete` | 文件删除 | `(path)` |

### filter 类型（必须返回值）

| Hook | 触发位置 | 参数 | 说明 |
|------|---------|------|------|
| `content:markdown` | Markdown 渲染前 | `(markdown, post)` | 过滤原始 Markdown 文本 |
| `content:content` | Markdown 渲染后 | `(html, post)` | 过滤输出 HTML |
| `content:title` | 标题输出 | `(title, post)` | 过滤文章标题 |
| `content:excerpt` | 摘要输出 | `(excerpt, post)` | 过滤文章摘要 |
| `comment:content` | 评论内容输出 | `(html, comment)` | 过滤评论 HTML |
| `comment:markdown` | 评论 Markdown | `(markdown, comment)` | 过滤评论原始文本 |
| `post:write` | 文章保存前 | `(data, extra)` | 过滤文章写入数据 |
| `page:write` | 页面保存前 | `(data, extra)` | 过滤页面写入数据 |
| `admin:managePosts:titleActions` | 文章列表标题操作区 | `(html, extra)` | 在每篇文章标题旁追加管理操作 |
| `feedback:comment` | 评论保存前 | `(commentData, extra)` | 验证/修改评论，设置 `_rejected` 可拒绝 |
| `feed:item` | RSS/Atom 生成 | `(item, post)` | 过滤 feed 条目 |
| `widget:sidebar` | 侧边栏渲染 | `(sidebarData, context)` | 过滤侧边栏数据 |
| `plugin:config:beforeSave` | 插件配置保存前 | `(result, extra)` | 校验或规范化插件配置，返回 `{ success, settings?, error? }` |

`applyFilter` 默认会传播插件异常。业务链路（保存内容、评论、登录、插件配置等）会因此中止并暴露错误。纯展示注入点可由系统使用 `applyFilterSafely` 包裹，单个插件失败时跳过该插件输出并继续渲染。

---

## 拒绝评论

在 `feedback:comment` filter 中，设置 `commentData._rejected` 可拒绝评论：

```ts
addHook('feedback:comment', pluginId, async (commentData, extra) => {
  if (spamDetected) {
    commentData._rejected = '检测到垃圾评论';  // 非空字符串 = 拒绝，返回 403
  }
  return commentData;
});
```

---

## 向主题提供客户端代码

插件可通过 `archive:header` 和 `archive:footer` filter 自动向前端页面注入 HTML/JS，无需主题手动适配：

```ts
// index.ts
import type { PluginInitContext } from 'typecho/plugin-sdk';
import { loadPluginConfig } from 'typecho/plugin-sdk';

export default function init({ addHook, pluginId }: PluginInitContext): void {
  // 注入 <head> 内容（如 SDK 脚本）
  addHook('archive:header', pluginId, (headHtml: string, extra?: { options?: Record<string, unknown> }) => {
    const config = loadPluginConfig(extra?.options, pluginId);
    if (!config.sitekey) return headHtml;
    return headHtml + '<script src="..."></script>';
  });

  // 注入 </body> 前内容（如交互脚本）
  addHook('archive:footer', pluginId, (bodyHtml: string, extra?: { options?: Record<string, unknown> }) => {
    const config = loadPluginConfig(extra?.options, pluginId);
    if (!config.sitekey) return bodyHtml;
    return bodyHtml + '<script>/* ... */</script>';
  });
}
```

`Base.astro` 布局会自动调用 `getClientSnippets(options)` 收集所有激活插件的注入内容，主题无需任何额外代码。

---

## Plugin SDK

本仓库内的插件通过 `typecho/plugin-sdk` 导入公共 API。SDK 使用 barrel export 模式，集中 re-export 插件常用的类型和函数。

### 导入方式

```ts
// 在 monorepo 内（通过 tsconfig paths + Vite alias 解析）
import { parsePluginOption, escapeAttr, fetchWithTimeout } from 'typecho/plugin-sdk';
import type { PluginInitContext } from 'typecho/plugin-sdk';

// 需要直接访问数据库 Schema 的插件
import type { Database } from 'typecho/db';
import { schema } from 'typecho/db';
```

### 独立 npm 包

插件发布为独立 npm 包时，需在 `package.json` 中将 `typecho` 声明为 `peerDependencies`：

```json
{
  "name": "typecho-plugin-example",
  "peerDependencies": {
    "typecho": ">=0.1.0"
  }
}
```

安装时宿主项目会自动提供 `typecho` 包，`typecho/plugin-sdk` 通过 `package.json` 的 `exports` 字段解析。

### SDK 导出一览

| 类别 | 导出 |
|------|------|
| 类型 | `PluginInitContext`, `PluginRouteResult`, `PluginManifest`, `PluginConfigField`, `AttachmentMeta`, `Database` |
| 插件系统 | `HookPoints`, `parsePluginOption`, `parsePluginConfigFormData`, `loadPluginConfig`, `escapeAttr`, `getClientIp` |
| 认证 | `hasPermission`, `verifyPassword` |
| 内容 | `buildPermalink`, `formatDate`, `buildAuthorLink`, `buildCategoryLink` |
| Markdown/HTML | `escapeHtml`, `renderMarkdown`, `renderMarkdownFiltered`, `renderContentExcerpt`, `generateExcerpt`, `autop`, `stripTypechoMarkers`, `stripHtmlTags` |
| 网络 | `fetchWithTimeout` |
| 附件 | `parseAttachmentMeta` |
| URL | `normalizeHttpUrl` |
| 选项 | `getOption`, `setOption` |

---

## 安装到项目

### 本地开发（工作区包）

1. 将插件目录放在 `src/plugins/` 下
2. 在根 `package.json` 的 `dependencies` 中添加 `"<packageName>": "file:src/plugins/<packageName>"`
3. 运行 `pnpm install`
4. 重新执行 `pnpm run build`

### npm 发布后安装

```bash
pnpm add typecho-plugin-example
pnpm run build
```

> 独立发布的插件必须将 `typecho` 声明为 `peerDependencies`。宿主项目安装插件时，`typecho` 包会自动提供 SDK 解析。

---

## 测试

每个插件必须包含 `index.test.ts`，与 `index.ts` 同目录，使用 vitest。

### 测试基础设施

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import init from './index';

// 通过 mock PluginInitContext 收集注册的 hooks
function collectHooks() {
  const hooks = new Map<string, Function>();
  init({
    pluginId: 'typecho-plugin-<name>',
    HookPoints: {} as any,
    addHook: (point: string, _pluginId: string, handler: Function) => {
      hooks.set(point, handler);
    },
  });
  return hooks;
}

// 构造插件运行时读取的 options 对象
function options(settings: Record<string, unknown>) {
  return {
    'plugin:typecho-plugin-<name>': JSON.stringify(settings),
    // 可包含插件读取的站点级配置（如 siteUrl、secret）
  };
}
```

### 必备测试类别

1. **Hook 注册** — 验证 `hooks.keys()` 与预期的 hook 集合一致
2. **守卫分支** — 未配置时跳过、已登录时跳过、pageContext 跳过
3. **正常路径** — 有效输入下各项功能正常工作
4. **拒绝路径** — 各守卫/检查正确拒绝
5. **模式分发** — 若插件支持多种模式（如 spam/waiting/discard），覆盖每种模式
6. **边界情况** — 零值、空字符串、缺失 token、API 故障
7. **外部 API mock** — 使用 `vi.stubGlobal('fetch', mock)`，在 `afterEach` 中调用 `vi.unstubAllGlobals()`
8. **配置验证** — `plugin:config:beforeSave` 接受合法配置，拒绝非法配置，忽略其他插件

### 文件命名

- `index.test.ts` — 与 `index.ts` 同目录

### 运行

```sh
npx vitest run src/plugins/<插件名>/index.test.ts
```

### 新插件检查清单

- [ ] `index.test.ts` 存在
- [ ] 所有注册的 hook 已验证
- [ ] 每个检查分支至少有 1 个测试
- [ ] 默认模式/spam 路径已覆盖
- [ ] discard/reject 路径已覆盖（如适用）
- [ ] 已登录用户跳过已测试
- [ ] 缺少配置时跳过已测试
- [ ] API 故障（mock）不会导致 handler 崩溃
- [ ] `pageContext` 守卫已测试（针对 `archive:header`/`archive:footer` hook）

## 参考示例

`typecho-plugin-captcha/` 目录演示了：
- `plugin.json` 配置声明（7 种字段类型）
- `feedback:comment` filter 钩子（token 验证 + 评论拒绝）
- 读取插件配置（含 DEFAULTS fallback）
- 具名导出 `getClientSnippet()` 供主题集成
- 正确提取客户端 IP（优先 CF-Connecting-IP）
