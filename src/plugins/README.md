# 插件开发规范

> 本文档是 Typecho-CF 插件开发的完整参考。以 `typecho-plugin-antispam/` 目录为示例。

[English](README.en.md)

---

## 目录结构

```
typecho-plugin-example/
├── package.json     # npm 包声明（keywords 必须包含 typecho + plugin，typecho.plugin 包含元数据）
└── index.ts         # 入口文件（ESM，export default init 函数）
```

> 插件加载器优先发现 `index.ts`，然后才回退到 `index.js` / `index.mjs` / `plugin.ts` / `plugin.js`。本仓库内置插件统一使用 TypeScript；发布为独立 npm 包时，可将 TS 编译为 JS 并在 `package.json` 的 `typecho.plugin.entry` 中指向编译产物。

---

## package.json

插件元数据放在 `typecho.plugin` 字段。不要使用已淘汰的根级 `plugin.json`。

```json
{
  "name": "typecho-plugin-example",
  "version": "1.0.0",
  "description": "插件描述",
  "keywords": ["typecho", "plugin"],
  "author": "Your Name",
  "license": "MIT",
  "type": "module",
  "main": "index.ts",
  "typecho": {
    "plugin": {
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
  }
}
```

**关键约束**：
- `keywords` 必须同时包含 `"typecho"` 和 `"plugin"`，否则构建时不会被发现
- `"type": "module"` — 使用 ESM（`export default`，不用 `module.exports`）
- `main` 指向入口文件；本仓库本地插件使用 `index.ts`
- `typecho.plugin` 包含插件元数据（id、name、config 等）

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

`password` / `hidden` 值在管理 API 和页面中只返回占位符，原文不会下发浏览器。`repeatable` 内的 Secret 也会递归掩码，并通过内部行标识在删除或重排行后恢复到正确记录；该标识不会写入插件配置。`plugin:config:beforeSave` 收到的是已恢复且仅包含 manifest 声明字段的配置。

---

## index.ts 入口

```ts
/**
 * 插件入口函数。构建时只登记懒加载器；插件首次激活时才调用 init。
 * 所有 Hook 注册通过 addHook 完成，此处不要执行 I/O。
 */
import type { PluginInitContext } from 'typecho/plugin-sdk';

export default function init({ addHook, pluginId }: PluginInitContext): void {
  // filter 钩子：修改数据并返回
  addHook('content:rendered', pluginId, (html: string) => {
    return html + '<!-- powered by example plugin -->';
  });

  // call 钩子：执行副作用，不需要返回值
  addHook('comment:afterCreate', pluginId, (comment: { coid?: number }) => {
    console.log('新评论：', comment.coid);
  });
}
```

### 参数说明

| 参数 | 类型 | 说明 |
|------|------|------|
| `addHook(point, pluginId, handler, priority?)` | function | 注册钩子处理函数。`priority` 默认 10，越小越早执行 |
| `pluginId` | string | 当前插件 ID（来自 `package.json` 的 `typecho.plugin.id` 字段） |

---

## 多语言翻译

插件可以在 `init()` 中注册静态翻译件。翻译件应放在插件包自己的 `locales/` 目录，并在初始化时同步注册：

```ts
import type { PluginInitContext } from 'typecho/plugin-sdk';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

export default function init({ addHook, pluginId, registerTranslations }: PluginInitContext): void {
  registerTranslations('en', en, 'English');
  registerTranslations('zh-CN', zhCN, '中文（简体）');

  addHook('frontend:footer', pluginId, (html, extra) => {
    const label = extra?.i18n?.t('plugin.typecho-plugin-example.label', {}, 'Example');
    return html + `<span>${label}</span>`; // 拼接 HTML 前请自行转义
  });
}
```

`registerTranslations(locale, messages, displayName?)` 支持新增语言、补充已有语言、完整覆盖或部分覆盖核心/其他插件的 key。合并顺序是核心目录 → `options.activatedPlugins` 中的插件顺序 → 当前插件内的注册调用顺序；后注册的同名 key 覆盖先注册的值，不使用额外的 `priority`。只有激活插件的翻译件参与全局查找，插件未提供的 key 会继续按当前语言、语言族和 `en` 回退。推荐使用 `plugin.<pluginId>.*` 命名空间；如果有意覆盖系统 key，应在文档中说明。

