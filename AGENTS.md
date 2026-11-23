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
| Node.js | 26.x LTS，`.node-version` 使用主版本 `26`；CI / Cloudflare Workers Builds 共用，升级 LTS 主版本时同步 `engines.node` 与 `@types/node` 主版本 |

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
| 测试 | Vitest | 5.x |
| 语言 | TypeScript | 6.x（保持与 ESLint / typescript-eslint 的官方支持范围一致；升级前确认上游 peer 范围） |

---

## 3. 架构

### 3.1 请求生命周期

```
请求 → src/middleware.ts
        ├─ 安装检测（typecho_options 表不存在 → /install）
        ├─ 分页 URL 重写（/page/N/ → 基础路径 + locals._page）
        ├─ 加载 options；认证请求 / 插件路由候选路径从 D1 first-primary 刷新插件启用态与配置
        ├─ 激活插件并同步其路由声明
        ├─ request:route filter（插件自定义路由）
        ├─ 边缘缓存（Cache API，跳过已登录/admin/api 路径）
        └─ 固定链接重写（post/page/category pattern → 内置路由）
     → src/lib/context.ts
        ├─ 初始化 DB 连接
        ├─ 复用 middleware 的 DB/options/激活插件；单独调用时从持久化启用集合初始化
        ├─ 计算 computeUrls
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
- Schema 定义在 `src/db/schema.ts`，修改后必须运行 `pnpm run ops db generate`；`drizzle/` 目录（迁移 SQL + meta 快照）已纳入版本控制，生成的迁移必须随 schema 变更一起提交
- `typecho_contents_slug_unique` 是 `slug IS NOT NULL AND type IS NOT 'revision'` 的部分唯一索引；revision 可复用父内容 slug。运行时升级先按 cid 升序保留每组最低 cid 的原 slug，再将后续重复项改为 `<slug>-<cid>`；若该值已占用则追加稳定数字后缀，绝不覆盖现存 slug
- **禁止手动修改 `drizzle/` 目录下的迁移文件**
- 建表 SQL 由 `src/lib/schema-sql.ts` 在运行时从 Drizzle schema 反射生成（`generateCreateSQL()` 同时输出 CREATE TABLE 与 CREATE INDEX；中间件首次命中时会在后台幂等地补齐生产库索引）
- FTS5 搜索索引（`typecho_contents_fts` 虚拟表 + 同步触发器）由运行时引导创建/回填（`src/lib/fulltext.ts`、`isolate-boot.ts`），属于派生索引，**不纳入 Drizzle schema 与迁移**；新库安装时由 `generateCreateSQL()` 一并创建
- D1 不提供应用层交互式 `BEGIN` / `COMMIT`；`db.batch([...])` 将一组 SQL 语句作为原子批次执行，任一语句失败会回滚整批。一个业务写入单元必须把互相依赖的表更新放进同一个 batch；外部副作用在 batch 成功后触发
- 评论的「能否审核」必须查 `contents.authorId`，禁止以 `comments.ownerId` 作为权限判定来源（ownerId 仅是内容作者变更前的历史快照）
- trackback / pingback 是 `typecho_comments` 中 `type='trackback'|'pingback'` 的行，与普通评论**共用** `status` 列与后台「评论」审核队列（`/admin/manage-comments`，按 status 分标签页，不按 type 过滤）；它们同样计入 `commentsNum`。这是与 PHP Typecho 对齐的有意设计，不要在审核页里按 type 拆分队列
- 入站反馈（trackback / pingback）必须先校验来源页面确实链回目标：**校验不通过一律 4xx 拒收且不写库**；校验通过后是否待审只由 `commentsRequireModeration` 决定（开启落 `waiting`，关闭落 `approved`），与普通评论共用同一个开关，不另设开关

### 4.2 关键枚举

```typescript
// contents.type
'post' | 'page' | 'post_draft' | 'page_draft' | 'attachment' | 'revision'

// contents.status
'publish' | 'draft' | 'hidden' | 'private' | 'waiting'

// comments.status
'approved' | 'waiting' | 'spam'

