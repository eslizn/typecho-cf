# AGENTS.md — OpenSpec SDD

> 面向 AI 编程助手的规格驱动开发（Specification-Driven Development）文档。
> 定义项目架构、编码约定与不可变约束，确保 AI Agent 生成代码的一致性。

---

## 1. 项目标识

| 属性 | 值 |
|------|-----|
| 名称 | Typecho-CF |
| 描述 | Typecho 博客系统的 TypeScript 重写，运行于 Astro + Cloudflare Workers + D1 |
| 仓库 | `https://github.com/eslizn/typecho-cf` |
| 许可证 | MIT |
| 包管理器 | pnpm（锁定） |

### 1.1 Agent 配置约定

跨客户端唯一权威规格是本文件 **`AGENTS.md`**。

| 路径 | 用途 |
|------|------|
| `AGENTS.md` | 项目规格（Cursor / Claude Code / Codex 等共用） |
| `.agents/skills/<name>/` | 跨客户端 Agent Skills（每个 skill 目录含 `SKILL.md`） |
| `.cursor/skills/<name>` | 可选：指向 `.agents/skills/<name>` 的符号链接（仅 Cursor 发现用） |
| `.claude/` | 本地 Claude Code 设置，不入库 |

任务型工作流写在 `.agents/skills/`；Cursor 需要发现时再建 symlink。

---

## 2. 技术栈

| 层 | 技术 | 版本约束 |
|----|------|---------|
| 框架 | Astro (SSR mode) | 7.x |
| 适配器 | @astrojs/cloudflare | 14.x |
| 运行时 | Cloudflare Workers | — |
| 数据库 | Cloudflare D1 (SQLite) | — |
| ORM | Drizzle ORM | 0.45.x |
| 文件存储 | Cloudflare R2 | — |
| 密码哈希 | PBKDF2-SHA256 | 100,000 迭代 + 16B salt（Cloudflare Workers Web Crypto 上限；更低迭代的存量 hash 在登录时机会式重哈希） |
| 测试 | Vitest | 4.x |
| 语言 | TypeScript | 7.x（ESLint / typescript-eslint 侧通过 `typescript-eslint-typescript` 别名固定使用 TS 6.0.x API） |

---

## 3. 架构

### 3.1 请求生命周期

```
请求 → src/middleware.ts
        ├─ 安装检测（typecho_options 表不存在 → /install）
        ├─ 分页 URL 重写（/page/N/ → 基础路径 + locals._page）
        ├─ 加载 options + 激活插件
        ├─ request:route filter（插件自定义路由）
        ├─ 边缘缓存（Cache API，跳过已登录/admin/api 路径）
        └─ 固定链接重写（post/page/category pattern → 内置路由）
     → src/lib/context.ts
        ├─ 初始化 DB 连接
        ├─ 加载 options + computeUrls
        ├─ 自动激活插件（首次安装/升级时）
        ├─ 验证 Cookie（__typecho_uid / __typecho_authCode）
        ├─ 生成 CSRF token
        └─ 触发 request:begin hook
     → 路由匹配（.astro 页面 或 .ts API 端点）
     → 布局渲染（Base.astro → Blog.astro 或 Admin.astro）
```

### 3.2 模块依赖图

```
src/middleware.ts       — 请求入口，安装检测，缓存，URL 重写
  ├─ src/lib/plugin.ts  — 插件注册表 + Hook 事件总线（核心）
  ├─ src/lib/options.ts — 站点配置 CRUD + computeUrls
  ├─ src/lib/cache.ts   — 选项缓存（Cache API + cacheVersion 版本戳 + 内存 memo）
  └─ src/db/index.ts    — Drizzle DB 实例工厂

src/lib/context.ts      — 请求上下文（DB / options / user / CSRF）
  ├─ src/lib/auth.ts    — PBKDF2 密码哈希 + Session Token + CSRF
  ├─ src/lib/plugin.ts  — setActivatedPlugins / doHook
  └─ src/lib/cache.ts

src/lib/plugin.ts       — 插件系统核心（~670 行）
  ├─ 插件注册表（Map<id, PluginInfo>）
  ├─ Hook 注册表（Map<HookPoint, HookRegistration[]>）
  ├─ doHook() — call 钩子（副作用，无返回值）
  ├─ applyFilter() — filter 钩子（链式变换，抛异常中断）
  ├─ applyFilterSafely() — filter 钩子（吞异常，展示用）
  └─ HookPoints 常量 — 70+ canonical 挂载点定义

src/lib/theme.ts        — 主题系统
src/integrations/theme-loader.ts   — 构建时发现主题包 → 虚拟模块
src/integrations/plugin-loader.ts  — 构建时发现插件包 → 注入注册表
src/lib/schema-sql.ts   — 运行时从 Drizzle schema 反射生成建表 SQL
src/lib/http.ts        — 标准化 HTTP 错误/成功响应（textError / jsonError / jsonOk）
src/lib/constants.ts   — 跨模块常量（密码最小长度、slug 后缀上限、上传限速、缓存 TTL 等）
```

---

## 4. 数据库

### 4.1 表结构（9 张表；7 张核心表与 PHP Typecho 兼容）