Hook 的 `extra.i18n` 是当前请求的 request-local 翻译器，使用 `i18n.t(key, variables, fallbackText)` 或 `i18n.tPlural(...)`。翻译值是纯文本，只支持简单的 `{name}` / `{count}` 插值，不解析 ICU，不允许翻译件直接携带 HTML。

插件生成由浏览器后续执行的内联脚本时，不要读取 `navigator.language` 或扫描 DOM。请只注入当前请求已经解析好的有限消息包，并使用 SDK 的 `safeJsonForScript()` 安全序列化；脚本直接使用这些消息生成提示。

---

## 读取插件配置

在 filter/call 处理函数中，从传入的 `extra.options` 读取配置：

```ts
import { loadPluginConfig } from 'typecho/plugin-sdk';

addHook('comment:beforeSave', pluginId, async (commentData: { _rejected?: string }, extra?: { options?: Record<string, unknown> }) => {
  if (!extra?.options) return commentData;

  // 读取本插件配置（已与 typecho.plugin.config 默认值合并）
  const config = loadPluginConfig(extra.options, pluginId);

  if (!config.apiKey) return commentData;  // 未配置，跳过

  // ... 业务逻辑
  return commentData;
});
```

> 主项目内插件也可直接解析 `extra.options[\`plugin:${pluginId}\`]`（JSON 字符串）。独立 npm 插件推荐使用 SDK 提供的 `loadPluginConfig`。

配置存储：`typecho_options` 表，`name = "plugin:<pluginId>"`，值为 JSON 字符串。

---

## 当前已接入的 Hook 参考

以下是运行时已经有实际触发位置的完整 canonical Hook 名称。新插件应使用这些名称；未列出的 `HookPoints` 常量无调用保证。新增触发点时需同时更新 `HookPoints`、调用位置和本文档。

### call 类型（副作用，无需返回值）

| Hook | 触发位置 | 参数 |
|------|---------|------|
| `request:begin` / `request:end` | 请求上下文初始化完成 / 响应最终确定 | `(context)` / `({ request, response })` |
| `admin:begin` / `admin:end` | 管理布局开始 / 管理布局数据确定 | `(context)` |
| `archive:init` | 归档或单篇数据初始化 | `(context)` |
| `archive:index` / `archive:single` / `archive:category` / `archive:tag` / `archive:author` / `archive:search` | 对应归档或单篇数据准备前 | `(context)` |
| `archive:beforeRender` / `archive:afterRender` | 前台文档响应渲染前 / 后 | `(context)` / `({ ..., response })` |
| `post:afterPublish` / `post:afterSave` | 文章发布后 / 保存后 | `(post)` |
| `post:beforeDelete` / `post:afterDelete` | 文章删除前 / 后 | `(post)` |
| `page:afterPublish` / `page:afterSave` | 页面发布后 / 保存后 | `(page)` |
| `page:beforeDelete` / `page:afterDelete` | 页面删除前 / 后 | `(page)` |
| `comment:afterCreate` | 评论保存后 | `(comment)` |
| `feedback:trackback:after` | Trackback 写入后 | `(comment, extra)` |
| `feedback:pingback:after` | Pingback 写入后 | `(comment, extra)` |
| `comment:reply` | 回复评论写入后 | `(comment, { parent })` |
| `comment:action` | 评论审核动作完成 | `(comment, extra)` |
| `user:login:success` / `user:login:failure` | 登录成功 / 登录拒绝 | `(summary)` / `({ request, reason })` |
| `user:logout` | 登出 Cookie 清理后 | `({ request })` |
| `user:register:after` | 用户写入成功后 | `(userSummary)` |
| `upload:after` | 文件写入成功后 | `(upload, extra)` |
| `upload:delete` | 附件删除后 | `(attachment, extra)` |

### filter 类型（必须返回值）

