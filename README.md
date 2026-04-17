# Typecho-CF

[English](README.en.md)

基于 [Typecho](https://typecho.org) 完整重写的现代博客系统，运行在 **Astro + Cloudflare Workers + D1** 之上。保留 Typecho 数据库表结构，支持从 PHP 版 Typecho 直接迁移数据。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/eslizn/typecho-cf)

---

## 功能特性

**前台**：文章列表 / 分类 / 标签 / 作者 / 搜索归档、嵌套评论（Gravatar 头像）、RSS 2.0 / Atom 1.0 / RSS 1.0、文章密码保护、响应式默认主题

**管理后台**：文章 & 页面编辑管理、评论审核、媒体管理（R2 拖放上传）、用户管理（5 种角色）、主题切换、插件管理（启用/禁用/配置）、全站设置、安装向导

**系统**：主题系统（npm 包分发）、插件系统（Hook 机制，50+ 挂载点）、PHP 版 Typecho 数据迁移工具、SHA-256 + salt 认证

---

## 安装部署

### 前置要求

- Node.js 18+
- pnpm（`npm install -g pnpm`）
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)（`npm install -g wrangler`）
- Cloudflare 帐号

### 本地开发

```bash
# 克隆并安装依赖
git clone https://github.com/eslizn/typecho-cf.git
cd typecho-cf
pnpm install

# 启动开发服务器（D1 + R2 由 wrangler 自动模拟）
pnpm run dev
```

访问 http://localhost:4321，首次访问自动跳转安装向导。

### 部署到 Cloudflare

**1. 创建 Cloudflare 资源**

```bash
# 创建 D1 数据库
wrangler d1 create typecho-cf-db

# 创建 R2 存储桶
wrangler r2 bucket create typecho-cf-uploads
```

**2. 更新 `wrangler.toml`**

将 `database_id` 替换为上一步输出的 D1 数据库 ID：

```toml
[[d1_databases]]
binding = "DB"
database_name = "typecho-cf-db"
database_id = "替换为实际的 ID"
```

**3. 构建并部署**

```bash
pnpm run deploy
```

部署完成后访问 Worker URL，首次访问自动跳转安装向导。

---

## 命令参考

| 命令 | 说明 |
|------|------|
| `pnpm run dev` | 本地开发服务器 |
| `pnpm run build` | 生产构建 |
| `pnpm run deploy` | 构建 + 部署到 Cloudflare Workers |
| `pnpm run test` | 运行所有测试 |
| `pnpm run test:watch` | 监听模式运行测试 |
| `pnpm run test:coverage` | 生成覆盖率报告 |
| `pnpm run db:generate` | 生成 Drizzle 数据库迁移 |
| `pnpm run db:studio` | 启动 Drizzle Studio |
| `pnpm run db:migrate:local` | 迁移 PHP Typecho 数据到本地 |
| `pnpm run db:migrate:cloudflare` | 迁移 PHP Typecho 数据到 Cloudflare D1 |
| `pnpm run db:migrate:dry-run` | 预览迁移（不写入） |
| `pnpm run reset-password` | 重置用户密码（本地） |
| `pnpm run reset-password:cloudflare` | 重置用户密码（Cloudflare） |

---

## 从 PHP 版 Typecho 迁移

### 迁移步骤

```bash
# 迁移到 Cloudflare（生产环境）
pnpm run db:migrate:cloudflare \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads

# 迁移到本地（开发调试）
pnpm run db:migrate:local \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads

# 预览模式（不写入任何数据）
pnpm run db:migrate:dry-run \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads
```

### 迁移参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--source`, `-s` | 源 SQLite 数据库路径 | （必填） |
| `--uploads`, `-u` | 源 `usr/uploads/` 目录 | （必填） |
| `--prefix` | 源表前缀 | `typecho_` |
| `--dry-run`, `-n` | 预览模式 | `false` |
| `--site-url` | 新站点 URL（用于重写附件 URL） | — |
| `--d1-name` | D1 数据库名 | `typecho-cf-db` |
| `--r2-bucket` | R2 存储桶名 | `typecho-cf-uploads` |