| 表名 | 用途 | 主键 |
|------|------|------|
| `typecho_users` | 用户（5 种角色） | uid (autoinc) |
| `typecho_contents` | 内容（文章/页面/草稿/附件） | cid (autoinc) |
| `typecho_comments` | 评论 | coid (autoinc) |
| `typecho_metas` | 元数据（分类/标签） | mid (autoinc) |
| `typecho_relationships` | 内容-元数据关联 | (cid, mid) |
| `typecho_options` | 站点配置（KV 结构） | (name, user) |
| `typecho_fields` | 扩展字段 | (cid, name) |
| `typecho_login_failures` | 登录限速（D1 持久化） | ip |
| `typecho_password_reset_requests` | 密码重置请求（限速 + 一次性令牌哈希） | email |

**不可变约束**：
- 表名必须保持 `typecho_*` 前缀，**不可重命名**
- 列名必须与 PHP Typecho 保持一致
- Schema 定义在 `src/db/schema.ts`，修改后必须运行 `pnpm run db:generate`；`drizzle/` 目录（迁移 SQL + meta 快照）已纳入版本控制，生成的迁移必须随 schema 变更一起提交
- **禁止手动修改 `drizzle/` 目录下的迁移文件**
- 建表 SQL 由 `src/lib/schema-sql.ts` 在运行时从 Drizzle schema 反射生成（`generateCreateSQL()` 同时输出 CREATE TABLE 与 CREATE INDEX；中间件首次命中时会在后台幂等地补齐生产库索引）
- FTS5 搜索索引（`typecho_contents_fts` 虚拟表 + 同步触发器）由运行时引导创建/回填（`src/lib/fulltext.ts`、`isolate-boot.ts`），属于派生索引，**不纳入 Drizzle schema 与迁移**；新库安装时由 `generateCreateSQL()` 一并创建
- D1 不支持真实事务；批量改写应使用 `db.batch([...])` 单次往返
- 评论的「能否审核」必须查 `contents.authorId`，禁止以 `comments.ownerId` 作为权限判定来源（ownerId 仅是内容作者变更前的历史快照）

### 4.2 关键枚举

```typescript
// contents.type
'post' | 'page' | 'post_draft' | 'page_draft' | 'attachment'

// contents.status
'publish' | 'draft' | 'hidden' | 'private' | 'waiting'

// comments.status
'approved' | 'waiting' | 'spam'

// users.group（数字越小权限越高）
'administrator'(0) | 'editor'(1) | 'contributor'(2) | 'subscriber'(3) | 'visitor'(4)
```

### 4.3 插件配置存储

- 存储在 `typecho_options` 表：`name = "plugin:<pluginId>"`，值为 JSON 字符串
- 通过 `loadPluginConfig(options, pluginId)` 读取（自动合并 manifest 默认值）
- 启用插件时自动写入默认配置，禁用时删除配置
- `typecho_options.secret` 是签名密钥，跨部署必须保留，**不可重置**

主题自定义配置（可选）使用同一套机制：`name = "theme:<themeId>"`，通过
`loadThemeConfig(options, themeId)` 读取；只有 manifest 声明非空 `config` 的主题
才会在「外观」页出现「设置」入口。

---

## 5. Cloudflare 绑定

| Binding | 类型 | 用途 |
|---------|------|------|
| `DB` | D1 | 数据库 `typecho-cf-db` |
| `BUCKET` | R2 | 文件存储 `typecho-cf-uploads` |
| `QUEUE` | Queue | 定时与异步任务主队列 `typecho-cf-tasks` |
| `ASSETS` | Fetcher | Astro 构建产物中的静态资源，由 Cloudflare adapter 管理 |

### 5.1 环境变量访问

```typescript
// ✅ 唯一正确方式
import { env } from 'cloudflare:workers';
const db = env.DB;
const bucket = env.BUCKET;

// ❌ 不要使用 Astro.locals.runtime.env.*
```

### 5.2 客户端 IP 获取

```typescript
// ✅ 统一使用
import { getClientIp } from '@/lib/client-ip';
const ip = getClientIp(request);

// ❌ 不要直接读 Header
// 优先级：CF-Connecting-IP > X-Forwarded-For 首个值
```

### 5.3 R2 文件访问

通过 `src/pages/usr/uploads/[...path].ts` 代理访问。

---

## 6. 插件系统

### 6.1 类型

| Hook 类型 | 函数 | 行为 |
|-----------|------|------|
| call | `doHook(point, ...args)` | 执行副作用，无返回值 |
| filter | `applyFilter(point, value, ...args)` | 链式变换，必须返回值，异常传播中断链路 |
| filter-safe | `applyFilterSafely(point, value, ...args)` | 链式变换，吞异常，展示用 |

### 6.2 注册

```typescript
addHook(hookPoint, pluginId, handler, priority = 10)
// priority 越小越先执行
// 同一 (pluginId, hookPoint, handler) 自动去重；重复 addHook 不会触发多次
```

### 6.2.1 懒加载初始化

