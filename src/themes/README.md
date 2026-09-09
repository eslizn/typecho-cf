# 主题开发规范

> 本文档是 Typecho-CF 主题开发的完整参考。以 `typecho-theme-minimal/` 目录为示例。

[English](README.en.md)

---

## 目录结构

```
typecho-theme-example/
├── package.json        # npm 包声明（keywords 必须包含 typecho + theme）
├── theme.json          # 可选：主题元数据（也可用 package.json 的 typecho.theme）
├── style.css           # 主样式表
├── locales/             # 可选：主题内部翻译件（如 en.json、zh-CN.json）
└── components/         # 可选：自定义模板组件
    ├── Index.astro     # 首页（文章列表）
    ├── Post.astro      # 文章详情
    ├── Page.astro      # 独立页面
    ├── Archive.astro   # 归档页（分类/标签/作者/搜索）
    └── NotFound.astro  # 404 页
```

无 `components/` 目录时为纯 CSS 主题，系统自动回退到默认主题的模板组件。

---

## 主题内部多语言

主题可以在 `locales/<locale>.json` 中提供自己的翻译件，例如 `locales/en.json` 和 `locales/zh-CN.json`。主题组件从公共 Props 取得同形态的 `i18n`：

```astro
---
import Base from '@/layouts/Base.astro';
import type { ThemeIndexProps } from '@/lib/theme-props';

const { options, urls, user, isLoggedIn, pluginCtx, i18n } = Astro.props as ThemeIndexProps;
---
<Base options={options} urls={urls} user={user} isLoggedIn={isLoggedIn} pluginCtx={pluginCtx} i18n={i18n}>
  <button aria-label={i18n.t('theme.search.submit', {}, 'Search')}>
    {i18n.t('theme.search.submit', {}, 'Search')}
  </button>
</Base>
```

查找顺序是当前主题翻译件 → 全局（核心和激活插件）翻译件 → 默认文本。主题翻译件只对当前主题内部生效，不会增加全局语言选项，也不会覆盖管理端、其他主题或插件中的同名 key；主题预览使用被预览主题的作用域。文章、页面、分类、标签、用户名等用户内容不会被自动翻译。

主题翻译值是纯文本，只支持简单的 `{name}` / `{count}` 插值，不解析 ICU。主题自行输出完整 HTML 时仍需自行处理 `<html lang>`、安全转义及插件注入；使用系统 `Base.astro` 时，传入的 `i18n` 会同时用于文档语言和主题布局。

---

## package.json

```json
{
  "name": "typecho-theme-example",
  "version": "1.0.0",
  "description": "主题描述",
  "author": "Your Name",
  "license": "MIT",
  "keywords": ["typecho", "theme"],
  "files": [
    "theme.json",
    "style.css",
    "locales/",
    "components/"
  ]
}
```

**关键约束**：
- `keywords` 必须同时包含 `"typecho"` 和 `"theme"`，否则构建时不会被发现
- `files` 声明要发布的文件（本地开发可省略）

---

## theme.json

```json
{
  "id": "typecho-theme-example",
  "name": "示例主题",
  "description": "主题描述",
  "author": "Your Name",
  "authorUrl": "https://example.com",
  "version": "1.0.0",
  "homepage": "https://github.com/...",
  "license": "MIT",
  "stylesheet": "style.css",
  "stylesheets": ["normalize.css", "grid.css"]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 否 | 主题唯一标识；省略时使用 npm 包名 |
| `name` | 否 | 显示名称；省略时使用 npm 包名 |
| `stylesheet` | 否 | 主 CSS 源文件名，默认 `style.css`；构建产物统一为 `public/themes/{id}/style.css` |
| `stylesheets` | 否 | 额外 CSS 文件列表（按顺序加载，在 `stylesheet` 之前） |
| `config` | 否 | 主题自定义配置字段声明（可选）。声明后管理后台「外观」卡片出现「设置」入口，配置以 JSON 存于 `typecho_options` 的 `theme:<id>` 行 |

> **配置优先级**：`theme.json` > `package.json` 中 `typecho.theme` 字段 > 从 `package.json` 自动推导。无论哪种方式，主 CSS 文件必须存在。

---

## 自定义配置（可选）

主题可以在 `theme.json` 的 `config` 字段中声明自定义参数，管理后台会自动生成设置表单（与插件配置同一套字段类型与存储机制）。**只有声明了非空 `config` 的主题才会显示「设置」入口**，未声明的主题无需任何额外工作。

```json
{
  "id": "typecho-theme-example",
  "name": "示例主题",
  "config": {
    "footerText": {
      "type": "text",
      "label": "页脚附加文字",
      "description": "显示在页脚版权行末尾。",
      "default": ""
    },
    "showSearch": {
      "type": "checkbox",
      "label": "显示搜索框",
      "default": "1"
    },
    "providers": {
      "type": "repeatable",
      "label": "数据源",
      "default": [],
      "itemFields": {
        "provider": { "type": "select", "label": "类型", "options": { "r2": "R2", "s3": "S3" } },
        "endpoint": { "type": "text", "label": "地址", "default": "", "showWhen": { "field": "provider", "value": "s3" } },
        "secret": { "type": "password", "label": "密钥", "default": "" }
      }
    }
  }
}
```

### 字段类型

与插件配置完全一致：`text`、`textarea`、`select`、`radio`、`checkbox`、`password`、`hidden`、`repeatable`。

**扩展属性**：
- `showWhen` — 条件显示，仅适用于 `repeatable.itemFields`。格式：`{ field: "provider", value: "s3" }`，`value` 可为单值或数组
- `optionsSource` — 动态选项源，仅适用于 `select`。当前支持 `"r2Bindings"`（自动读取运行时 R2 binding 名称）
- `itemFields` — 嵌套字段定义，仅适用于 `repeatable`

**boolean 型 select / checkbox**：`select` 的选项值按字符串原样存储（主题没有运行时 hook，不会像插件那样在 `plugin:config:beforeSave` 中把 `"true"` / `"false"` 自动转换为 boolean），模板中需要 boolean 时请自行转换；`checkbox` 未声明 `options` 时是布尔开关，存 `"1"` / `"0"`。

### 读取配置

所有模板组件通过公共 Props `themeConfig` 读取当前激活主题的配置（已合并 manifest 默认值）：

```astro
---
const { options, themeConfig } = Astro.props;
const footerText = typeof themeConfig.footerText === 'string' ? themeConfig.footerText : '';
---
<footer>
  {footerText && <span> · {footerText}</span>}