// users.group（数字越小权限越高）
'administrator'(0) | 'editor'(1) | 'contributor'(2) | 'subscriber'(3) | 'visitor'(4)
// 内容管理范围：administrator / editor 可管理全部内容，contributor 仅限自己创建的内容（`canManageResource`）
```

### 4.3 插件配置存储

- 存储在 `typecho_options` 表：`name = "plugin:<pluginId>"`，值为 JSON 字符串
- 通过 `loadPluginConfig(options, pluginId)` 读取（自动合并 manifest 默认值）
- 启用插件时自动写入默认配置；禁用插件时保留现有配置，重新启用可恢复原设置
- 插件专属配置项（含 API 凭据、显示名、开关等）一律通过 manifest `config` 保存在 `plugin:<id>`；不要新增 Worker 环境变量、secret 或 `wrangler.jsonc` 全局 `vars` 来承载插件配置。平台资源 binding（D1 / R2 / Queue）仍由部署配置提供
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
| `QUEUE` | Queue | 可选，供 Cloudflare 队列 provider 使用 |
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
export default function init({ addHook, pluginId, registerAdminPath }: PluginInitContext): void {
  // 注册插件的管理路径，使其不被中间件拦截
  registerAdminPath('/api/admin/webdav');

  addHook('request:route', pluginId, async (result, extra) => {
    if (extra.path === '/api/admin/webdav') { /* ... */ }
    return result;
  });
}
```

- 路径应在插件 `init()` 中注册，在任何 hook handler 之前；`registerAdminPath()` 会把路径绑定到当前 `pluginId`。注册会规范化尾部斜杠，并拒绝保留路径（`/install`、`/api/install`、`/admin`、`/api/admin`、`/admin/login`、`/admin/reset-password`、`/api/users/login|logout|register|reset-password`）及含 `?`、`#`、`\`、`.`、`..`、`//` 的非法拼写；被拒绝时只打印 warning，不建立 claim
- `isPluginAdminPath(path)` 在中间件 `isReservedCorePath` 中调用，白名单通过后放行
- 管理/API 路径与前台路由使用同一套 owner 生命周期：插件停用、初始化失败或注册表重置时，该 owner 的全部路径 claim 立即注销；插件只能注销自己的 claim
- 前台自定义路由（如 WebDAV 入口）必须在插件 `init()` 中通过 `PluginInitContext.registerRouteResolver(resolver)` 声明 owner-scoped 路由：resolver 根据当前配置返回该插件当前有效的路径 claim；插件停用、初始化失败或配置变化时，核心替换或注销该 owner 的旧 claim。中间件据此（1）豁免内容路径废弃检查；（2）禁止插件路径进入边缘缓存（插件自带鉴权，缓存会绕过）。路由优先级保持为：系统固定 > 系统路由表 > 插件路由表
- route resolver 只负责声明和生命周期管理，不负责处理请求；实际请求仍由 `request:route` hook 分发。核心必须在缓存决策和 `request:route` 分发前同步当前 claim；不同插件的冲突 claim 必须 fail-closed（相关 owner 均不可用），WebDAV 保留历史兼容路径 `/dav` 的匹配行为
- 插件路由声明按 owner 管理，插件只能替换或注销自己的 claim；插件停用后不得残留旧路径。旧的全局 `registerPluginAdminPath(path)` 已从 SDK 移除，管理/API 路径统一改用 `PluginInitContext.registerAdminPath(path)`
- **行为变更（相对早期实现）**：`request:route` 现在对保留核心路径（`/install`、`/api/install`、`/admin/**`、`/api/admin/**`、`/api/users/login|logout|register|reset-password`、`/admin/reset-password`）**提前短路，不再调用插件 hook**；早期实现是「先调用、命中保留路径再丢弃响应并打印 warn 日志」。因此依赖「先收到请求、再判断是否处理」的插件必须改为在 `init()` 中用 `registerAdminPath()` 声明管理/API 路径、用 `registerRouteResolver()` 声明前台路由，否则不会再收到这些请求

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
- 本地插件放在 `src/plugins/<name>/`，由 `pnpm-workspace.yaml` 的 `src/plugins/*` 纳入 workspace；在根 `package.json` 使用 `workspace:*` 依赖。本地主题同理使用 `src/themes/*` 与 `workspace:*`
- 入口优先发现 `index.ts`，其次 `index.js` / `index.mjs` / `plugin.ts` / `plugin.js`
- 依赖图只读取运行时 `dependencies`、`optionalDependencies` 和 `peerDependencies`（可选 peer 按可选依赖处理）；`devDependencies` 不参与生产插件发现。Typecho 插件之间的 required / optional 关系由这些包元数据递归推导，不新增 Manifest 依赖字段
- 插件名称与描述的本地化由 `plugin-loader` 在构建时从插件包 `locales/*.json` 提取为 manifest 的 `displayLocales`，未激活时插件列表仍按当前语言展示；manifest 的 `name` / `description` 作为兜底必须独立可读。其他翻译 key 仍由激活插件的 `registerTranslations()` 注册