- 插件 `init()` **不在 build 时直接执行**；`plugin-loader.ts` 通过 `registerPluginLoaders()` 登记字面量动态 import，未激活插件的模块不会在 isolate 启动时求值
- 真正的 `init({ addHook, pluginId })` 由异步的 `setActivatedPlugins(activatedIds)` 在第一次激活时按需触发；调用方必须 `await`，未激活的插件不会注入任何 hook
- 插件不要在模块顶层做副作用（数据库读写、外部请求、`addHook` 写入），所有注册逻辑必须放在导出的 `init()` 内
- `plugin-loader.ts` 生成的注册代码同时以 `virtual:typecho-plugin-registry` 虚拟模块暴露，并由 `src/middleware.ts` 静态导入；保证冷启动 isolate 的第一次请求（例如直接访问插件路由 `/webdav`）在 `setActivatedPlugins` 执行前 loader 表已就绪

### 6.3 插件管理路径注册

插件通过 `request:route` hook 处理的 admin/api 路径必须注册，否则中间件的 `isReservedCorePath` 会拦截：

```typescript
import { registerPluginAdminPath } from 'typecho/plugin-sdk';

export default function init({ addHook, pluginId }: PluginInitContext): void {
  // 注册插件的管理路径，使其不被中间件拦截
  registerPluginAdminPath('/api/admin/webdav');

  addHook('request:route', pluginId, async (result, extra) => {
    if (extra.path === '/api/admin/webdav') { /* ... */ }
    return result;
  });
}
```

- 路径应在插件 `init()` 中注册，在任何 hook handler 之前
- `isPluginAdminPath(path)` 在中间件 `isReservedCorePath` 中调用，白名单通过后放行
- 前台自定义路由（如 WebDAV 入口 `/webdav`）通过 `registerPluginRoute(path)` 注册：中间件据此（1）豁免内容路径废弃检查（路由优先级：系统固定 > 系统路由表 > 插件路由表）；（2）禁止插件路径进入边缘缓存（插件自带鉴权，缓存会绕过）
- `pluginAdminPaths` / `pluginRoutes` Set 是模块级状态，插件停用后同一 isolate 内不自动清退

### 6.4 插件专属管理页面

插件可以在后台渲染完整的单页界面，通过 `admin:page` filter hook 和 `[slug].astro` 路由实现：

```
src/pages/admin/plugin/[slug].astro  — 通用插件页面容器
  → applyFilterSafely('admin:page', '', { slug, csrfToken, ... })
  → 插件注册 admin:page hook，匹配 slug 后返回 HTML
  → HTML 通过 set:html 注入（插件负责自行转义用户数据）
```

WebDAV 插件的文件管理器是完整参考实现：`admin:page` 返回包含 CRUD UI 的 HTML + 内联 JS，`admin:footer` 注入导航菜单项。

**关键规则**：
- `[slug].astro` 使用 `applyFilterSafely`（不是 `applyFilter`），单个插件异常不会导致整页 500
- 插件通过 `admin:footer` hook 向导航栏注入菜单入口（JSON 注入 + JS DOM 操作）
- 插件返回的 HTML 中所有用户数据必须转义（参考 WebDAV 中的 `E()` 辅助函数）

### 6.5 插件包约定

- npm 包的 `package.json` 的 `keywords` 必须同时包含 `"typecho"` 和 `"plugin"`
- 由 `src/integrations/plugin-loader.ts` 在构建时发现并注入
- 本地插件放在 `src/plugins/<name>/`，需在根 `package.json` 添加 file 依赖
- 入口优先发现 `index.ts`，其次 `index.js` / `index.mjs` / `plugin.ts` / `plugin.js`

### 6.6 Hook 触发点

插件只应依赖下列已在运行时接入的 canonical Hook。`HookPoints` 中未列出的常量无调用保证；旧名称通过 `DeprecatedHookPointAliases` 兼容归一化。

**call**：
`request:begin`, `request:end`, `admin:begin`, `admin:end`, `archive:init`, `archive:beforeRender`, `archive:afterRender`, `archive:index`, `archive:single`, `archive:category`, `archive:tag`, `archive:author`, `archive:search`, `post:afterPublish`, `post:afterSave`, `post:beforeDelete`, `post:afterDelete`, `page:afterPublish`, `page:afterSave`, `page:beforeDelete`, `page:afterDelete`, `comment:afterCreate`, `feedback:trackback:after`, `feedback:pingback:after`, `comment:reply`, `comment:action`, `user:login:success`, `user:login:failure`, `user:logout`, `user:register:after`, `upload:after`, `upload:delete`

**filter**：
`request:route`, `admin:head`, `admin:footer`, `admin:nav`, `admin:login:head`, `admin:login:form`, `admin:page`, `admin:writePost:option`, `admin:writePost:advanceOption`, `admin:writePost:bottom`, `admin:writePage:option`, `admin:writePage:advanceOption`, `admin:writePage:bottom`, `admin:managePosts:titleActions`, `admin:profile:bottom`, `plugin:config:beforeSave`, `archive:query`, `frontend:head`, `frontend:footer`, `content:data`, `content:title`, `content:excerpt`, `content:markdown`, `content:rendered`, `comment:data`, `comment:markdown`, `comment:rendered`, `post:write`, `page:write`, `comment:beforeSave`, `feedback:trackback:before`, `feedback:pingback:before`, `user:login:before`, `user:register:before`, `upload:before`, `feed:item`, `feed:render`, `sidebar:data`, `csp:directives`