| Hook | 触发位置 | 参数 | 说明 |
|------|---------|------|------|
| `request:route` | 中间件路由分发 | `(result, extra)` | 处理插件自定义路由；管理/API 路径还需 `registerPluginAdminPath`，前台路径建议 `registerPluginRoute` |
| `admin:head` / `admin:footer` | 管理后台头部/底部 | `(html, extra)` | 安全展示型 HTML 注入 |
| `admin:nav` | 管理后台导航生成 | `(groups, extra)` | 修改分组/菜单项；系统会校验 href 只能指向本站管理路径或锚点 |
| `admin:login:head` / `admin:login:form` | 登录页头部/表单 | `(html, extra)` | 登录页 HTML 注入 |
| `admin:page` | `/admin/plugin/[slug]` | `(html, extra)` | 渲染插件专属管理页面 |
| `admin:writePost:option` / `admin:writePost:advanceOption` / `admin:writePost:bottom` | 文章编辑器选项/高级选项/底部 | `(html, extra)` | 编辑器 UI 注入 |
| `admin:writePage:option` / `admin:writePage:advanceOption` / `admin:writePage:bottom` | 页面编辑器选项/高级选项/底部 | `(html, extra)` | 编辑器 UI 注入 |
| `admin:managePosts:titleActions` | 文章列表标题操作区 | `(html, extra)` | 在每篇文章标题旁追加管理操作 |
| `admin:profile:bottom` | 个人资料页底部 | `(html, extra)` | 个人资料 UI 注入 |
| `plugin:config:beforeSave` | 插件配置保存前 | `(result, extra)` | 校验或规范化配置，返回 `{ success, settings?, error? }` |
| `archive:query` | 归档查询参数准备时 | `(state, context)` | 可调整页码/页大小，或返回安全的额外 SQL 条件；系统可见性和归档范围受保护 |
| `frontend:head` / `frontend:footer` | 前台页面头部/底部 | `(html, extra)` | 主题无关的前台 HTML/JS 注入 |
| `content:data` | 文章数据准备后 | `(content, extra)` | 修改展示数据；查询、权限、身份和固定链接字段受保护 |
| `content:title` | 文章标题展示前 | `(title, extra)` | 修改展示标题 |
| `content:excerpt` | 文章摘要展示前 | `(excerpt, extra)` | 修改展示摘要 |
| `content:markdown` | Markdown 渲染前 | `(markdown, extra?)` | 过滤原始 Markdown 文本 |
| `content:rendered` | Markdown 净化后 | `(html, extra?)` | 过滤最终文章 HTML |
| `comment:data` | 评论展示数据准备后 | `(comment, extra)` | 修改展示字段；身份、审核状态和树关系受保护 |
| `comment:markdown` | 评论 Markdown 渲染前 | `(markdown, extra?)` | 过滤原始评论 Markdown |
| `comment:rendered` | 评论 HTML 净化后 | `(html, extra?)` | 过滤最终评论 HTML |
| `post:write` | 文章保存前 | `(data, extra)` | 仅可修改声明的文章字段，返回值会重新校验 |
| `page:write` | 页面保存前 | `(data, extra)` | 可修改字段同 `post:write`；authorId、type、cid 与关系数据受保护 |
| `comment:beforeSave` | 评论保存前 | `(commentData, extra)` | 仅可修改 author、mail、url、text、status，设置 `_rejected` 可拒绝 |
| `feedback:trackback:before` | Trackback 写入前 | `(data, extra)` | 校验或规范化引用反馈数据 |
| `feedback:pingback:before` | Pingback 写入前 | `(data, extra)` | 校验或规范化引用反馈数据 |
| `user:login:before` | 密码校验前 | `(context, extra)` | 设置 `_rejected` 可拒绝登录；密码不会传给插件 |
| `user:register:before` | 用户写入前 | `(data, extra)` | 校验/规范化公开注册字段；密码、权限、认证码由系统控制 |
| `upload:before` | 上传写入前 | `(result, extra)` | 设置拒绝原因可中止上传 |
| `feed:item` | 单条 RSS/Atom/RSS1 项生成后 | `(item, extra?)` | 过滤 feed 条目 |
| `feed:render` | 完整 XML 生成后 | `(xml, extra)` | 过滤整份 RSS/Atom/RSS1 文档；响应类型和缓存头由系统控制 |
| `sidebar:data` | 侧边栏数据生成后 | `(sidebarData, extra)` | 过滤侧边栏数据 |
| `csp:directives` | 安全响应头生成 | `(directives, extra)` | 追加插件所需 CSP 来源，不应清空默认项 |
| `mail:send` | 邮件发送适配 | `(result, extra)` | 首个返回 `sent: true` 的插件完成投递 |
| `plugin:<id>:action:authorize` | 插件动作鉴权 | `(role, extra)` | 为指定 action 声明最低角色，默认 administrator |
| `plugin:<id>:action` | `/api/admin/plugin-action` | `(result, extra)` | 执行插件管理动作并返回 handled 结果 |