### 6.5.1 Capability 能力注册

- Capability 是独立于 Hook、Manifest 和包依赖的新系统概念，核心只提供通用注册/解析、版本匹配、激活代次和 owner 生命周期，不硬编码具体能力
- 插件在 `init()` 中通过 `PluginInitContext.registerCapability({ capability, version, factory })` 注册实现；owner 自动绑定当前 `pluginId`，初始化失败或停用后旧注册不可解析
- Consumer 从请求 Hook extra 的 `capabilityRuntime` 取得上下文，通过 SDK `resolveCapability(runtime, { capability, minVersion?, ownerPluginId? })` 解析；未指定 owner 时多个实现返回 `ambiguous`，不得静默按注册顺序选择
- Capability 默认仅用于 HTTP；注册时使用 `scope: 'any'` 可在 Cron 和消费等非 HTTP 上下文中解析。解析成功结果携带 `backgroundAvailable`（`scope: 'any'` 时为 true）；`resolveTaskQueue` 会拒绝只能在 HTTP 解析的 `tasks.queue` provider，避免入队成功但后台永远无法消费。任务 provider 使用此 scope，详见第 13 节。
- Consumer 必须处理 `unavailable`、`ambiguous`、`version-mismatch`、`factory-failed` 和能力调用错误，并自行实现可选功能降级；Capability 不执行 Consumer 提供的工具/函数
- 当前 AI 能力目录由 `typecho-plugin-ai` 提供：`ai.chat.generate` 负责对话生成，`ai.models.list` 发布模型清单——只发布设置了 `alias` 且已启用、支持文本对话的模型，按别名跨 Provider 合并去重（供其他插件的配置下拉与保存前校验使用，服务需实现 `listOptions()`）；Scribe 通过这两个能力消费 AI 插件，不再自带 endpoint / apiKey。`ai.image.generate`、`ai.audio.speech.generate`、`ai.audio.transcribe`、`ai.embeddings.create` 是预留 ID，不代表已有实现

### 6.6 Hook 触发点

插件只应依赖下列已在运行时接入的 canonical Hook。`HookPoints` 中未列出的常量无调用保证；旧名称通过 `DeprecatedHookPointAliases` 兼容归一化。

**call**：
`request:begin`, `request:end`, `admin:begin`, `admin:end`, `archive:init`, `archive:beforeRender`, `archive:afterRender`, `archive:index`, `archive:single`, `archive:category`, `archive:tag`, `archive:author`, `archive:date`, `archive:search`, `post:afterPublish`, `post:afterSave`, `post:beforeDelete`, `post:afterDelete`, `page:afterPublish`, `page:afterSave`, `page:beforeDelete`, `page:afterDelete`, `comment:afterCreate`, `feedback:trackback:after`, `feedback:pingback:after`, `comment:reply`, `comment:action`, `user:login:success`, `user:login:failure`, `user:logout`, `user:register:after`, `upload:after`, `upload:delete`

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
- 边缘缓存只对既没有认证 Cookie、也没有 `Authorization` 头的请求生效（`hasAuthCookies` + `Authorization` 闸门，避免登录态或 Bearer 鉴权保护的插件 HTTP 面被缓存命中或回填）

### 8.3 CSRF 保护