**动态插件动作 filter**：
`plugin:<id>:action:authorize`, `plugin:<id>:action`

完整参数和安全约束以 `src/plugins/README.md` 为准。

### 6.7 新增 Hook 点步骤

1. 在 `src/lib/plugin.ts` 的 `HookPoints` 中添加常量，命名格式 `component:hookName`
2. 在触发位置调用 `doHook()` 或 `applyFilter()`
3. 更新 `src/plugins/README.md` 与 `src/plugins/README.en.md` 的 Hook 表格

---

## 7. 主题系统

### 7.1 主题包约定

- npm 包的 `keywords` 必须同时包含 `"typecho"` 和 `"theme"`
- 由 `src/integrations/theme-loader.ts` 在构建时发现
- 构建时自动复制资源到 `public/themes/{id}/`
- 生成虚拟模块 `virtual:theme-templates`（静态 import 所有主题组件）
- 激活主题 ID 存储在 DB 的 `options.theme`

### 7.2 模板组件 Props

| 组件 | Props 接口 | 用途 |
|------|-----------|------|
| `Index.astro` | `ThemeIndexProps` | 首页文章列表 |
| `Post.astro` | `ThemePostProps` | 文章详情 |
| `Page.astro` | `ThemePageProps` | 独立页面 |
| `Archive.astro` | `ThemeArchiveProps` | 归档（分类/标签/作者/搜索） |
| `NotFound.astro` | `ThemeNotFoundProps` | 404 页面 |

无 `components/` 目录的纯 CSS 主题自动回退到默认主题组件。

### 7.3 样式注入

推荐主题组件使用系统 `Base.astro`；该布局会在 `<head>` 注入 `<link>` 标签（基于主题 manifest 的 `stylesheets` + `stylesheet`），并执行前台插件注入。自行输出完整 HTML 的主题必须自行处理样式和 `frontend:head` / `frontend:footer`。

### 7.4 主题自定义配置（可选）

- `theme.json`（或 `package.json` 的 `typecho.theme`）可声明 `config` 字段，字段 schema 与插件配置完全一致（见 9.4）
- **只有声明非空 `config` 的主题才显示「设置」入口**（`src/pages/admin/themes.astro` 卡片与 `/admin/theme-config?id=<themeId>` 设置页）
- 配置保存在 `typecho_options` 的 `theme:<themeId>` 行（JSON 字符串），保存时对清单字段做 allowlist，`password`/`hidden` 值在 API 中始终掩码、保存占位符时保留原值（`src/lib/theme-config.ts`，与插件共用 `src/lib/config.ts` 的解析/掩码/还原逻辑）
- 模板组件通过公共 Props `themeConfig`（`ThemeBaseProps`）读取当前激活主题配置，已合并 manifest 默认值；未声明时为空对象
- 主题无运行时入口，因此没有 `config:beforeSave` 类校验 hook；保存成功即刷新站点缓存

---

## 8. 认证系统

### 8.1 密码哈希

- 算法：PBKDF2-SHA256
- 迭代次数：100,000（Cloudflare Workers Web Crypto 生产环境硬上限；高于此值的存量 hash 无法在 Workers 上校验，登录时返回需重置）
- Salt 长度：16 字节
- 存储格式：`$PBKDF2$iterations$salt$hash`
- 位于 `src/lib/auth.ts`
- `passwordHashNeedsRehash(hash)` 检测低于当前迭代次数的存量 hash；`/api/users/login` 命中时机会式重哈希为 100k

### 8.2 Session Token

- 格式：`uid:sha256(secret+uid:authCode)`
- 存储于 Cookie：`__typecho_uid` 和 `__typecho_authCode`
- 每次请求由 `src/lib/context.ts` 的 `createContext()` 验证
- Cookie 的 `Secure` 标志由 `shouldUseSecureCookie(request)` 决定（HTTPS / `x-forwarded-proto: https` 时设为 true）
- 边缘缓存只对没有任一认证 Cookie 的请求生效（`hasAuthCookies` 闸门，避免登录态被缓存命中）

### 8.3 CSRF 保护

- `generateSecurityToken(secret, authCode, uid)` 生成 token，使用 1 小时滑动桶轮换；`validateSecurityToken` 同时接受当前与上一桶 token
- 评论 token 绑定 `cid`：`generateCommentToken(secret, cid)` / `validateCommentToken(token, secret, cid, refererFallback?)`（仍接受历史 referer 绑定 token，便于已缓存页面）
- 管理后台所有表单必须包含 CSRF token（`<input name="_">`）
- 管理 API 端点必须校验 CSRF token；优先级：
  1. `X-CSRF-Token` 请求头（AJAX/JSON 客户端推荐）
  2. POST `application/x-www-form-urlencoded` / `multipart/form-data` 中的 `_` 字段
  3. POST `application/json` body 的 `_` 字段
  4. URL 查询串 `?_=...`（仅兼容；状态变更类操作应避免）