### 迁移后重置密码

密码哈希算法不兼容（PHP phpass → SHA-256 + salt），迁移后需重置密码：

```bash
# 本地
pnpm run reset-password

# Cloudflare
pnpm run reset-password:cloudflare
```

---

## 插件开发

参考 [插件开发规范](src/plugins/README.md)。

---

## 主题开发

参考 [主题开发规范](src/themes/README.md)。

---

## 技术栈

| 组件 | 技术 |
|------|------|
| 框架 | [Astro](https://astro.build) 6.x (SSR) |
| 运行时 | [Cloudflare Workers](https://workers.cloudflare.com) |
| 数据库 | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite) |
| ORM | [Drizzle ORM](https://orm.drizzle.team) |
| 文件存储 | [Cloudflare R2](https://developers.cloudflare.com/r2/) |
| 测试 | [Vitest](https://vitest.dev) |
| 包管理 | pnpm |

---

## 与 PHP 版 Typecho 兼容性

| 方面 | 状态 |
|------|------|
| 数据库结构 | ✅ 完全兼容，可直接导入 SQLite 数据库 |
| 默认主题样式 | ✅ CSS & HTML 结构保持一致 |
| URL 结构 | ✅ 路由规则与 Typecho 默认配置一致 |
| 密码哈希 | ⚠️ 迁移后需重置密码（算法不同） |
| PHP 主题 / 插件 | ❌ 需按新格式重新封装（TypeScript / npm 包） |

---

## 许可证

MIT

---

## 开发指南（AI Agent）

> 本节面向 AI 编程助手（Claude Code、Copilot 等），提供项目架构与编码约定。

### 请求生命周期

```
请求 → src/middleware.ts（安装检测 + URL 重写）
     → src/lib/context.ts（初始化：DB 连接 / 加载选项 / 解析用户 Cookie / 加载激活插件）
     → 对应 page（.astro）或 API 端点（.ts）
     → 布局渲染（Base.astro → Blog.astro 或 Admin.astro）
```

### 关键模块

**插件系统**（`src/lib/plugin.ts`）：Hook 事件总线。两种类型：
- `doHook(point, ...args)` — call 钩子，执行副作用，无返回值
- `applyFilter(point, value, ...args)` — filter 钩子，链式变换数据，必须返回值

注册：`addHook(hookPoint, pluginId, handler, priority=10)`，priority 越小越先执行。  
插件包 = npm 包，`package.json` 的 `keywords` 必须同时包含 `"typecho"` 和 `"plugin"`，由 `src/integrations/plugin-loader.ts` 在构建时发现并注入。

**主题系统**（`src/lib/theme.ts` + `src/integrations/theme-loader.ts`）：  
主题包 = npm 包，`keywords` 必须同时包含 `"typecho"` 和 `"theme"`。构建时自动复制资源到 `public/themes/{id}/`，生成 Vite 虚拟模块 `virtual:theme-templates`（静态 import 所有主题组件）。激活主题 ID 存储在 DB 的 `options.theme`。

**数据库**（`src/db/schema.ts`）：Drizzle ORM 定义 7 张表，表名必须保持 `typecho_*` 前缀，不可重命名。建表 SQL 由 `src/lib/schema-sql.ts` 在运行时从 Drizzle schema 反射生成。

关键字段枚举值：
- `contents.type`：`post` | `page` | `post_draft` | `page_draft` | `attachment`
- `contents.status`：`publish` | `draft` | `hidden` | `private` | `waiting`
- `comments.status`：`approved` | `waiting` | `spam`
- `users.group`（权限由高到低，数字越小权限越高）：`administrator`(0) | `editor`(1) | `contributor`(2) | `subscriber`(3) | `visitor`(4)

**认证**（`src/lib/auth.ts`）：PBKDF2-SHA256（100,000 次迭代 + 16 字节 salt）密码哈希，格式 `$PBKDF2$iterations$salt$hash`。Session Token 格式 `uid:sha256(secret+uid:authCode)`，存于 Cookie `__typecho_uid` 和 `__typecho_authCode`。`typecho_options` 中的 `secret` 字段是签名密钥，跨部署必须保留，**不可重置**。

**Cloudflare 环境变量访问**（Astro 6 + @astrojs/cloudflare v13+）：
```typescript
// ✅ 正确
import { env } from 'cloudflare:workers';
const db = env.DB;
const bucket = env.BUCKET;

// ❌ 旧方式（已移除）
// Astro.locals.runtime.env.DB
```

**客户端 IP 获取**：统一使用 `src/lib/context.ts` 中的 `getClientIp(request)`，不要直接读取 Header。优先级：`CF-Connecting-IP`（单个可信 IP）> `X-Forwarded-For` 首个值。

### Cloudflare 绑定（wrangler.toml）
- `DB` → D1 数据库 `typecho-cf-db`
- `BUCKET` → R2 存储桶 `typecho-cf-uploads`

R2 文件通过 `src/pages/usr/uploads/[...path].ts` 代理访问。

### 测试

Vitest 在 Node.js 环境运行。`tests/__mocks__/cloudflare-workers.ts` 提供 `cloudflare:workers` 模块的 stub。集成测试通过 `better-sqlite3` 在内存中创建真实 SQLite 数据库，直接调用 API 端点 handler。

**规范**：新增功能和 bug 修复必须同步添加对应测试用例。单元测试放 `tests/unit/`，API 集成测试放 `tests/integration/`。集成测试 mock 模式：
```typescript
let testDb: ReturnType<typeof drizzle<typeof schema>>;
vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
// 若需要 mock cloudflare:workers 中的变量（如 BUCKET.delete），必须用 vi.hoisted() 先声明
const { mockFn } = vi.hoisted(() => ({ mockFn: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: { DB: null, BUCKET: { delete: mockFn } }, ... }));
```

### 设计约定

**新增 API 端点**
- 公开接口 → `src/pages/api/`
- 管理接口 → `src/pages/api/admin/`（通过 context 验证登录态）
- 文件为 `.ts`，直接 `export const POST = ...` 等，返回 `Response` 对象

**新增后台页面**
1. `src/pages/admin/` 下创建 `.astro`，使用 `Admin.astro` 布局
2. 如需配套 API，在 `src/pages/api/admin/` 创建同名 `.ts`

**新增 Hook 点**
1. 在 `src/lib/plugin.ts` 的 `HookPoints` 对象中添加新常量，命名格式 `component:hookName`
2. 在触发位置调用 `doHook()` 或 `applyFilter()`
3. 更新 README 和 `src/pages/admin/plugins.astro` 的 Hook 参考

**主题模板组件**

主题组件位于 `components/`，接收 `src/lib/theme-props.ts` 定义的 Props 接口：

| 文件 | Props 接口 |
|------|-----------|
| `Index.astro` | `ThemeIndexProps` |
| `Post.astro` | `ThemePostProps` |
| `Page.astro` | `ThemePageProps` |
| `Archive.astro` | `ThemeArchiveProps` |
| `NotFound.astro` | `ThemeNotFoundProps` |

无 `components/` 目录的纯 CSS 主题自动回退到默认主题组件。

**插件配置存储**
- 配置存储在 `typecho_options` 表：`name = "plugin:<pluginId>"`，值为 JSON 字符串
- 通过 `loadPluginConfig(options, pluginId)` 读取（自动合并 manifest 默认值）
- 启用插件时自动写入默认配置，禁用时删除配置

**数据库 Schema 变更**  
修改 `src/db/schema.ts` 后必须运行 `pnpm run db:generate` 生成迁移文件，**不要手动修改 `drizzle/` 目录下的文件**。

### 本地 npm 工作区包

`src/plugins/typecho-plugin-captcha/` 和 `src/themes/typecho-theme-minimal/` 是本地工作区包，是开发新插件/主题的参考示例。

- 插件开发规范：[src/plugins/README.md](src/plugins/README.md)
- 主题开发规范：[src/themes/README.md](src/themes/README.md)