- `generateSecurityToken(secret, authCode, uid)` 生成 token，使用 1 小时滑动桶轮换；`validateSecurityToken` 同时接受当前与上一桶 token
- 评论 token 绑定 `cid`：`generateCommentToken(secret, cid)` / `validateCommentToken(token, secret, cid)`；不再回退校验历史 referer 绑定 token，缓存页面使用 cid 绑定 token 即可通过校验
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
- 插件自带的 HTTP 面（如 `typecho-plugin-ai` 的 `{basePath}/v1/*`）的失败鉴权限流与并发上限是**内存级、按 isolate**，不跨 PoP 共享：Bearer token 熵足够高（16–128 位随机串，最多 20 个），这类计数只用于抬高爆破成本与保护单个 isolate 的上游预算，不作为强安全边界；需要跨 PoP 共享的限流一律走 D1（见上一条）

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
- `src/pages/api/admin/content.ts` 保存文章/页面时必须确保 `contents.slug` 唯一；DB 的 `typecho_contents_slug_unique` 部分唯一索引覆盖所有非 revision 且非空 slug，revision 可复用父级 slug。应用层先由 `resolveUniqueContentSlug` 生成 `<slug>-<cid>` 后缀，并只对该索引冲突做有界重试
- `src/pages/api/install.ts` 的 install handler 必须用 `.returning()` 拿真实自增主键，不准硬编码 `cid:1` / `mid:1`；slug 冲突要走 `resolveSlug` 后缀策略
- 副作用类管理操作禁止响应 GET（`delete-spam` 等），统一走 POST + CSRF
- 公共归档（首页/分类/标签/作者/月归档/搜索）必须过滤 `created > now()` 的将来贴
- 月归档使用 `/YYYY/MM/`，侧栏和归档查询使用站点 IANA 时区的月份边界，分页沿用 `/page/N/`
- 评论分页和线程回复页共用后台的每页条数、默认首末页和排序。关闭分页时一次读取并展示该内容的全部已审核评论。线程预览每次最多读取 200 行，单个父评论的预览条数使用后台每页条数，并保留其余回复的入口
- 评论 / 注册 / 登录 等公共 POST 必须做 Origin 同源校验（参考 `isSameOriginRequest`）
- 搜索优先走 FTS5 trigram（`src/lib/fulltext.ts`，仅当每个空白分隔词都 ≥ `FTS_MIN_CHARS` 且 FTS 就绪时启用，MATCH 按词 AND 匹配）；其余情况回退 LIKE 并套 `[2,50]` 字符护栏，长度不在范围内时短路 `1=0`
- Feed 路由的条数受 `options.feedItems` 控制并 clamp 到 `[5,50]`；description 始终走 excerpt，content:encoded 仅在 `feedFullText` 开启时才输出
- `/sitemap.xml` 是站点地图索引，每个 `/sitemap/{part}.xml` 分片最多包含 1000 条 URL；分片按 `(modified DESC, cid DESC)` 使用游标读取，只包含已发布且非未来的文章/页面，并使用当前 canonical permalink；`/robots.txt` 始终公布索引 URL

### 9.2 管理后台页面

1. `src/pages/admin/<name>.astro` 创建页面，使用 `Admin.astro` 布局
2. 如需配套 API，在 `src/pages/api/admin/` 创建同名 `.ts`

### 9.3 模块级状态