- `requireAdminAction(request, group, { csrf: true })` 在 CSRF 校验之外还会强制 Origin/Referer 同源（`isSameOriginRequest`）；纯读 GET 端点可传 `csrf: false`，但绝不允许 GET 触发副作用
- `safeAdminRedirectUrl(referer, siteUrl, fallback)` 位于 `src/lib/admin-auth.ts`，安全构造管理后台重定向 URL；必须同时满足 `origin` 与 `siteUrl` 一致且路径为 `/admin` 或 `/admin/*`
- 评论来源检查和评论提交后的回跳只允许用 `URL.origin` 判定可信来源，禁止使用 `startsWith(siteUrl)` 或仅比较 `host`

### 8.4 登录限速

- `src/lib/login-rate-limit.ts` 提供 D1 持久化的按 IP 登录限流（`typecho_login_failures` 表），跨 isolate/PoP 共享计数
- 由 `options.loginFailBan*` 配置（管理后台「登录设置」可调）：
  - `loginFailBanEnabled`（默认 1）
  - `loginFailBanWindowSeconds`（默认 300）
  - `loginFailBanMaxFailures`（默认 5）
  - `loginFailBanSeconds`（默认 900）
- 上传端点 `src/pages/api/admin/upload.ts` 复用 `trackSlidingWindow` 工具做按用户滑动窗口限流（内存级，仅本 isolate）

### 8.5 安全响应头

中间件 (`src/middleware.ts`) 通过 `applySecurityHeaders()` 在每次中间件托管响应中自动添加以下安全响应头，除非路由处理程序已设置同名 Header；包括普通路由、插件 `request:route` 响应、缓存命中响应、安装/静态资源早返回路径：

| Header | Value |
|--------|-------|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`（仅 HTTPS） |
| `Content-Security-Policy` | 宽型默认（允许 `'self'` + 内联样式 / 脚本 + Gravatar 图片 + R2/usr/uploads） |
| `Permissions-Policy` | 默认禁用 camera/microphone/geolocation/payment/usb |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin`（包括上传响应，禁止第三方站点直接嵌入） |

`csp:directives` filter hook 允许插件追加/调整 CSP directives；插件应只附加来源，不要清空默认 directive。

### 8.6 安装窗口

- 生产部署应先配置 `INSTALL_TOKEN`（`wrangler secret put INSTALL_TOKEN`；本地可用 `.dev.vars`），再访问 `/install`
- 已配置时，安装表单必须提交 `<input name="installToken">`，服务端用 `timeSafeEqual` 校验
- 未配置时仍允许安装（首位提交者成为管理员），安装页会显示未保护警告

---

## 9. 设计约定

### 9.1 API 端点

- 公开接口 → `src/pages/api/<name>.ts`
- 管理接口 → `src/pages/api/admin/<name>.ts`（必须经过 `requireAdminAction(request, group)`，默认开启 CSRF + Origin 同源校验）
- 文件格式：`.ts`，直接 `export const POST/PUT/DELETE = ...`，返回 `Response`
- 路由由 Astro 文件系统路由自动生成
- `src/pages/api/admin/meta.ts` 只能写入 `category` / `tag` 两类元数据，禁止接受任意 `type`；删除分类前必须拒绝默认分类与有文章关联的分类
- `src/pages/api/admin/content.ts` 保存文章/页面时必须确保 `contents.slug` 唯一；更新为冲突 slug 时追加当前 `cid` 后缀，不允许把唯一索引错误暴露成 500
- `src/pages/api/install.ts` 的 install handler 必须用 `.returning()` 拿真实自增主键，不准硬编码 `cid:1` / `mid:1`；slug 冲突要走 `resolveSlug` 后缀策略
- 副作用类管理操作禁止响应 GET（`delete-spam` 等），统一走 POST + CSRF
- 公共归档（首页/分类/标签/作者/搜索）必须过滤 `created > now()` 的将来贴
- 评论 / 注册 / 登录 等公共 POST 必须做 Origin 同源校验（参考 `isSameOriginRequest`）
- 搜索优先走 FTS5 trigram（`src/lib/fulltext.ts`，仅当每个空白分隔词都 ≥ `FTS_MIN_CHARS` 且 FTS 就绪时启用，MATCH 按词 AND 匹配）；其余情况回退 LIKE 并套 `[2,50]` 字符护栏，长度不在范围内时短路 `1=0`
- Feed 路由的条数受 `options.feedItems` 控制并 clamp 到 `[5,50]`；description 始终走 excerpt，content:encoded 仅在 `feedFullText` 开启时才输出

### 9.2 管理后台页面

1. `src/pages/admin/<name>.astro` 创建页面，使用 `Admin.astro` 布局
2. 如需配套 API，在 `src/pages/api/admin/` 创建同名 `.ts`

### 9.3 模块级状态

Cloudflare Workers 是单线程单 isolate，以下模块级变量是安全的：
- `src/lib/plugin.ts`：`pluginRegistry` 与 loader 在启动时登记；`hookRegistry` 在插件首次激活时幂等写入，初始化完成后只读；`initialisingPlugins` 合并并发初始化
- `src/lib/cache.ts`：`cacheVersion` memo（60s）+ options 版本戳缓存（Cache API）
- `src/lib/options.ts`：`optionSnapshots` / `pendingOptionLoads`（WeakMap，5 分钟快照 + 并发合并）
- `src/lib/sidebar.ts`：`navSnapshots` 等版本化快照（WeakMap）
- `src/lib/comment-page.ts`：`commentRootCounts`（按 cacheVersion 键控的根评论计数缓存，TTL + 条数上限）
- `src/lib/fulltext.ts`：`ftsAvailability`（FTS5 就绪状态）
- `src/lib/isolate-boot.ts`：`state`（表检查 / 索引回填 / FTS 引导的一次性标志）
- `src/lib/login-rate-limit.ts`：登录限流（D1 持久化） + 上传限流（`trackSlidingWindow`，内存级滑动窗口）

