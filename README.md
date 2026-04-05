# Typecho-CF

[English](README.en.md) | 中文

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

插件通过 npm 包分发，以 Hook 机制扩展系统功能。

**快速开始**：参考 [插件开发规范](src/plugins/README.md)（含完整 Props 接口、Hook 点列表和 captcha 示例）。

### 最小插件结构

```
typecho-plugin-example/
├── package.json   # keywords 必须包含 ["typecho", "plugin"]
├── plugin.json    # 插件元数据（含可选配置声明）
└── index.js       # ESM 入口，export default function init({ addHook, pluginId }) {}
```

### Hook 示例

```javascript
export default function init({ addHook, pluginId }) {
  // filter 钩子：修改渲染后的 HTML
  addHook('content:content', pluginId, (html) => {
    return html + '<!-- by example plugin -->';
  });

  // call 钩子：评论提交后通知
  addHook('feedback:finishComment', pluginId, (comment) => {
    console.log('new comment:', comment.coid);
  });
}
```

### 安装插件

```bash
pnpm add typecho-plugin-example
pnpm run build
```

---

## 主题开发

主题通过 npm 包分发，可提供完整自定义模板或仅覆盖 CSS。

**快速开始**：参考 [主题开发规范](src/themes/README.md)（含完整 Props 类型和 minimal 示例）。

### 最小主题结构

```
typecho-theme-example/
├── package.json   # keywords 必须包含 ["typecho", "theme"]
├── theme.json     # 主题元数据（样式表声明）
├── style.css      # 主样式
└── components/    # 可选：自定义 Astro 模板组件
    ├── Index.astro
    ├── Post.astro
    ├── Page.astro
    ├── Archive.astro
    └── NotFound.astro
```

### 安装主题

```bash
pnpm add typecho-theme-example
pnpm run build
# 然后在管理后台「外观」页面切换
```

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