Cloudflare Workers 单个 isolate 内的模块级状态会在异步请求间交错；写路径必须显式处理竞态。以下模块级状态只允许用作有界的读取缓存或按 owner 管理的运行时注册表：
- `src/lib/plugin.ts`：`pluginRegistry` 与 loader 在启动时登记；`hookRegistry` 在插件首次激活时幂等写入，初始化完成后只读；`initialisingPlugins` 合并并发初始化
- `src/lib/cache.ts`：`cacheVersion` memo（60s）+ options 版本戳缓存（Cache API）；Cache API 失败必须回源 D1 或跳过写入，不得使业务请求失败；Set-Cookie、`private`、`no-store`、`no-cache` 与 `Vary: *` 响应不进入公共缓存
- `src/lib/options.ts`：`optionSnapshot` / `pendingOptionLoad`（isolate 级单槽快照，5 分钟 TTL + cacheVersion 校验 + 并发合并；`getDb()` 每次请求新建 handle，WeakMap 按 Database 键控无法跨请求命中）
- `src/lib/security-options.ts`：只在带认证 Cookie、`Authorization` 头或已登记插件路由候选的请求上，通过 D1 `first-primary` 会话刷新插件启用集合与 `plugin:*` 配置；普通公开页面继续使用 options 快照。D1 批次提交后才能触发插件 Hooks 或外部副作用
- `src/lib/sidebar.ts`：`sidebarSnapshot` / `navSnapshot`（同样是 isolate 级单槽 + cacheVersion 版本化键）
- `src/lib/comment-page.ts`：`commentRootCounts`（按 cacheVersion 键控的根评论计数缓存，TTL + 条数上限）
- `src/lib/page-data/archive.ts`：`archiveCountCache`（按 cacheVersion + 归档类型/URL 键控的归档总数缓存，60s TTL + 200 条上限，过期与最旧条目淘汰）
- `src/lib/markdown.ts`：`renderedContentCache`（Markdown 渲染结果 LRU，64 条；仅缓存默认摘要长度且源文本 ≤ 100k 字符的输入）与 `commentSanitizeOptionsCache`（评论净化选项 LRU，32 条）
- `src/lib/timezone.ts`：`ianaFormatterCache`（按 timezone 复用 `Intl.DateTimeFormat`，上限 64 条，超限淘汰最旧条目）
- `src/lib/content.ts`：`monthFormatterCache`（按 locale / timezone / 长或短格式复用月份名 formatter，上限 32 条，超限淘汰最旧条目）；`formatDate` 仅在格式串包含 `F` / `M` 时创建月份名 formatter，`buildPermalink` 仅在 pattern 含日期 token 时转换时区
- `src/lib/fulltext.ts`：`ftsAvailability`（FTS5 就绪状态）
- `src/lib/isolate-boot.ts`：`state`（表检查 / 索引回填 / FTS 引导的一次性标志）
- `src/lib/plugin-routes.ts`：resolver 注册表与当前 claim 表；请求引导必须复制为 request-local route snapshot，不能在后续路由判断中依赖可能被其他请求刷新过的模块级 claim
- `src/lib/login-rate-limit.ts`：登录限流（D1 持久化） + 上传限流（`trackSlidingWindow`，内存级滑动窗口）

### 9.4 配置表单类型（插件 / 主题共用）

`package.json` 的 `typecho.plugin.config` 与 `theme.json` 的 `config` 字段支持以下类型：
`text`, `textarea`, `select`, `radio`, `checkbox`, `password`, `hidden`, `object`, `repeatable`, `tokens`

**扩展属性**：
- `showWhen` — 条件显示，仅适用于 `repeatable.itemFields`。格式：`{ field: "provider", value: "s3" }`，`value` 可为单值或数组
- `optionsSource` — 动态选项源，仅适用于 `select`。支持 `"r2Bindings"`（自动读取 wrangler.jsonc 中的 R2 binding 名称），或 `{ capability, ownerPluginId?, minVersion? }`：由其他插件通过 capability 发布选项（能力需实现 `listOptions(): Array<{ value: string; label?: string }>`），解析失败时渲染空列表，字段值只做长度/可见字符校验，由插件在 `plugin:config:beforeSave` 中用同一 capability 复核

- `optionDisabled` — 选项值数组，适用于 `select` / `radio` / `option` 型 `checkbox`。命中该数组的选项渲染为 disabled，且服务端在保存时直接丢弃该值（即使被伪造提交）。用于「能力已预留但暂未实现」这类场景，不要用文案标注代替禁用
- `itemFields` — 嵌套字段定义，适用于 `object` 与 `repeatable`；两者允许递归嵌套
- `collapsible` — 仅适用于 `repeatable`。为 true 时每行渲染为可折叠卡片（首行展开、其余收起），头部显示摘要与状态徽标
- `summaryFields` — 仅适用于 `repeatable`。声明构成摘要的 itemFields，缺省取第一个 `text` 字段
- `summaryFormat` — 仅适用于 `repeatable`。默认为 `joined`（使用 ` · ` 连接）；`parenthesized` 将首个非空值与其余非空值渲染为 `首值(其余值)`
- `summaryAsTitle` — 仅适用于 `repeatable`。为 true 时用摘要替换条目的 `Label #N` 标题；摘要为空时回退到原标题
- `statusField` — 仅适用于 `collapsible` 的 `repeatable`。声明在卡片头部渲染为状态徽标的 itemFields（如 `enabled`）
- `tokens` — 只读的密钥列表，值为 `[{ id, token }]`。页面只提供「生成 / 复制 / 删除」，没有编辑框；「生成」在**前端**用 `crypto.getRandomValues` 生成（最多 20 个，16–128 位 `A-Za-z0-9_-`），随表单提交、点保存才持久化。服务端只做校验与 allowlist，空值行不落库；超过 20 个时保存直接报错，不做静默截断，前端达到上限会禁用生成按钮。删除行即删除密钥，全部删空表示该功能不再可用。`tokens` 不做掩码，因为需要复制原文

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
- 插件测试 → `src/plugins/<name>/*.test.ts`（与入口同目录）；核心库单测一律放 `tests/unit/`（`src/lib/plugin.test.ts` 是历史遗留位置）
- 模板渲染测试 → `tests/astro/<name>.test.ts`，用 Astro Container API（`experimental_AstroContainer`）真正渲染 `.astro` 组件并断言产出的 HTML；由独立工程 `vitest.astro.config.ts` 运行（`pnpm run test:astro`，CI 与 `pnpm run test` 一起跑）。不要在 `tests/unit/` 里用 `readFileSync` 断言模板源码——模板断言属于这一类渲染测试

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