### 9.4 配置表单类型（插件 / 主题共用）

`package.json` 的 `typecho.plugin.config` 与 `theme.json` 的 `config` 字段支持以下类型：
`text`, `textarea`, `select`, `radio`, `checkbox`, `password`, `hidden`, `repeatable`

**扩展属性**：
- `showWhen` — 条件显示，仅适用于 `repeatable.itemFields`。格式：`{ field: "provider", value: "s3" }`，`value` 可为单值或数组
- `optionsSource` — 动态选项源，仅适用于 `select`。当前支持 `"r2Bindings"`（自动读取 wrangler.toml 中的 R2 binding 名称）
- `itemFields` — 嵌套字段定义，仅适用于 `repeatable`

**boolean 型 select**：当选项值为 `"true"` / `"false"` 时，系统通过 `parseBoolean` 辅助函数转换为实际 boolean 存储。在 `plugin:config:beforeSave` hook 中需显式返回该字段（boolean 值），否则会被过滤丢失。

声明 `config` 后，管理插件列表自动显示「设置」链接；主题则在「外观」卡片显示「设置」链接。

---

## 10. 测试规范

### 10.1 框架与运行环境

- Vitest 在 Node.js 环境运行
- `tests/__mocks__/cloudflare-workers.ts` 提供 `cloudflare:workers` 模块 stub
- 集成测试通过 `@libsql/client` 创建内存 SQLite 数据库

### 10.2 目录结构

- 单元测试 → `tests/unit/<name>.test.ts`
- API 集成测试 → `tests/integration/<name>.test.ts`
- 插件测试 → `src/plugins/<name>/index.test.ts`（与入口同目录）

### 10.3 集成测试 mock 模式

```typescript
import { createTestDb, type TestDatabase } from '../helpers';
let testDb: TestDatabase;
vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
// 若需 mock cloudflare:workers 变量，必须用 vi.hoisted()
const { mockFn } = vi.hoisted(() => ({ mockFn: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: { DB: null, BUCKET: { delete: mockFn } }, ... }));
```

### 10.4 测试要求

- 新增功能和 bug 修复必须同步添加对应测试用例
- 修改后必须运行 `pnpm run test` 与 `pnpm run typecheck`
- 若集成测试为了隔离端点 mock 了 `requireAdminCSRF`，必须另有单元/集成测试覆盖真实 `requireAdminAction()` / CSRF 失败路径
- 安全修复必须包含负向回归用例（例如跨 origin、协议不一致、前缀匹配伪造、非法 enum/type、路径穿越）
- 每个插件必须包含 `index.test.ts`，覆盖：Hook 注册、守卫分支、正常路径、拒绝路径、边界情况、配置验证

---

## 11. 参考示例

| 示例 | 路径 | 说明 |
|------|------|------|
| 参考插件（基础） | `src/plugins/typecho-plugin-antispam/` | 含完整 package.json、index.ts、index.test.ts，基础 filter hook 示例 |
| 参考插件（高级） | `src/plugins/typecho-plugin-webdav/` | 含 `plugin:config:beforeSave` 校验、`request:route` 自定义路由、`admin:page` 管理页面、`admin:footer` 菜单注入、`WebDavStorageAdapter` 适配器模式、内联 JS 文件管理器 |
| 参考插件（CSP 注入） | `src/plugins/typecho-plugin-turnstile/` | 含 `csp:directives` filter hook 动态追加 CSP 来源、`admin:login:head`/`admin:login:form` 注入 Turnstile Widget |
| 参考主题 | `src/themes/typecho-theme-minimal/` | 含完整 theme.json、5 个模板组件 |

---

## 12. 关键文件索引