</footer>
```

未配置任何字段时 `themeConfig` 为空对象 `{}`。`password` / `hidden` 字段的值永远不会通过 API 明文返回（管理表单使用占位符，保存时原样保留）。

### 存储

配置保存到 `typecho_options` 表的 `theme:<themeId>` 行（JSON 字符串），保存时只保留清单中声明的字段（allowlist），并会刷新站点缓存。切换主题不会删除旧主题的配置。

---

## 模板组件 Props

所有模板组件 Props 类型定义在主项目的 `src/lib/theme-props.ts` 中。

### 公共 Props（ThemeBaseProps，所有组件均包含）

```typescript
interface ThemeBaseProps {
  options: SiteOptions;          // 站点配置（timezone 使用 IANA 标识）
  urls: {                        // 计算后的 URL 集合
    siteUrl: string;
    adminUrl: string;
    loginUrl: string;
    logoutUrl: string;
    profileUrl: string;
    feedUrl: string;
    commentsFeedUrl: string;
  };
  user: UserRow | null;          // 当前登录用户（未登录为 null）
  isLoggedIn: boolean;
  pages: Array<{                 // 导航页面列表（状态为 publish 的独立页面）
    title: string;
    slug: string;
    permalink: string;
  }>;
  sidebarData: SidebarData;      // 侧边栏数据（分类、标签、最近文章等）
  currentPath: string;           // 当前请求路径
  pluginCtx: HookContext;        // 当前请求已激活插件集合，传给 Base 布局执行展示 Hook
  themeConfig: Record<string, unknown>;  // 当前激活主题的自定义配置（manifest.config 声明字段，已合并默认值）
  i18n: I18n;                    // 主题作用域翻译器：主题翻译件优先，全局翻译件回退
}
```

### Index.astro（ThemeIndexProps）

```typescript
interface ThemeIndexProps extends ThemeBaseProps {
  posts: PostListItem[];         // 文章列表
  pagination: PaginationInfo;    // 分页信息（currentPage, totalPages, hasPrev, hasNext）
}
```

### Post.astro（ThemePostProps）

```typescript
interface ThemePostProps extends ThemeBaseProps {
  post: {
    cid: number;
    title: string;
    permalink: string;
    content: string;             // 已渲染的 HTML（经过 Hook 过滤）
    created: number;             // Unix 时间戳（秒）
    modified: number | null;
    commentsNum: number;
    allowComment: boolean;
    hasPassword: boolean;        // 是否密码保护
    passwordVerified: boolean;   // 访问者是否已输入正确密码
  };
  author: { uid: number; name: string; screenName: string } | null;
  categories: Array<{ name: string; slug: string; permalink: string }>;
  tags: Array<{ name: string; slug: string; permalink: string }>;
  comments: CommentNode[];
  commentPagination: CommentPagination;
  commentOptions: CommentOptions;
  prevPost: { title: string; permalink: string } | null;
  nextPost: { title: string; permalink: string } | null;
  gravatarMap: Record<number, string>;  // coid → Gravatar URL
}
```

### Page.astro（ThemePageProps）

```typescript
interface ThemePageProps extends ThemeBaseProps {
  page: {
    cid: number;
    title: string;
    slug: string;
    permalink: string;
    content: string;             // 已渲染的 HTML
    created: number;
    allowComment: boolean;
    hasPassword: boolean;
    passwordVerified: boolean;
  };
  comments: CommentNode[];
  commentPagination: CommentPagination;
  commentOptions: CommentOptions;
  gravatarMap: Record<number, string>;
}
```

### Archive.astro（ThemeArchiveProps）

```typescript
interface ThemeArchiveProps extends ThemeBaseProps {
  archiveTitle: string;          // 如 "分类 技术 下的文章"
  archiveType: 'category' | 'tag' | 'author' | 'search' | 'index';
  posts: PostListItem[];
  pagination: PaginationInfo;
}
```

### NotFound.astro（ThemeNotFoundProps）

```typescript
interface ThemeNotFoundProps extends ThemeBaseProps {
  statusCode: number;            // 404
  errorTitle: string;
}
```

### 共享子类型

```typescript
interface PostListItem {
  cid: number;
  title: string;
  permalink: string;
  excerpt: string;               // 渲染后的 HTML 摘要（支持 <!--more-->）
  created: number;
  commentsNum: number;
  author: { uid: number; name: string; screenName: string } | null;
  categories: Array<{ name: string; slug: string; permalink: string }>;
}