### 10.5 静态检查（ESLint）

- `pnpm run lint` 覆盖 `src/**/*.ts`、`src/**/*.astro`、`tests/**/*.ts`、`scripts/**/*.ts`；`.astro` 同时检查 frontmatter 与内联 `<script>`（Astro processor 生成的虚拟块）
- 内联客户端脚本按浏览器环境检查（声明 `$`、`HyperDown`、`Markdown`、`DOMPurify` 等 vendor 全局），保留历史 `var` 写法，不套用 Workers 运行时约束
- 规则以 `eslint.config.mjs` 为准；`no-explicit-any` 因 D1 batch 与插件/主题动态配置边界保持关闭，新增例外需在配置中说明原因
- Workers 运行时边界由 lint 强制检查：运行时代码禁止 `node:*` 导入与 Node 全局，客户端 IP 只能经 `getClientIp(request)` 读取，禁止 `Astro.locals.runtime.env`；例外仅限 `src/integrations/`、测试与脚本

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
│   ├── default-queue-provider.ts    # 新装默认启用的任务 Queue provider id
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
│   ├── tasks/                       # 任务声明、调度、分发和队列能力（queue.ts 解析 tasks.queue；queue-dashboard.ts 定义后台观测契约）
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
│   ├── typecho-plugin-queue/ # 任务 Queue provider + 观测
│   └── typecho-plugin-wechat-publisher/ # WechatPublisher
└── themes/                          # 内置主题（工作区包）
    └── README.md                    # 主题开发完整规范