```
AGENTS.md                            # 跨客户端 Agent 规格（本文件）
.agents/
└── skills/                          # 跨客户端 Agent Skills（SKILL.md）
src/
├── middleware.ts                    # 请求入口
├── db/
│   ├── index.ts                     # Drizzle DB 工厂
│   └── schema.ts                    # 9 张表定义
├── lib/
│   ├── config.ts                   # 插件/主题共用配置字段机制（解析、默认值、掩码、allowlist）
│   ├── plugin.ts                    # 插件系统核心（Hook 总线）
│   ├── theme.ts                     # 主题系统
│   ├── theme-config.ts              # 主题配置视图 + 保存流程
│   ├── context.ts                   # 请求上下文（复用中间件 bootstrap）
│   ├── client-ip.ts                 # 统一客户端 IP 提取
│   ├── content-visibility.ts        # 公共内容可见性规则
│   ├── permalink-pattern.ts         # 固定链接渲染/匹配统一语法
│   ├── pagination.ts                # 归档/评论 keyset 分页与总数
│   ├── auth.ts                      # 密码哈希 + Session + CSRF
│   ├── admin-auth.ts                # 管理后台认证中间件 + 安全重定向
│   ├── options.ts                   # 站点配置 CRUD
│   ├── options-snapshot-generation.ts # options 快照代数失效
│   ├── cache.ts                     # 选项缓存（Cache API + cacheVersion 版本戳）
│   ├── fulltext.ts                  # FTS5 全文搜索（运行时索引 DDL + MATCH 表达式）
│   ├── schema-sql.ts                # 建表 SQL 反射生成
│   ├── sidebar.ts                   # 侧边栏/导航数据加载
│   ├── comment-page.ts              # 评论分页 + 根计数缓存
│   ├── request-bootstrap.ts         # 请求引导 + 边缘缓存写入（finalizeRequestResponse）
│   ├── theme-props.ts               # 主题 Props 类型定义
│   ├── security-headers.ts          # 安全响应头（CSP、HSTS、X-Frame 等）+ csp:directives filter
│   ├── markdown.ts                  # Markdown 渲染 + HTML 净化
│   ├── http.ts                      # 标准化 HTTP 响应（textError / jsonError / jsonOk）
│   ├── constants.ts                 # 跨模块常量（密码、限速、缓存 TTL）
│   ├── queue-observability.ts       # Queue 只读指标与账户级配置观测
│   └── url.ts                       # URL 规范化与校验
├── integrations/
│   ├── plugin-loader.ts             # 构建时插件发现
│   └── theme-loader.ts              # 构建时主题发现
├── pages/
│   ├── contents/                  # 内容统一渲染入口 contents/[cid].astro（文章/页面/草稿，permalink 重写目标）
│   ├── admin/                       # 管理后台页面
│   │   ├── themes.astro             # 外观（主题列表/切换/设置入口）
│   │   ├── theme-config.astro       # 主题自定义配置表单页
│   │   ├── manage-queues.astro      # 任务 Queue 只读观测
│   │   └── plugin/
│   │       └── [slug].astro         # 插件专属管理页面容器（admin:page hook 注入点）
│   └── api/
│       ├── comment.ts               # 前台评论 API
│       └── admin/                   # 管理 API 端点（含 theme-config.ts 主题配置读写）
├── plugins/                         # 内置插件（工作区包）
│   ├── README.md                    # 插件开发完整规范
│   ├── typecho-plugin-antispam/     # 反垃圾评论（参考基础插件）
│   ├── typecho-plugin-webdav/       # WebDAV 协议 + 文件管理器（参考高级插件）
│   ├── typecho-plugin-turnstile/    # Cloudflare Turnstile 人机验证
│   ├── typecho-plugin-scribe/       # AI 写作辅助
│   └── typecho-plugin-wechat-publisher/ # 微信公众号发布
└── themes/                          # 内置主题（工作区包）
    └── README.md                    # 主题开发完整规范
tests/
├── setup.ts                         # 全局测试 setup
├── helpers.ts                       # 测试工具函数 (createTestDb, seedAdmin, makeAuthCookie)
├── __mocks__/cloudflare-workers.ts  # cloudflare:workers stub + caches mock
├── unit/                            # 单元测试
└── integration/                     # 集成测试
scripts/
├── migrate.ts                       # PHP Typecho 数据迁移
└── reset-password.ts                # 密码重置工具
```

---

## 13. 定时与异步任务系统

本节是实现和后续插件开发必须遵守的任务系统规范；若需改变架构边界，先更新本节并完成评审。

### 13.1 固定架构

- 使用自定义 `src/worker.ts` 导出 `fetch`、`scheduled`、`queue`；HTTP 交给 Astro Cloudflare handler。
- Cloudflare Cron 固定每分钟触发一次（`* * * * *`），只负责按当前 UTC instant 和站点 IANA timezone 找出当前 local slot，并向 Queue 投递。
- Cloudflare Queue 是异步传输、批处理和重试边界；当前部署不配置 DLQ，达到 `max_retries` 后仍失败的消息由 Cloudflare 丢弃。Queue consumer 的 `max_concurrency = 1` 只限制外层 consumer，不代表所有任务串行。
- 核心 dispatcher 允许不同 `{pluginId}:{taskId}` 并发；同一 task 的并发由插件声明的 `concurrency` 控制，并受核心 `globalMaxInFlight` 安全上限约束。
- 第一阶段不新增任务专用 D1 表，不用 D1 保存任务 cursor、历史、队列状态或通用幂等记录；已有 D1 仍用于站点配置、插件激活状态和插件配置。
- Queue 是至少一次投递；不承诺精确一次、跨 PoP 强全局互斥或错过 Cron 槽位的可靠补偿。插件必须保证任务幂等。
- `typecho-cf-tasks` 是当前唯一的账户级 Cloudflare Queue 资源；本地/手动执行 `pnpm run deploy` 必须先执行 `scripts/deploy.mjs` 的幂等资源检查，按所选 Wrangler 配置调用项目锁定版本的 `wrangler queues list/create`，缺失时创建、已存在时复用，禁止删除或重建。Deploy Button / Workers Builds 已在构建前按 Wrangler 配置自动准备资源，且已单独执行 Build command；当 `WORKERS_CI=1` 时，`pnpm run deploy` 必须跳过 Queue 检查与重复构建，仅执行 `wrangler deploy`。
- 从旧版双 Queue 部署升级时，普通部署不得自动删除 `typecho-cf-tasks-dlq`；确认旧 Queue 不再需要后，必须显式执行 `pnpm run queues:cleanup-legacy -- --confirm typecho-cf-tasks-dlq`，该命令只允许删除固定的旧名称，并先检查当前 Wrangler 配置未引用它。Button / Workers Builds 不执行该清理。
- Workers Builds 的非生产分支必须使用 `wrangler versions upload`（项目命令可写为 `pnpm exec wrangler versions upload`），不得复用会执行生产 `wrangler deploy` 的手动部署路径。
- `pnpm run deploy -- --dry-run` 不得创建 Queue；Queue 资源创建失败必须终止部署，不能用 `|| true` 吞掉权限、认证或网络错误。

