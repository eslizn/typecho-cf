# Typecho-CF

[English](README.en.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/eslizn/typecho-cf)

基于 [Typecho](https://typecho.org) 完整重写的现代博客系统，运行在 **Astro + Cloudflare Workers + D1** 之上。保留 Typecho 数据库表结构，支持从 PHP 版 Typecho 直接迁移数据。

---

## 功能特性

**前台**：文章列表 / 分类 / 标签 / 作者 / 搜索归档（FTS5 全文检索，短词自动回退 LIKE）、嵌套评论（Gravatar 头像）、RSS 2.0 / Atom 1.0 / RSS 1.0、文章密码保护、响应式默认主题

**管理后台**：文章 & 页面编辑管理、评论审核、媒体管理（R2 拖放上传）、用户管理（5 种角色）、主题切换、插件管理（启用/禁用/配置）、任务队列观测、全站设置、安装向导

**系统**：主题系统（npm 包分发）、插件系统（30+ 已接入 Hook，支持懒加载）、PHP 版 Typecho 数据迁移工具、PBKDF2-SHA256 认证、CSRF 防护、安全响应头、请求体限额、R2 上传类型校验

---

## 安装部署

### 一键部署到 Cloudflare

点击上方 **Deploy to Cloudflare** 按钮。Cloudflare 会把本仓库复制到你的 GitHub / GitLab 帐号，按 `wrangler.toml` 自动创建并绑定 D1、R2、任务 Queue，同时配置 [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)：之后每次推送到生产分支都会自动构建部署。

Button/Workers Builds 中保持以下命令即可：Build command 为 `pnpm run build`，Production deploy command 为 `pnpm run deploy`；`pnpm run deploy` 会识别 Cloudflare 提供的 `WORKERS_CI=1`，自动跳过本地 Queue 检查和重复构建，仅执行部署。非生产分支使用 Cloudflare 默认的 `pnpm exec wrangler versions upload`（或等价的 `npx wrangler versions upload`），不要使用生产部署命令。

部署向导会提示填写 `INSTALL_TOKEN`（推荐，可用 `openssl rand -hex 32` 生成）。设置后，打开 Worker URL 的 `/install` 完成站点与管理员初始化时必须填写同一令牌。未设置时仍可安装，但任意先访问 `/install` 的人都能成为首位管理员。

数据表由安装向导在首次提交时创建，不必单独跑 D1 migration。

仓库必须是 **GitHub / GitLab 公开仓库**，Deploy to Cloudflare 按钮才能被他人使用。

### 前置要求

- Node.js **22.12+**
- [pnpm](https://pnpm.io)（`npm install -g pnpm`）
- Cloudflare 帐号（仅部署到 Cloudflare 时需要）

### 本地开发

```bash
git clone https://github.com/eslizn/typecho-cf.git
cd typecho-cf
pnpm install

# 可选：保护本地安装窗口（写入后重启 dev）
# cp .dev.vars.example .dev.vars
# 然后把 INSTALL_TOKEN 改成自己的随机串

pnpm run dev
```

1. 打开 http://localhost:4321 ，未安装时会跳转到 `/install`
2. 填写安装表单：站点名称 / 描述、管理员用户名、密码（至少 12 位）、邮箱；若配置了 `INSTALL_TOKEN`，还需填写安装令牌
3. 提交后完成建表与管理员创建，随后可访问 `/admin` 登录

仓库中的 `wrangler.toml` 只声明绑定名（D1 `DB` / R2 `BUCKET` / Queue `QUEUE`），不含账号专属 ID。本地 `pnpm run dev` 使用 Miniflare 模拟存储，不必改这个文件。密钥写在 `.dev.vars`（已 gitignore）。

### 命令行部署到 Cloudflare

不必先 `d1 create` / 填写 `database_id`。Wrangler 会按绑定名自动创建 D1（`typecho-cf-db`）和 R2（`typecho-cf-uploads`），并记在你的 Cloudflare 账号上。

```bash
pnpm exec wrangler login
pnpm exec wrangler secret put INSTALL_TOKEN   # 推荐；未设置时任意先访问 /install 的人都能成为首位管理员
pnpm run deploy
```

本地执行 `pnpm run deploy` 会在构建和部署前读取当前 Wrangler 配置，幂等确认任务
Queue `typecho-cf-tasks`；缺失时通过项目锁定版本的 Wrangler 自动创建，已存在的资源
不会删除或重建。Button/Workers Builds 路径由
Cloudflare 负责创建配置中声明的资源，`pnpm run deploy` 在该环境只执行部署。若只想
检查构建和部署配置，可执行 `pnpm run deploy -- --dry-run`，该模式不会创建 Queue。

如需在同一 Cloudflare 账户部署多个实例，请手动修改 `wrangler.toml` 中 producer 的
`queue`、consumer 的 `queue` 以及 `[vars]` 中的 `QUEUE_NAME`，为当前实例设置唯一名称，
并保持 producer 与 consumer 使用同一个任务 Queue。`pnpm run deploy` 和 Button/Workers
Builds 都会按修改后的 Wrangler 配置工作。

登录后台后，管理员可在「管理 → 队列」查看任务 Queue 的近实时积压指标。默认通过 Worker
`QUEUE` binding 读取，不需要 API 凭据。若要查看账户级 Queue 配置和 consumer 配置，可在
Cloudflare 中创建仅含 Queues Read 权限的 API Token，并以 secret 配置账户 ID 和令牌：

```bash
pnpm exec wrangler secret put CF_ACCOUNT_ID
pnpm exec wrangler secret put CF_API_TOKEN
```

这两个 secret 均为可选；未配置时页面仍可显示 `QUEUE` binding 的实时指标。当前部署未配置
死信队列，消息达到最大重试次数后会被 Cloudflare 丢弃。页面不拉取、租约、删除或重放消息，
也不记录单条任务的运行中/已完成历史。

从旧版双 Queue 部署升级时，普通 `pnpm run deploy` 不会自动删除旧的
`typecho-cf-tasks-dlq`，以免误删仍在等待的消息。确认不再需要旧 Queue 后，在项目根目录执行：

```bash
pnpm run queues:cleanup-legacy -- --confirm typecho-cf-tasks-dlq
```

该命令只允许删除这个固定的旧 Queue，并会先检查当前 Wrangler 配置没有继续引用它；
命令仍会由 Wrangler 显示最终确认提示。Button/Workers Builds 不会自动执行此清理。

访问 Worker URL → `/install` → 填写站点与管理员信息（及 `INSTALL_TOKEN`）→ 登录 `/admin`。

首次 `wrangler deploy` 可能会把生成的 `database_id` 写回 `wrangler.toml`。不要提交这次改动（`git checkout -- wrangler.toml`）；之后部署仍会绑定到同一资源。若要用别的库名或桶名，再改 `database_name` / `bucket_name`。

---

## 命令参考

| 命令 | 说明 |
|------|------|
| `pnpm run dev` | 本地开发服务器 |
| `pnpm run build` | 生产构建 |
| `pnpm run deploy` | 本地：幂等创建任务 Queue + 构建 + 部署；Workers Builds：仅部署 |
| `pnpm run queues:ensure` | 按当前 Wrangler 配置幂等创建任务 Queue |
| `pnpm run queues:cleanup-legacy` | 在显式确认后删除旧版遗留的 `typecho-cf-tasks-dlq` |
| `pnpm run reinstall:extensions` | 刷新所有已声明插件和主题的本地依赖快照 |
| `pnpm run lint` | 类型感知静态检查（含浮空 Promise） |
| `pnpm run types:workers` | 按 Wrangler 配置生成 Worker 绑定与运行时类型 |
| `pnpm run typecheck` | 生成 Workers / Astro 类型并运行 TypeScript 检查 |
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

修改 `src/plugins/` 或 `src/themes/` 下的源码后，如果对应依赖使用 `file:` 协议，运行
`pnpm run reinstall:extensions` 刷新已声明的插件/主题依赖快照，再运行
`pnpm run build`。该命令只删除项目生成的 `node_modules`，然后执行
`pnpm install --force --frozen-lockfile`，不删除源码，也不会通过 `pnpm update`
升级无关依赖或改写锁文件。

修改 `wrangler.toml` 中的绑定后，运行 `pnpm run types:workers`。生成的 `worker-configuration.d.ts` 仅供本地与 CI 使用，不纳入版本控制。

示例配置默认持久化可搜索 Workers Logs，并以约 1% 采样率记录调用链；生产环境可按流量与成本调整。密钥使用 `wrangler secret put`（本地可用 `.dev.vars`），不要写入已跟踪的配置文件。

---

## 从 PHP 版 Typecho 迁移

```bash
# 迁移到 Cloudflare（生产）
pnpm run db:migrate:cloudflare \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads

# 迁移到本地（开发）
pnpm run db:migrate:local \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads

# 预览（不写入）
pnpm run db:migrate:dry-run \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--source`, `-s` | 源 SQLite 数据库路径 | （必填） |
| `--uploads`, `-u` | 源 `usr/uploads/` 目录；省略时只迁移数据库 | （可选） |
| `--prefix` | 源表前缀 | `typecho_` |
| `--dry-run`, `-n` | 预览模式 | `false` |
| `--site-url` | 新站点 URL（用于重写附件 URL） | — |
| `--d1-name` | D1 数据库名 | `typecho-cf-db` |
| `--r2-bucket` | R2 存储桶名 | `typecho-cf-uploads` |

密码哈希算法不兼容（PHP phpass → PBKDF2-SHA256），迁移后需重置密码：

```bash
pnpm run reset-password              # 本地
pnpm run reset-password:cloudflare   # Cloudflare
```

---

## 插件开发

参考 [插件开发规范](src/plugins/README.md)。

核心不提供邮件发送、评论邮件通知或忘记密码邮件入口；需要邮件能力时由插件自行提供。用户资料和评论中的邮箱字段仍可正常使用。

---

## 主题开发

参考 [主题开发规范](src/themes/README.md)。

---

## 技术栈

| 组件 | 技术 |
|------|------|
| 框架 | [Astro](https://astro.build) 7.x (SSR) |
| 适配器 | [@astrojs/cloudflare](https://docs.astro.build/en/guides/integrations-guide/cloudflare/) 14.x |
| 运行时 | [Cloudflare Workers](https://workers.cloudflare.com) |
| 数据库 | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite) |
| ORM | [Drizzle ORM](https://orm.drizzle.team) 0.45.x |
| 文件存储 | [Cloudflare R2](https://developers.cloudflare.com/r2/) |
| 语言 | TypeScript 7.x |
| 测试 | [Vitest](https://vitest.dev) 4.x |
| 包管理 | pnpm |

---

## 安全与测试约束

- 管理 API 必须通过 `requireAdminAction()` 做登录、权限与 CSRF 校验；重定向回后台页面必须使用同源且仅限 `/admin` 路径的安全回跳。
- 评论来源与评论提交后的回跳只按 URL `origin` 判定可信来源，禁止用字符串前缀或仅 host 比较。
- 前台、后台、插件路由和缓存命中的响应都由中间件补齐基础安全响应头。
- 新增功能和 bug 修复必须补对应回归测试，并同时通过 `pnpm run test` 与 `pnpm run typecheck`。

---

## 与 PHP 版 Typecho 兼容性

| 方面 | 状态 |
|------|------|
| 数据库结构 | ✅ 7 张核心表兼容；运行时会幂等补齐登录限速和密码重置辅助表 |
| 默认主题样式 | ✅ CSS & HTML 结构保持一致 |
| URL 结构 | ✅ 路由规则与 Typecho 默认配置一致 |
| 密码哈希 | ⚠️ 迁移后需重置密码（算法不同） |
| PHP 主题 / 插件 | ❌ 需按新格式重新封装（TypeScript / npm 包） |

---

## 许可证

MIT

---

## 开发指南

- 插件开发规范：[src/plugins/README.md](src/plugins/README.md)
- 主题开发规范：[src/themes/README.md](src/themes/README.md)
- AI Agent 开发规范：[AGENTS.md](AGENTS.md)