tests/
├── setup.ts                         # 全局测试 setup
├── helpers.ts                       # 测试工具函数 (createTestDb, seedAdmin, makeAuthCookie)
├── __mocks__/cloudflare-workers.ts  # cloudflare:workers stub + caches mock
├── unit/                            # 单元测试
└── integration/                     # 集成测试
scripts/
├── ops.mjs                          # 运营工具分发入口（db/user/extensions/queues）
├── migrate.ts                       # PHP Typecho 数据迁移
└── reset-password.ts                # 密码重置工具
```

---

## 13. 定时与异步任务系统

本节是实现和后续插件开发必须遵守的任务系统规范；若需改变架构边界，先更新本节并完成评审。

### 13.1 任务核心与队列 Provider

- 任务核心负责任务注册、身份校验、消息构建、站点时区调度和任务分发。异步投递和消费依赖版本化 `tasks.queue` capability；选定唯一兼容 provider，能力缺席、不可用或冲突时禁止任务执行。
- Cloudflare provider 封装 `QUEUE` binding、插件配置中的队列名、原生消费批次、批量投递限制和观测。队列名默认 `typecho-cf-tasks`，保存在插件配置（`typecho_options` 的 `plugin:<id>`），仅用于后台展示与漂移告警：consumer 收到不一致的队列名时记录 warning 并照常处理，不得据此拒收或丢弃消息。Worker 的 `scheduled`、`queue` 入口经平台适配转发。带队列部署的 Cron 每分钟触发一次；无队列部署省略任务 Cron、producer 和 consumer。
- 队列传输采用至少一次投递；插件必须保证业务幂等。核心 dispatcher 维持任务级和全局并发上限。现有 Cloudflare 配置采用有限重试、无 DLQ，达到重试上限后丢弃消息。消费批次在任务运行时不可用时按有界延迟重试并记录错误详情，避免瞬时故障耗尽重试预算。
- 新装站点在安装流程中默认启用 Queue provider；已有站点由管理员在插件页手动启用。HTTP、Cron 和消费使用权威激活与配置；管理员停用后停止提交和调度，新消费批次显式有限重试。已进入执行的调用可能完成。
- 带队列部署保留 `typecho-cf-tasks` 和现有资源预检。无队列部署用 `TYPECHO_QUEUE_MODE=no-queue` 从同一源配置派生；资源预检、Astro 构建和 Wrangler 部署使用同一模式。预检跳过队列操作，站点仍能安装与访问。
- Deploy Button 和 Workers Builds 生产环境使用 `pnpm run deploy:ci` 部署构建产物；非生产分支使用 `wrangler versions upload`。Dry run 构建并验证配置，资源预检失败必须终止带队列部署。
- 任务状态、历史、通用幂等记录与 Cron 补偿不引入专用 D1 表。站点选项继续保存激活状态和插件配置。

### 13.2 插件接口约束

- 定时和异步任务声明通过 `registerScheduledTask()`、`registerAsyncTask()`；`enqueueAsyncTask()` 绑定任务所属插件，校验任务已注册、插件激活且 provider 可用。提交校验使用 primary 激活集只读构建提交运行时，不改变当前请求的激活代次或已持有的 `capabilityRuntime`。
- `TaskExecutionContext` 提供站点和任务上下文，不注入 `env`；handler 使用的平台资源由插件自己的平台适配提供。
- 保留 `TaskEnvelope` v1 兼容性。投递和消费都校验任务身份、来源、时间、`jobId`、`taskKey` 和 `idempotencyKey`。payload 必须为有界 JSON，禁止携带密码、Cookie、CSRF token、访问令牌和完整请求头。
- 任务 handler 返回 `success`、`retry` 或 `discard`。异常和超时走有限重试，业务 handler 承担重复投递的幂等。handler 请求的 `delaySeconds` 必须为 0–86,400 的整数；超出范围视为非法并回退到 5–300 秒指数退避。
- Cloudflare provider 按最多 100 条和整批 256,000 bytes 切批，限制 `delaySeconds` 在 0 至 86,400 秒之间。长流程采用拆分任务或具有持久化恢复的机制。

### 13.3 时间与生命周期

- 核心用真实 UTC 触发时间和 `options.timezone` 的 IANA 时区计算定时槽位。默认键为 `{pluginId}:{taskId}:{localSlot}:{scheduledAt}`，夏令时回拨的两个 instant 分别投递。
- HTTP、Cron 和消费冷启动均先加载插件注册表。插件 init 失败或停用时清理其声明。业务插件停用后，分发跳过其任务副作用。
- 任务核心模块放在 `src/lib/tasks/`，公共类型通过 `src/lib/plugin-sdk.ts` 导出。provider 实现放在对应的插件包。

### 13.4 队列观测后台

- `/admin/manage-queues` 向管理员提供只读 provider 状态和观测，区分停用、不可用与可用；页面仅展示可取得的队列指标和配置。该菜单与路由仅在任务 Queue provider 已启用时开放：默认 provider 在激活列表中，或存在已注册/可解析的 provider；没有任何 provider 时菜单隐藏、路由返回 404。
- Cloudflare provider 使用 binding 指标及可选的账户级只读 API。账户 ID、只读 API 令牌与展示用队列名均保存在插件配置（`typecho_options` 的 `plugin:<id>`），在插件设置页维护；`QUEUE` binding 仍由 Worker 平台提供。上游请求有超时、响应体和分页限制。
- 插件配置中的队列名建议与 Wrangler producer、consumer 的队列名保持一致（用于后台展示与配置漂移告警；不一致不会丢弃任务）。

### 13.5 协作与验证约定

- 任务系统属于架构级变更；实施前先更新设计规范和实施计划，文档评审通过后再写代码。
- 可并行的工作必须按不重叠文件集合拆分；`plugin.ts`、`plugin-sdk.ts`、`wrangler.jsonc`、`src/worker.ts` 等共享边界由主协作者或单一子任务负责集成，避免并发冲突。
- 新增模块必须配套单元/集成测试；至少覆盖 Cron 解析与时区、envelope 校验、ack/retry/discard、插件停用、任务级并发和 Worker 冷启动注册表。
- 修改完成后运行 `pnpm run test`、`pnpm run typecheck`，涉及构建入口或 Wrangler 配置时再运行 `pnpm run build`，并执行 `git diff --check`。
