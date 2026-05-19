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

---

## 2. 技术栈

| 层 | 技术 | 版本约束 |
|----|------|---------|
| 框架 | Astro (SSR mode) | 6.x |
| 适配器 | @astrojs/cloudflare | 13.x |
| 运行时 | Cloudflare Workers | — |
| 数据库 | Cloudflare D1 (SQLite) | — |
| ORM | Drizzle ORM | 0.45.x |
| 文件存储 | Cloudflare R2 | — |
| 密码哈希 | PBKDF2-SHA256 | 600,000 迭代 + 16B salt（旧 100k hash 自动重哈希） |
| 测试 | Vitest | 4.x |
| 语言 | TypeScript | 6.x |

---

## 3. 架构

### 3.1 请求生命周期

```
请求 → src/middleware.ts
        ├─ 安装检测（typecho_options 表不存在 → /install）
        ├─ 分页 URL 重写（/page/N/ → 基础路径 + locals._page）
        ├─ 加载 options + 激活插件
        ├─ route:request filter（插件自定义路由）
        ├─ 边缘缓存（Cache API，跳过已登录/admin/api 路径）
        └─ 固定链接重写（post/page/category pattern → 内置路由）
     → src/lib/context.ts
        ├─ 初始化 DB 连接
        ├─ 加载 options + computeUrls
        ├─ 自动激活插件（首次安装/升级时）
        ├─ 验证 Cookie（__typecho_uid / __typecho_authCode）
        ├─ 生成 CSRF token
        └─ 触发 system:begin hook
     → 路由匹配（.astro 页面 或 .ts API 端点）
     → 布局渲染（Base.astro → Blog.astro 或 Admin.astro）
```

### 3.2 模块依赖图

```
src/middleware.ts       — 请求入口，安装检测，缓存，URL 重写
  ├─ src/lib/plugin.ts  — 插件注册表 + Hook 事件总线（核心）
  ├─ src/lib/options.ts — 站点配置 CRUD + computeUrls
  ├─ src/lib/cache.ts   — 选项查询缓存（module-scope Map）
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
  └─ HookPoints 常量 — 50+ 挂载点定义

src/lib/theme.ts        — 主题系统
src/integrations/theme-loader.ts   — 构建时发现主题包 → 虚拟模块
src/integrations/plugin-loader.ts  — 构建时发现插件包 → 注入注册表
src/lib/schema-sql.ts   — 运行时从 Drizzle schema 反射生成建表 SQL
```

---

## 4. 数据库

### 4.1 表结构（7 张表，与 PHP Typecho 兼容）

| 表名 | 用途 | 主键 |
|------|------|------|
| `typecho_users` | 用户（5 种角色） | uid (autoinc) |
| `typecho_contents` | 内容（文章/页面/草稿/附件） | cid (autoinc) |
| `typecho_comments` | 评论 | coid (autoinc) |
| `typecho_metas` | 元数据（分类/标签） | mid (autoinc) |
| `typecho_relationships` | 内容-元数据关联 | (cid, mid) |
| `typecho_options` | 站点配置（KV 结构） | (name, user) |
| `typecho_fields` | 扩展字段 | (cid, name) |

**不可变约束**：
- 表名必须保持 `typecho_*` 前缀，**不可重命名**
- 列名必须与 PHP Typecho 保持一致
- Schema 定义在 `src/db/schema.ts`，修改后必须运行 `pnpm run db:generate`
- **禁止手动修改 `drizzle/` 目录下的迁移文件**
- 建表 SQL 由 `src/lib/schema-sql.ts` 在运行时从 Drizzle schema 反射生成（`generateCreateSQL()` 同时输出 CREATE TABLE 与 CREATE INDEX；中间件首次命中时会在后台幂等地补齐生产库索引）
- D1 不支持真实事务（旧的 `db-transaction.ts` 已废弃）；批量改写应使用 `db.batch([...])` 单次往返
- 评论的「能否审核」必须查 `contents.authorId`，禁止以 `comments.ownerId` 作为权限判定来源（ownerId 仅是历史快照，G7-4）

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

---

## 5. Cloudflare 绑定

| Binding | 类型 | 用途 |
|---------|------|------|
| `DB` | D1 | 数据库 `typecho-cf-db` |
| `BUCKET` | R2 | 文件存储 `typecho-cf-uploads` |

### 5.1 环境变量访问

```typescript
// ✅ 唯一正确方式
import { env } from 'cloudflare:workers';
const db = env.DB;
const bucket = env.BUCKET;

// ❌ 已废弃（Astro 6 + @astrojs/cloudflare v13+ 不支持）
// Astro.locals.runtime.env.DB
```