interface CommentNode {
  coid: number;
  author: string;
  mail: string;
  url: string;
  text: string;                  // 渲染后的 HTML
  created: number;
  children: CommentNode[];       // 嵌套回复
}

interface CommentPagination {
  enabled: boolean;
  currentPage: number;
  totalPages: number;
  totalComments: number;
  pageSize: number;
  pages: number[];
  pageUrls: Record<number, string>;
  prevUrl: string | null;
  nextUrl: string | null;
}
```

---

## Astro 组件示例

```astro
---
// components/Index.astro
import Base from '@/layouts/Base.astro';
import type { ThemeIndexProps } from '@/lib/theme-props';

type Props = ThemeIndexProps;

const { options, posts, pagination, urls, isLoggedIn, user, pluginCtx, i18n } = Astro.props;
---
<Base options={options} urls={urls} user={user} isLoggedIn={isLoggedIn} pluginCtx={pluginCtx} i18n={i18n}>
  <header>
    <a href={urls.siteUrl}>{options.title}</a>
  </header>

  <main>
    {posts.map(post => (
      <article>
        <h2><a href={post.permalink}>{post.title}</a></h2>
        <Fragment set:html={post.excerpt} />
      </article>
    ))}
  </main>

  {pagination.hasNext && (
    <a href={`/?page=${pagination.currentPage + 1}`}>下一页</a>
  )}
</Base>
```

> 推荐像默认主题一样使用系统 `Base.astro` 并传入 `pluginCtx`。`Base` 负责完整 HTML 外壳、主题样式、Feed 自动发现以及 `frontend:head` / `frontend:footer` 插件注入。主题也可以自行输出完整 HTML，但届时必须自行链接样式并处理这些集成功能。系统只负责通过构建时虚拟模块选择组件，不会自动在外层包裹布局。

---

## 样式加载机制

系统 `Base.astro` 会在 `<head>` 中注入以下 `<link>` 标签（基于主题 manifest）：

```html
<!-- stylesheets 列表（按顺序） -->
<link rel="stylesheet" href="/themes/typecho-theme-example/normalize.css">
<link rel="stylesheet" href="/themes/typecho-theme-example/grid.css">
<!-- 主样式 stylesheet -->
<link rel="stylesheet" href="/themes/typecho-theme-example/style.css">
```

> 使用 `Base.astro` 的主题不需要自行 `<link>`；输出独立 HTML 外壳的主题需要自行处理。

---

## 安装到项目

### 本地开发（工作区包）

1. 将主题目录放在 `src/themes/` 下
2. 在根 `package.json` 的 `dependencies` 中添加 `"<packageName>": "file:src/themes/<packageName>"`
3. 运行 `pnpm install`
4. 重新执行 `pnpm run build`
5. 在管理后台「外观」页面切换到新主题

### npm 发布后安装

```bash
pnpm add typecho-theme-example
pnpm run build
```

---

## 参考示例

`typecho-theme-minimal/` 目录演示了：
- `theme.json` 多样式表声明（`normalize.css` + `grid.css` + `style.css`）
- 完整 5 个模板组件（含嵌套评论列表 `CommentList.astro`）
- `ThemePostProps` 所有字段的使用（密码保护、评论嵌套回复、前后篇导航）
- `sidebarData` 渲染（最近文章、最近评论、分类、归档）
- 插件客户端代码集成（`getClientSnippet`）
