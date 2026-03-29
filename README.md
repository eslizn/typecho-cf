# Typecho-CF

基于 [Typecho](https://typecho.org) 完整重写的现代博客系统，运行在 **Astro + Cloudflare Workers** 之上。

保留了 Typecho 的数据库表结构、默认主题样式和管理后台功能，同时利用 Cloudflare 边缘网络实现极速响应。

## 技术栈

| 组件 | 技术 |
|------|------|
| 框架 | [Astro](https://astro.build) 6.x (SSR, server output) |
| 运行时 | [Cloudflare Workers](https://workers.cloudflare.com) |
| 数据库 | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite 兼容) |
| ORM | [Drizzle ORM](https://orm.drizzle.team) 0.45+ |
| 文件存储 | [Cloudflare R2](https://developers.cloudflare.com/r2/) |
| Markdown | [marked](https://marked.js.org) 17.x + [sanitize-html](https://github.com/apostrophecms/sanitize-html) 2.17 |
| TypeScript | 6.x |
| 包管理器 | pnpm (hoisted 模式) |

## 功能概览

### 前台博客
- 文章列表 / 独立页面 / 分类归档 / 标签归档 / 作者归档
- 全文搜索
- 文章评论系统（嵌套回复、Gravatar 头像）
- RSS 2.0 / Atom 1.0 / RSS 1.0 Feed 输出
- 文章密码保护
- 分页导航
- 永久链接（自定义文章路径模式 + 独立页面路径模式 + 分类路径模式）
- 响应式默认主题（与 Typecho 默认主题视觉一致）

### 管理后台 (21 个页面)
- 控制台仪表盘（统计概览、最新文章、最近评论）
- 撰写 / 管理文章、独立页面
- 评论管理（审批、删除、批量操作）
- 分类 / 标签管理
- 媒体管理 & R2 文件上传（拖放 / 粘贴上传）
- 用户管理（多角色权限、批量操作）
- 主题管理（浏览、切换）
- 插件管理（启用 / 禁用 / 配置）
- 设置面板（基本设置 / 阅读设置 / 评论设置 / 永久链接设置）
- 个人资料设置

### 系统
- 安装向导（首次访问自动引导）
- 用户认证（SHA-256 + salt，Cookie 会话，支持"记住登录"）
- 用户角色权限（administrator / editor / contributor / subscriber / visitor）
- 主题系统（npm 包分发，keyword 发现机制，自定义模板组件）
- 插件系统（Hook 机制，27 个内置挂载点，声明式配置面板）
- PHP 版 Typecho 数据迁移工具
- 密码重置工具
- Typecho 数据库兼容（7 张 `typecho_*` 前缀表，可直接迁移数据）

---

## 项目结构

```
typecho-cf/
├── astro.config.mjs              # Astro 配置（含 themeLoader + pluginLoader 集成）
├── wrangler.toml                  # Cloudflare Workers 配置（D1 + R2 绑定）
├── drizzle.config.ts              # Drizzle ORM 配置
├── scripts/
│   ├── migrate.ts                 # PHP 版 Typecho 数据迁移工具
│   └── reset-password.ts          # 密码重置工具
├── public/
│   ├── css/                       # 管理后台样式（normalize / grid / admin）
│   ├── js/                        # 静态脚本（jQuery / PageDown / Typecho 后台）
│   ├── img/                       # 图片资源
│   └── themes/                    # 构建时复制的主题静态资源
└── src/
    ├── env.d.ts                   # TypeScript 环境声明
    ├── middleware.ts               # 安装检测 + URL 重写中间件
    ├── plugins/
    │   └── typecho-plugin-captcha/ # Captcha 验证码插件（本地 npm 包）
    ├── themes/
    │   └── typecho-theme-minimal/ # 默认主题（本地 npm 包，含 6 个模板组件）
    ├── db/
    │   ├── index.ts               # 数据库连接（D1 → Drizzle）
    │   └── schema.ts              # 表定义（7 张表）
    ├── integrations/
    │   ├── theme-loader.ts        # 主题构建集成（扫描 + 复制资源 + 虚拟模块）
    │   └── plugin-loader.ts       # 插件构建集成（扫描 + 注入入口脚本）
    ├── layouts/
    │   ├── Base.astro             # HTML 基础布局（动态加载主题 CSS）
    │   ├── Blog.astro             # 前台博客布局（页头 + 侧栏 + 页脚）
    │   └── Admin.astro            # 管理后台布局（含 Hook 扩展点）
    ├── lib/
    │   ├── auth.ts                # 认证 & 密码哈希 (SHA-256 + salt)
    │   ├── content.ts             # 内容工具（permalink / 日期格式化）
    │   ├── context.ts             # 请求上下文（DB / 用户 / 选项 / 插件加载）
    │   ├── feed.ts                # RSS/Atom Feed 生成
    │   ├── markdown.ts            # Markdown 渲染（集成 Hook）
    │   ├── options.ts             # 站点选项加载 & 缓存
    │   ├── page-data.ts           # 前台数据查询层（7 个 prepare 函数）
    │   ├── pagination.ts          # 分页逻辑
    │   ├── plugin.ts              # 插件引擎（Hook 事件总线 / 生命周期管理）
    │   ├── schema-sql.ts          # 运行时 CREATE TABLE SQL 生成
    │   ├── sidebar.ts             # 侧栏数据加载（含 widget:sidebar Hook）
    │   ├── theme-props.ts         # 主题模板 Props 接口定义
    │   ├── theme.ts               # 主题系统（注册表 / 查询 / 样式管理）
    │   └── upload.ts              # R2 文件上传
    └── pages/
        ├── index.astro            # 首页
        ├── install.astro          # 安装向导
        ├── 404.astro              # 404 页面
        ├── [slug].astro           # 独立页面
        ├── archives/[cid].astro   # 文章详情
        ├── category/[slug].astro  # 分类归档
        ├── tag/[slug].astro       # 标签归档
        ├── author/[uid].astro     # 作者归档
        ├── search/[...keywords].astro  # 搜索
        ├── feed/[...type].ts      # RSS/Atom Feed
        ├── usr/uploads/[...path].ts    # R2 文件代理
        ├── admin/                 # 管理后台（21 个页面）
        └── api/                   # API 端点（20 个）
```

---

## 数据库

完全沿用 Typecho 的 `typecho_*` 表结构，使用 Drizzle ORM 定义：

| 表名 | 说明 | 主键 |
|------|------|------|
| `typecho_users` | 用户 | `uid` |
| `typecho_contents` | 文章 & 页面 | `cid` |
| `typecho_comments` | 评论 | `coid` |
| `typecho_metas` | 分类 & 标签 | `mid` |
| `typecho_relationships` | 内容↔分类/标签关联 | `cid + mid` |
| `typecho_options` | 站点设置 | `name + user` |
| `typecho_fields` | 自定义字段 | `cid + name` |

表定义位于 `src/db/schema.ts`，建表 SQL 由 `src/lib/schema-sql.ts` 在运行时自动生成。

---

## 路由映射

| 前台路由 | 文件 | 说明 |
|---------|------|------|
| `/` | `pages/index.astro` | 首页（文章列表） |
| `/archives/{cid}/` | `pages/archives/[cid].astro` | 文章详情 + 评论 |
| `/{slug}.html` | `pages/[slug].astro` | 独立页面 |
| `/category/{slug}/` | `pages/category/[slug].astro` | 分类归档 |
| `/tag/{slug}/` | `pages/tag/[slug].astro` | 标签归档 |
| `/author/{uid}/` | `pages/author/[uid].astro` | 作者归档 |
| `/search/{keywords}/` | `pages/search/[...keywords].astro` | 全文搜索 |
| `/feed[/rss\|atom\|rss1]` | `pages/feed/[...type].ts` | RSS/Atom Feed |
| `/usr/uploads/*` | `pages/usr/uploads/[...path].ts` | R2 文件代理 |

---

## API 端点

### 公开接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/install` | POST | 安装向导 |
| `/api/users/login` | POST | 用户登录 |
| `/api/users/logout` | POST | 用户登出 |
| `/api/users/register` | POST | 用户注册 |
| `/api/comment` | POST | 提交评论 |

### 管理接口（需登录）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/admin/content` | GET/POST/DELETE | 文章 & 页面 CRUD |
| `/api/admin/content-batch` | POST | 文章/页面批量操作 |
| `/api/admin/comment-action` | POST | 评论审批 / 删除 |
| `/api/admin/comment-batch` | POST | 评论批量操作 |
| `/api/admin/meta` | POST/DELETE | 分类 & 标签管理 |
| `/api/admin/options` | POST | 更新站点设置 |
| `/api/admin/profile` | POST | 更新个人资料 |
| `/api/admin/upload` | POST/DELETE | R2 文件上传/删除 |
| `/api/admin/media` | GET/DELETE | 媒体文件管理 |
| `/api/admin/media-batch` | POST | 媒体批量操作 |
| `/api/admin/user` | POST/DELETE | 用户管理 |
| `/api/admin/user-batch` | POST | 用户批量操作 |
| `/api/admin/theme` | GET/POST | 主题列表 & 切换 |
| `/api/admin/plugin` | GET/POST | 插件列表 & 启用禁用 |
| `/api/admin/plugin-config` | GET/POST | 插件配置读取 & 保存 |

---

## 主题系统

### 机制
- **发现**: 构建时扫描 `node_modules` 所有包，检查 `package.json` 的 `keywords` 同时包含 `"typecho"` 和 `"theme"`
- **ID**: 使用完整 npm 包名（如 `typecho-theme-minimal`），不去除前缀
- **构建**: Astro 集成 `theme-loader.ts` 复制主题资源到 `public/themes/{id}/`，生成 Vite 虚拟模块 `virtual:theme-templates`
- **运行时**: `options.theme` 字段指定激活主题 ID，`Base.astro` 动态加载对应 CSS

### 模板系统
- 主题可在 `components/` 目录下提供 `Index.astro` / `Post.astro` / `Page.astro` / `Archive.astro` / `NotFound.astro` 完全自定义页面 HTML
- 虚拟模块 `virtual:theme-templates` 在构建时静态 import 所有主题组件
- 前台 page 文件简化为：数据查询 → 组件选择 → `<Component {...data} />`
- 没有 `components/` 的纯 CSS 主题自动回退到默认主题的组件

### 核心文件
- `src/lib/theme.ts` — 主题注册表、查询、样式管理
- `src/lib/theme-props.ts` — 主题模板 Props 接口定义
- `src/lib/page-data.ts` — 前台数据查询层（7 个 prepare 函数）
- `src/integrations/theme-loader.ts` — 构建时发现、复制、注入

### 开发主题

主题包最低要求：
```
my-theme/
├── package.json       # keywords 必须包含 ["typecho", "theme"]
├── theme.json         # 主题元数据
├── style.css          # 主样式表
└── components/        # 可选：自定义模板组件
    ├── Index.astro
    ├── Post.astro
    ├── Page.astro
    ├── Archive.astro
    └── NotFound.astro
```

**theme.json** 示例：
```json
{
  "id": "my-theme",
  "name": "My Theme",
  "description": "A custom theme",
  "author": "Your Name",
  "version": "1.0.0",
  "stylesheet": "style.css",
  "stylesheets": ["normalize.css", "grid.css"]
}
```

**配置优先级**: `theme.json` > `package.json.typecho.theme` > 自动推导

参考示例：`src/themes/typecho-theme-minimal/`

---

## 插件系统

### 机制
- **发现**: 与主题相同，扫描 `node_modules` 所有包的 `keywords` 同时包含 `"typecho"` 和 `"plugin"`
- **ID**: 使用完整 npm 包名（如 `typecho-plugin-captcha`），不去除前缀
- **构建**: Astro 集成 `plugin-loader.ts` 扫描并通过 `injectScript` 注入插件入口代码
- **运行时**: `options.activatedPlugins` 存储已激活插件 ID 列表 (JSON 数组)
- **请求加载**: `createContext()` 每次请求时从 DB 加载激活列表 → `setActivatedPlugins()`

### 插件配置
- `plugin.json` 中的 `config` 字段声明配置项（声明式 JSON，替代 PHP 的 `config($form)`）
- 支持 7 种字段类型：text / textarea / select / radio / checkbox / password / hidden
- 管理页面 `/admin/plugin-config?id=<pluginId>` 自动渲染配置表单
- 配置存储在 `options` 表：`plugin:<packageName>` = JSON 对象
- 启用插件时自动保存默认配置，禁用时删除配置

### 核心文件
- `src/lib/plugin.ts` — 插件引擎：注册表、Hook 事件总线、生命周期
- `src/integrations/plugin-loader.ts` — 构建时发现 + 注入

### Hook 类型

| 类型 | 用途 | API | 返回值 |
|------|------|-----|--------|
| **call** | 动作钩子，执行副作用 | `doHook(hookPoint, ...args)` | 无 |
| **filter** | 过滤钩子，转换数据链 | `applyFilter(hookPoint, value, ...args)` | 必须返回 |

注册钩子：`addHook(hookPoint, pluginId, handler, priority=10)`，priority 数字越小越先执行。

### 内置 Hook 点 (27 个)

| Hook | 类型 | 触发位置 | 说明 |
|------|------|----------|------|
| `system:begin` | call | `context.ts` | 系统启动/每次请求 |
| `admin:header` | call | Admin 布局 | 后台 `<head>` 注入 |
| `admin:footer` | call | Admin 布局 | 后台页脚注入 |
| `admin:navBar` | call | Admin 布局 | 后台导航栏扩展 |
| `admin:writePost:option` | call | 文章编辑器 | 文章选项区扩展 |
| `admin:writePost:advanceOption` | call | 文章编辑器 | 文章高级选项扩展 |
| `admin:writePost:bottom` | call | 文章编辑器 | 文章编辑器底部扩展 |
| `admin:writePage:option` | call | 页面编辑器 | 页面选项区扩展 |
| `admin:writePage:advanceOption` | call | 页面编辑器 | 页面高级选项扩展 |
| `admin:writePage:bottom` | call | 页面编辑器 | 页面编辑器底部扩展 |
| `content:markdown` | filter | `markdown.ts` | Markdown 原文过滤 |
| `content:content` | filter | `markdown.ts` | 渲染后 HTML 过滤 |
| `content:title` | filter | (可用) | 标题过滤 |
| `content:excerpt` | filter | (可用) | 摘要过滤 |
| `comment:content` | filter | (可用) | 评论内容过滤 |
| `comment:markdown` | filter | (可用) | 评论 Markdown 过滤 |
| `post:write` | filter | `content.ts` API | 文章保存前数据过滤 |
| `post:finishPublish` | call | `content.ts` API | 文章发布后 |
| `post:finishSave` | call | `content.ts` API | 文章保存后 |
| `post:delete` | call | `content.ts` API | 文章删除前 |
| `post:finishDelete` | call | `content.ts` API | 文章删除后 |
| `page:write` | filter | `content.ts` API | 页面保存前数据过滤 |
| `page:finishPublish` / `finishSave` | call | `content.ts` API | 页面发布/保存后 |
| `page:delete` / `finishDelete` | call | `content.ts` API | 页面删除前后 |
| `feedback:comment` | filter | `comment.ts` API | 评论保存前过滤 |
| `feedback:finishComment` | call | `comment.ts` API | 评论保存后 |
| `feed:item` | filter | `feed/[...type].ts` | RSS/Atom 项过滤 |
| `widget:sidebar` | filter | `sidebar.ts` | 侧边栏数据过滤 |

### 开发插件

插件包最低要求：
```
my-plugin/
├── package.json       # keywords 必须包含 ["typecho", "plugin"]
├── plugin.json        # 插件元数据（含可选 config 声明）
└── index.ts           # 入口文件
```

**index.ts** 示例：
```typescript
export default function({ addHook, HookPoints, pluginId }) {
  // Filter hook: 修改文章 HTML
  addHook(HookPoints.CONTENT_CONTENT, pluginId, (html: string) => {
    return html + '<p>Powered by my plugin</p>';
  });

  // Call hook: 评论提交后通知
  addHook(HookPoints.FEEDBACK_FINISH_COMMENT, pluginId, (comment) => {
    console.log('New comment:', comment);
  });
}
```

**plugin.json** 配置声明示例：
```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "config": {
    "apiKey": {
      "label": "API Key",
      "type": "text",
      "default": "",
      "description": "Your API key"
    }
  }
}
```

**配置优先级**: `plugin.json` > `package.json.typecho.plugin` > 自动推导

参考示例：`src/plugins/typecho-plugin-captcha/`

---

## 快速开始

### 前置要求

- Node.js 18+
- pnpm (`npm install -g pnpm`)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- Cloudflare 帐号（D1 数据库 + R2 存储桶）

### 本地开发

```bash
# 安装依赖
pnpm install

# 启动开发服务器（本地 D1 + R2 由 wrangler 自动模拟）
pnpm run dev
```

访问 http://localhost:4321，首次访问会自动跳转到安装向导。

### 部署到 Cloudflare

1. **创建 D1 数据库**：
   ```bash
   wrangler d1 create typecho-cf-db
   ```

2. **创建 R2 存储桶**：
   ```bash
   wrangler r2 bucket create typecho-cf-uploads
   ```

3. **更新 `wrangler.toml`**：将 `database_id` 替换为实际的 D1 数据库 ID

4. **构建并部署**：
   ```bash
   pnpm run deploy
   ```

---

## 从 PHP 版 Typecho 迁移数据

项目提供了完整的数据迁移工具 `scripts/migrate.ts`，支持从 PHP 版 Typecho SQLite 数据库迁移到新系统。

### 迁移到 Cloudflare (生产环境)

```bash
pnpm run db:migrate:cloudflare \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads
```

### 迁移到本地 (开发环境)

```bash
pnpm run db:migrate:local \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads
```

### 预览模式 (不写入数据)

```bash
pnpm run db:migrate:dry-run \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads
```

### 迁移后重置密码

由于密码哈希算法不兼容（PHP phpass → SHA-256+salt），迁移后的用户需要重置密码：

```bash
# 本地环境
pnpm run reset-password

# Cloudflare 远程环境
pnpm run reset-password:cloudflare
```

### 迁移选项

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--source`, `-s` | 源 Typecho SQLite 数据库路径 | (必填) |
| `--uploads`, `-u` | 源 `usr/uploads/` 目录路径 | (必填) |
| `--target`, `-t` | 目标：`cloudflare` 或 `local` | `local` |
| `--prefix` | 源表前缀 | `typecho_` |
| `--dry-run`, `-n` | 预览模式，不执行写入 | `false` |
| `--site-url` | 新站点 URL（附件 URL 重写） | — |
| `--d1-name` | D1 数据库名 | `typecho-cf-db` |
| `--r2-bucket` | R2 存储桶名 | `typecho-cf-uploads` |

---

## NPM Scripts

| 命令 | 说明 |
|------|------|
| `pnpm run dev` | 启动本地开发服务器 |
| `pnpm run build` | 构建生产版本 |
| `pnpm run deploy` | 构建并部署到 Cloudflare Workers |
| `pnpm run test` | 运行所有单元测试和集成测试 |
| `pnpm run test:watch` | 以监听模式运行测试（文件变更时自动重跑） |
| `pnpm run test:coverage` | 运行测试并生成覆盖率报告 |
| `pnpm run db:generate` | 生成 Drizzle 数据库迁移 |
| `pnpm run db:studio` | 启动 Drizzle Studio 数据库管理界面 |
| `pnpm run db:migrate` | 数据迁移工具（通用入口） |
| `pnpm run db:migrate:local` | 迁移数据到本地 |
| `pnpm run db:migrate:cloudflare` | 迁移数据到 Cloudflare |
| `pnpm run db:migrate:dry-run` | 预览迁移（不写入） |
| `pnpm run reset-password` | 重置用户密码（本地） |
| `pnpm run reset-password:cloudflare` | 重置用户密码（Cloudflare） |

---

## 测试

项目使用 [Vitest](https://vitest.dev) 作为测试框架，测试文件位于 `tests/` 目录。

### 目录结构

```
tests/
├── __mocks__/
│   └── cloudflare-workers.ts  # cloudflare:workers 模块的 Node.js 桩
├── unit/
│   ├── auth.test.ts           # 认证模块单元测试（密码/Token/Cookie）
│   ├── content.test.ts        # 内容工具单元测试（Permalink/日期格式化）
│   ├── context.test.ts        # getClientIp() 单元测试
│   └── options.test.ts        # 站点选项单元测试（loadOptions/setOption）
└── integration/
    ├── comment.test.ts        # POST /api/comment 集成测试
    └── admin-options.test.ts  # POST /api/admin/options 集成测试
```

### 运行测试

```bash
# 运行所有测试（单次）
pnpm run test

# 监听模式（文件变更时自动重跑）
pnpm run test:watch

# 生成代码覆盖率报告
pnpm run test:coverage
```

### 测试覆盖范围

| 模块 | 单元测试 | 集成测试 |
|------|----------|----------|
| `lib/context.ts` - `getClientIp()` | ✅ 9 cases | — |
| `lib/auth.ts` | ✅ 28 cases | — |
| `lib/content.ts` | ✅ 27 cases | — |
| `lib/options.ts` | ✅ 14 cases | — |
| `pages/api/comment.ts` | — | ✅ 14 cases |
| `pages/api/admin/options.ts` | — | ✅ 20 cases |

---

## 与 Typecho 的兼容性

| 方面 | 兼容状态 |
|------|----------|
| 数据库结构 | ✅ 完全兼容，可从 Typecho SQLite 数据库直接导入 |
| 默认主题 | ✅ CSS 样式和 HTML 结构与 Typecho 默认主题一致 |
| URL 结构 | ✅ 路由规则与 Typecho 默认配置一致 |
| 密码哈希 | ⚠️ 新体系 SHA-256 + salt，不兼容 phpass（迁移用户需重置密码） |
| 主题包 | 🔄 新机制（npm 包 + keywords），需按新格式封装 |
| 插件 | 🔄 新 Hook 机制（TypeScript），不兼容 PHP 插件 |

---

## Cloudflare 资源

| 资源类型 | 名称 | Binding | 用途 |
|----------|------|---------|------|
| Workers | `typecho-cf` | — | SSR 运行时 |
| D1 | `typecho-cf-db` | `DB` | 数据库 |
| R2 | `typecho-cf-uploads` | `BUCKET` | 文件存储 |

`wrangler.toml` 中通过 `DB` 和 `BUCKET` 绑定名引用。

---

## 开发指南

### 核心模块说明

| 模块 | 文件 | 职责 |
|------|------|------|
| 数据库 | `src/db/index.ts` | D1 → Drizzle ORM 连接 |
| Schema | `src/db/schema.ts` | 7 张表的 Drizzle 定义 |
| 上下文 | `src/lib/context.ts` | 每次请求初始化：DB、用户、选项、插件加载；提供 `getClientIp()` 工具函数 |
| 认证 | `src/lib/auth.ts` | 密码哈希（SHA-256 + salt）、Cookie 会话管理 |
| 选项 | `src/lib/options.ts` | 站点设置加载与缓存（自动生成缺失的 secret） |
| 内容 | `src/lib/content.ts` | Permalink 生成、日期格式化 |
| Markdown | `src/lib/markdown.ts` | Markdown→HTML 渲染（集成 Hook） |
| 分页 | `src/lib/pagination.ts` | 列表分页计算 |
| Feed | `src/lib/feed.ts` | RSS/Atom XML 生成 |
| 侧栏 | `src/lib/sidebar.ts` | 分类、标签、最近文章等侧栏数据 |
| 上传 | `src/lib/upload.ts` | R2 文件上传 / 删除 |
| 插件 | `src/lib/plugin.ts` | Hook 引擎、插件生命周期、配置管理 |
| 主题 | `src/lib/theme.ts` | 主题注册、查询、样式表管理 |
| 主题 Props | `src/lib/theme-props.ts` | 主题模板 Props 类型定义 |
| 数据查询 | `src/lib/page-data.ts` | 前台页面数据 prepare 函数 |
| 建表 SQL | `src/lib/schema-sql.ts` | 运行时从 Drizzle schema 反射生成 SQL |
| 中间件 | `src/middleware.ts` | 安装检测 + 永久链接 URL 重写 |
| 主题集成 | `src/integrations/theme-loader.ts` | 构建时发现主题 npm 包、复制资源、生成虚拟模块 |
| 插件集成 | `src/integrations/plugin-loader.ts` | 构建时发现插件 npm 包、注入入口 |

### 请求生命周期

```
请求 → middleware.ts (安装检测 + URL 重写)
     → context.ts (初始化 DB / 加载选项 / 加载用户 / 加载激活插件)
     → 对应 page/api 处理
     → 布局渲染 (Base → Blog/Admin)
```

### 客户端 IP 获取

使用 `src/lib/context.ts` 中的 `getClientIp(request)` 工具函数统一获取客户端 IP，**不要**直接读取 Header：

```typescript
import { getClientIp } from '@/lib/context';

const ip = getClientIp(request);
```

优先级规则：
1. **`CF-Connecting-IP`** — Cloudflare 注入，始终为单个真实客户端 IP（最可靠）
2. **`X-Forwarded-For`** — 可能是逗号分隔的多个 IP（`客户端IP, 代理1, 代理2`）；函数只取**第一个**

> ⚠️ 不要直接使用 `X-Forwarded-For` 的完整值来匹配 IP，否则代理链中添加的 IP 会导致限流比较失败。

### Cloudflare 环境变量访问

从 Astro 6 + @astrojs/cloudflare v13 开始：

```typescript
// ✅ 正确方式
import { env } from 'cloudflare:workers';
const db = env.DB;
const bucket = env.BUCKET;

// ❌ 旧方式（已移除）
// Astro.locals.runtime.env.DB
```

### 添加新的后台页面

1. 在 `src/pages/admin/` 创建 `.astro` 文件
2. 使用 `Admin.astro` 布局
3. 通过 `context.ts` 获取数据库和用户上下文
4. 如需 API 配合，在 `src/pages/api/admin/` 创建对应 `.ts`

### 添加新的 Hook 点

1. 在 `src/lib/plugin.ts` 的 `HookPoints` 对象中添加新常量
2. 在对应代码位置调用 `doHook()` (call) 或 `applyFilter()` (filter)
3. 更新 `plugins.astro` 页面的 Hook 参考文档

---

## 许可证

MIT