### 5.2 客户端 IP 获取

```typescript
// ✅ 统一使用
import { getClientIp } from '@/lib/context';
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

- 插件 `init()` **不在 build 时直接执行**；`plugin-loader.ts` 改为调用 `registerPluginInit(pluginId, init)` 把初始化函数登记到表中
- 真正的 `init({ addHook, pluginId })` 由 `setActivatedPlugins(activatedIds)` 在第一次激活时按需触发，未激活的插件不会注入任何 hook（G6）
- 插件不要在模块顶层做副作用（数据库读写、外部请求、`addHook` 写入），所有注册逻辑必须放在导出的 `init()` 内

### 6.3 插件包约定

- npm 包的 `package.json` 的 `keywords` 必须同时包含 `"typecho"` 和 `"plugin"`
- 由 `src/integrations/plugin-loader.ts` 在构建时发现并注入
- 本地插件放在 `src/plugins/<name>/`，需在根 `package.json` 添加 file 依赖
- 入口优先发现 `index.ts`，其次 `index.js` / `index.mjs` / `plugin.ts` / `plugin.js`

### 6.4 完整 Hook 点（50+）

**call 类型**：
`system:begin`, `system:end`, `admin:header`, `admin:footer`, `admin:navBar`, `admin:begin`, `admin:end`, `admin:writePost:option`, `admin:writePost:advanceOption`, `admin:writePost:bottom`, `admin:writePage:option`, `admin:writePage:advanceOption`, `admin:writePage:bottom`, `admin:profile:bottom`, `post:finishPublish`, `post:finishSave`, `post:delete`, `post:finishDelete`, `page:finishPublish`, `page:finishSave`, `page:delete`, `page:finishDelete`, `feedback:finishComment`, `feedback:reply`, `comment:action`, `user:login`, `user:loginSucceed`, `user:loginFail`, `user:logout`, `user:finishRegister`, `upload:beforeUpload`, `upload:upload`, `upload:delete`

**filter 类型**：
`route:request`, `admin:loginHead`, `admin:loginForm`, `archive:select`, `archive:header`, `archive:footer`, `archive:indexHandle`, `archive:singleHandle`, `archive:categoryHandle`, `archive:tagHandle`, `archive:searchHandle`, `archive:handleInit`, `archive:beforeRender`, `archive:afterRender`, `content:filter`, `content:title`, `content:excerpt`, `content:markdown`, `content:content`, `comment:filter`, `comment:content`, `comment:markdown`, `post:write`, `page:write`, `feedback:comment`, `feed:item`, `feed:generate`, `widget:sidebar`, `user:register`, `plugin:config:beforeSave`, `csp:directives`

### 6.5 新增 Hook 点步骤

1. 在 `src/lib/plugin.ts` 的 `HookPoints` 中添加常量，命名格式 `component:hookName`
2. 在触发位置调用 `doHook()` 或 `applyFilter()`
3. 更新 `src/pages/admin/plugins.astro` 的 Hook 参考
4. 更新 `src/plugins/README.md` 的 Hook 表格

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

系统自动在 `<head>` 注入 `<link>` 标签（基于 `theme.json` 的 `stylesheets` + `stylesheet`），主题组件不需要自行引入样式。

---

## 8. 认证系统

### 8.1 密码哈希

- 算法：PBKDF2-SHA256
- 迭代次数：600,000（G1，2024 年 OWASP 建议）
- Salt 长度：16 字节
- 存储格式：`$PBKDF2$iterations$salt$hash`
- 位于 `src/lib/auth.ts`
- `passwordHashNeedsRehash(hash)` 检测旧 100k hash；`/api/users/login` 命中时机会式重哈希为 600k

### 8.2 Session Token

- 格式：`uid:sha256(secret+uid:authCode)`
- 存储于 Cookie：`__typecho_uid` 和 `__typecho_authCode`
- 每次请求由 `src/lib/context.ts` 的 `createContext()` 验证
- Cookie 的 `Secure` 标志由 `shouldUseSecureCookie(request)` 决定（HTTPS / `x-forwarded-proto: https` 时设为 true）
- 边缘缓存只对没有任一认证 Cookie 的请求生效（`hasAuthCookies` 闸门，避免登录态被缓存命中）

### 8.3 CSRF 保护

- `generateSecurityToken(secret, authCode, uid)` 生成 token，使用 1 小时滑动桶轮换；`validateSecurityToken` 同时接受当前与上一桶 token
- 评论 token 已绑定 `cid`：`generateCommentToken(secret, cid)` / `validateCommentToken(token, secret, cid, refererFallback?)`；旧的 referer 绑定路径仍兼容（用于已缓存页面）
- 管理后台所有表单必须包含 CSRF token（`<input name="_">`）
- 管理 API 端点必须校验 CSRF token；优先级：
  1. `X-CSRF-Token` 请求头（G8-3，AJAX/JSON 客户端推荐）
  2. POST `application/x-www-form-urlencoded` / `multipart/form-data` 中的 `_` 字段
  3. POST `application/json` body 的 `_` 字段
  4. URL 查询串 `?_=...`（保留兼容旧调用，状态变更类操作应避免）
- `requireAdminAction(request, group, { csrf: true })` 在 CSRF 校验之外还会强制 Origin/Referer 同源（`isSameOriginRequest`）；纯读 GET 端点可传 `csrf: false`，但绝不允许 GET 触发副作用
- `safeAdminRedirectUrl(referer, siteUrl, fallback)` 位于 `src/lib/admin-auth.ts`，安全构造管理后台重定向 URL；必须同时满足 `origin` 与 `siteUrl` 一致且路径为 `/admin` 或 `/admin/*`，防止 Open Redirect 与后台动作跳转到前台任意路径
- 评论来源检查和评论提交后的回跳只允许用 `URL.origin` 判定可信来源，禁止使用 `startsWith(siteUrl)` 或仅比较 `host`

### 8.4 登录限速

- `src/lib/login-rate-limit.ts` 提供按 IP 的滑动窗口限流（仅在单 isolate 内存里，跨 isolate 不持久）
- 由 `options.loginFailBan*` 配置（管理后台「登录设置」可调）：
  - `loginFailBanEnabled`（默认 1）
  - `loginFailBanWindowSeconds`（默认 300）
  - `loginFailBanMaxFailures`（默认 5）
  - `loginFailBanSeconds`（默认 900）
- 上传端点 `src/pages/api/admin/upload.ts` 复用同一份 `trackSlidingWindow` 工具

### 8.5 安全响应头

中间件 (`src/middleware.ts`) 通过 `applySecurityHeaders()` 在每次中间件托管响应中自动添加以下安全响应头，除非路由处理程序已设置同名 Header；包括普通路由、插件 `route:request` 响应、缓存命中响应、安装/静态资源早返回路径：

| Header | Value |
|--------|-------|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`（仅 HTTPS） |
| `Content-Security-Policy` | 宽型默认（允许 `'self'` + 内联样式 / 脚本 + Gravatar 图片 + R2/usr/uploads） |
| `Permissions-Policy` | 默认禁用 camera/microphone/geolocation/payment/usb |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin`（上传响应使用 `cross-origin` 预设） |

`csp:directives` filter hook 允许插件追加/调整 CSP directives；插件应只附加来源，不要清空默认 directive。

### 8.6 安装窗口

- `src/pages/api/install.ts` 的 install POST 在没有 `INSTALL_TOKEN` 密钥时输出 warning 并保留旧的「首位请求者获胜」语义（兼容现存部署）
- 强烈建议运行 `wrangler secret put INSTALL_TOKEN` 之后再发起首次安装，避免抢注
- 安装表单使用 `<input name="installToken">` 提交，服务端用 `timingSafeEqualString` 校验



---

## 9. 设计约定

### 9.1 API 端点

- 公开接口 → `src/pages/api/<name>.ts`
- 管理接口 → `src/pages/api/admin/<name>.ts`（必须经过 `requireAdminAction(request, group)`，默认开启 CSRF + Origin 同源校验）
- 文件格式：`.ts`，直接 `export const POST/PUT/DELETE = ...`，返回 `Response`
- 路由由 Astro 文件系统路由自动生成
- `src/pages/api/admin/meta.ts` 只能写入 `category` / `tag` 两类元数据，禁止接受任意 `type`；删除分类前必须拒绝默认分类与有文章关联的分类（G7-1）
- `src/pages/api/admin/content.ts` 保存文章/页面时必须确保 `contents.slug` 唯一；更新为冲突 slug 时追加当前 `cid` 后缀，不允许把唯一索引错误暴露成 500
- `src/pages/api/install.ts` 的 install handler 必须用 `.returning()` 拿真实自增主键，不准硬编码 `cid:1` / `mid:1`（G7-2）；slug 冲突要走 `resolveSlug` 后缀策略（G7-8）
- 副作用类管理操作禁止响应 GET（`delete-spam` 等），统一走 POST + CSRF
- 公共归档（首页/分类/标签/作者/搜索）必须过滤 `created > now()` 的将来贴（G7-5）
- 评论 / 注册 / 登录 等公共 POST 必须做 Origin 同源校验（参考 `isSameOriginRequest`）
- 搜索 LIKE 必须套 `[2,50]` 字符护栏：长度不在范围内时短路 `1=0`（G4-5）
- Feed 路由的条数受 `options.feedItems` 控制并 clamp 到 `[5,50]`（G7-7）；description 始终走 excerpt，content:encoded 仅在 `feedFullText` 开启时才输出（G7-6）

### 9.2 管理后台页面

1. `src/pages/admin/<name>.astro` 创建页面，使用 `Admin.astro` 布局
2. 如需配套 API，在 `src/pages/api/admin/` 创建同名 `.ts`

### 9.3 模块级状态

Cloudflare Workers 是单线程单 isolate，以下模块级变量是安全的：
- `src/lib/plugin.ts`：`pluginRegistry`、`hookRegistry`（构建时写入，运行时只读；`pendingPluginInits` 用于懒初始化）
- `src/lib/cache.ts`：options 查询缓存
- `src/lib/login-rate-limit.ts`：登录失败滑动窗口（仅本 isolate，跨 isolate 不持久）
- `src/middleware.ts`：`regexCache`、`tableCheckPassed`、`indexCheckPassed`

### 9.4 插件配置表单类型

`package.json` 的 `typecho.plugin.config` 字段支持以下类型：
`text`, `textarea`, `select`, `radio`, `checkbox`, `password`, `hidden`, `repeatable`

声明 `config` 后，管理插件列表自动显示「设置」链接。

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
- 修改后必须运行 `pnpm run test` 与 `pnpm exec tsc --noEmit`
- 若集成测试为了隔离端点 mock 了 `requireAdminCSRF`，必须另有单元/集成测试覆盖真实 `requireAdminAction()` / CSRF 失败路径
- 安全修复必须包含负向回归用例（例如跨 origin、协议不一致、前缀匹配伪造、非法 enum/type、路径穿越）
- 每个插件必须包含 `index.test.ts`，覆盖：Hook 注册、守卫分支、正常路径、拒绝路径、边界情况、配置验证

---

## 11. 参考示例

| 示例 | 路径 | 说明 |
|------|------|------|
| 参考插件 | `src/plugins/typecho-plugin-antispam/` | 含完整 package.json、index.ts、index.test.ts |
| 参考主题 | `src/themes/typecho-theme-minimal/` | 含完整 theme.json、5 个模板组件 |

---

## 12. 关键文件索引

```
src/
├── middleware.ts                    # 请求入口
├── db/
│   ├── index.ts                     # Drizzle DB 工厂
│   └── schema.ts                    # 7 张表定义
├── lib/
│   ├── plugin.ts                    # 插件系统核心（Hook 总线）
│   ├── theme.ts                     # 主题系统
│   ├── context.ts                   # 请求上下文 + getClientIp
│   ├── auth.ts                      # 密码哈希 + Session + CSRF
│   ├── admin-auth.ts                # 管理后台认证中间件 + 安全重定向
│   ├── options.ts                   # 站点配置 CRUD
│   ├── cache.ts                     # 选项缓存 + 边缘缓存清除
│   ├── schema-sql.ts                # 建表 SQL 反射生成
│   ├── sidebar.ts                   # 侧边栏/导航数据加载
│   ├── theme-props.ts               # 主题 Props 类型定义
│   ├── markdown.ts                  # Markdown 渲染 + HTML 净化
│   └── url.ts                       # URL 规范化与校验
├── integrations/
│   ├── plugin-loader.ts             # 构建时插件发现
│   └── theme-loader.ts              # 构建时主题发现
├── pages/
│   ├── [slug].astro                 # 文章/页面路由
│   ├── admin/                       # 管理后台页面
│   └── api/
│       ├── comment.ts               # 前台评论 API
│       └── admin/                   # 管理 API 端点
├── plugins/                         # 内置插件（工作区包）
│   └── README.md                    # 插件开发完整规范
└── themes/                          # 内置主题（工作区包）
    └── README.md                    # 主题开发完整规范
tests/
├── setup.ts                         # 全局测试 setup
├── helpers.ts                       # 测试工具函数 (createTestDb, seedAdmin, makeAuthCookie)
├── __mocks__/cloudflare-workers.ts  # cloudflare:workers stub + caches mock
├── unit/                            # 单元测试 (25 个文件)
└── integration/                     # 集成测试 (17 个文件)
scripts/
├── migrate.ts                       # PHP Typecho 数据迁移
└── reset-password.ts                # 密码重置工具
```