### 13.2 插件接口约束

- 定时任务和请求态异步任务必须使用不同接口：`registerScheduledTask()`、`registerAsyncTask()`、`enqueueAsyncTask()`。
- 任务必须先注册再执行；普通请求不能通过参数选择任意插件任务或绕过插件激活状态。
- 每条消息使用版本化 `TaskEnvelope`，包含稳定 `jobId`、`taskKey`、`idempotencyKey`、来源和时间信息；投递侧、消费侧都要校验。
- 插件 handler 必须处理重复投递，使用业务唯一键、provider 幂等键或天然幂等操作；核心不隐式引入 D1 去重表。
- 插件可以返回 `success`、`retry` 或 `discard`；异常和超时默认可重试，但受 Queue `max_retries` 约束；当前部署没有 DLQ，耗尽重试后消息会被丢弃。
- payload 必须可 JSON 序列化并受大小、字段和 schema 校验；不得携带密码、Cookie、CSRF token、访问令牌或完整请求头。
- Scheduler 使用 Queue `sendBatch` 时必须同时遵守最多 100 条与整批 256,000 bytes 上限，按先达到的条件切批；`delaySeconds` 必须在 0 到 86,400 秒之间。
- 长耗时、多步骤、需要持久化恢复的流程不应塞入 Queue 单条消息；按设计规范升级为拆分任务、Durable Object 或 Workflow。

### 13.3 时间、生命周期与可靠性

- Cron 的 `controller.scheduledTime` 是 UTC instant；本地时间必须从现有 `options.timezone` 的 IANA 标识运行时计算，不能使用固定 offset。
- 默认定时 `taskKey` 按 `{pluginId}:{taskId}:{localSlot}:{scheduledAt}` 生成，其中 `scheduledAt` 是真实 UTC instant；夏令时回拨的两个真实 instant 会分别投递，不承诺跨 isolate 合并，插件仍必须自行保证幂等。
- 插件 loader 在构建时登记，任务注册在激活插件 `init()` 中完成；HTTP、scheduled、queue 冷启动都必须先加载 registry，再以当前激活插件集合为准。
- 插件 `init()` 失败时，已完成的任务注册必须回滚；后续初始化重试不得因上一次失败留下的任务定义而产生重复注册冲突。
- 插件停用后，即使当前 isolate 仍保留旧注册表条目，queue dispatch 也必须跳过其副作用。
- 任务专用模块放在 `src/lib/tasks/`，不要继续膨胀 `src/lib/plugin.ts`；公共类型通过 `src/lib/plugin-sdk.ts` 导出。

### 13.4 队列观测后台

- 管理员通过 `/admin/manage-queues` 查看任务 Queue；该页面只读，不提供消息拉取、租约、删除、重放或暂停操作。
- 页面不新增任务专用 D1 表，也不承诺提供单条任务的运行中/已完成历史；只展示 Queue 的近实时积压指标、账户级资源配置和 consumer 配置。
- 主 Queue 使用 Worker `QUEUE.metrics()`，不需要 API 凭据；账户级配置仅在配置 `CF_ACCOUNT_ID` 与 `CF_API_TOKEN` 后通过 Cloudflare Queue API 读取。API Token 必须是只读权限，凭据只能通过 Worker secret / 本地 `.dev.vars` 提供，不得写入页面、日志或任务 payload。
- `QUEUE_NAME` 必须和 Wrangler producer/consumer 的 Queue 名称保持一致；多实例部署修改 Queue 名称时必须同步修改该变量。
- 观测请求必须设置超时、限制响应体和分页范围，并在 API 失败时降级为不可用状态，不得把上游错误详情或凭据返回给管理员页面。

### 13.5 协作与验证约定

- 任务系统属于架构级变更；实施前先更新设计规范和实施计划，文档评审通过后再写代码。
- 可并行的工作必须按不重叠文件集合拆分；`plugin.ts`、`plugin-sdk.ts`、`wrangler.toml`、`src/worker.ts` 等共享边界由主协作者或单一子任务负责集成，避免并发冲突。
- 新增模块必须配套单元/集成测试；至少覆盖 Cron 解析与时区、envelope 校验、ack/retry/discard、插件停用、任务级并发和 Worker 冷启动注册表。
- 修改完成后运行 `pnpm run test`、`pnpm run typecheck`，涉及构建入口或 Wrangler 配置时再运行 `pnpm run build`，并执行 `git diff --check`。