### 兼容别名

旧名称仍会归一化到 canonical 名称，因此已有插件可以继续运行，但新代码不要再注册旧名称。重要映射包括：`system:begin → request:begin`、`system:end → request:end`、`route:request → request:route`、`archive:header/footer → frontend:head/footer`、`content:filter → content:data`、`content:content → content:rendered`、`feedback:comment → comment:beforeSave`、`upload:beforeUpload → upload:before`、`upload:upload → upload:after`、`feed:generate → feed:render`、`widget:sidebar → sidebar:data`。完整映射见 `DeprecatedHookPointAliases`。

`applyFilter` 默认会传播插件异常。业务链路（保存内容、评论、登录、插件配置等）会因此中止并暴露错误。纯展示注入点可由系统使用 `applyFilterSafely` 包裹，单个插件失败时跳过该插件输出并继续渲染。

写入 Filter 的返回值不是任意数据库行。系统会丢弃未声明字段、恢复受保护字段，并重新校验字符串长度、数字、枚举、开关值和 slug。评论的 `cid`、`created`、`authorId`、`ownerId`、`ip`、`agent`、`type`、`parent` 不可修改；内容的 `authorId`、`type`、`cid` 和分类/标签关系不可修改。计数和关系更新始终依据重新校验后的最终记录。

---

## 拒绝评论

在 `comment:beforeSave` filter 中，设置 `commentData._rejected` 可拒绝评论：

```ts
addHook('comment:beforeSave', pluginId, async (commentData, extra) => {
  if (spamDetected) {
    commentData._rejected = '检测到垃圾评论';  // 非空字符串 = 拒绝，返回 403
  }
  return commentData;
});
```

---

## 向主题提供客户端代码

插件可通过 `frontend:head` 和 `frontend:footer` filter 自动向前端页面注入 HTML/JS，无需主题手动适配：

```ts
// index.ts
import type { PluginInitContext } from 'typecho/plugin-sdk';
import { loadPluginConfig } from 'typecho/plugin-sdk';

export default function init({ addHook, pluginId }: PluginInitContext): void {
  // 注入 <head> 内容（如 SDK 脚本）
  addHook('frontend:head', pluginId, (headHtml: string, extra?: { options?: Record<string, unknown> }) => {
    const config = loadPluginConfig(extra?.options, pluginId);
    if (!config.sitekey) return headHtml;
    return headHtml + '<script src="..."></script>';
  });

  // 注入 </body> 前内容（如交互脚本）
  addHook('frontend:footer', pluginId, (bodyHtml: string, extra?: { options?: Record<string, unknown> }) => {
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
| 插件系统 | `HookPoints`, `parsePluginOption`, `parsePluginConfigFormData`, `loadPluginConfig`, `escapeAttr`, `registerPluginAdminPath`, `registerPluginRoute`, `getClientIp` |
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
- [ ] `pageContext` 守卫已测试（针对 `frontend:head`/`frontend:footer` hook）

## 参考示例

`typecho-plugin-antispam/` 目录演示了：
- `package.json` 配置声明（在 `typecho.plugin` 中）
- `comment:beforeSave` filter 钩子（反垃圾评论）
- 读取插件配置
- 正确提取客户端 IP（优先 CF-Connecting-IP）
