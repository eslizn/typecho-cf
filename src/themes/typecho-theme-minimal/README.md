# Typecho Minimal

Typecho 经典默认主题，简洁优雅的两栏博客布局。

## 模板组件

| 组件 | 文件 | 用途 |
|------|------|------|
| Index | `components/Index.astro` | 首页文章列表，含分页、侧边栏 |
| Post | `components/Post.astro` | 文章详情页，含评论、前后导航、密码保护 |
| Page | `components/Page.astro` | 独立页面，含评论 |
| Archive | `components/Archive.astro` | 归档页（分类/标签/作者/搜索），含分页 |
| NotFound | `components/NotFound.astro` | 404 页面 |
| CommentList | `components/CommentList.astro` | 嵌套评论列表（被 Post/Page 引用） |

## 样式文件

| 文件 | 加载顺序 | 用途 |
|------|---------|------|
| `normalize.css` | ① | CSS Reset，跨浏览器一致性 |
| `grid.css` | ② | 响应式网格布局系统 |
| `style.css` | ③ | 主题主样式（排版、配色、组件样式） |

加载顺序由 `theme.json` 的 `stylesheets` + `stylesheet` 控制，系统自动注入 `<link>` 标签。

## 模板覆盖

如果子主题的 `components/` 目录缺少某个组件文件（如未提供 `Archive.astro`），系统自动回退到本主题的同名组件。

## 功能特性

- **响应式布局** — 基于 `grid.css` 的流式网格，适配桌面/平板/手机
- **嵌套评论** — 支持无限层级回复，递归渲染 `CommentList`
- **密码保护** — 支持文章/页面密码访问，未验证时展示密码输入表单
- **前后导航** — 文章详情页底部展示上一篇/下一篇链接
- **侧边栏** — 展示最近文章、最近评论、分类列表、归档链接
- **插件兼容** — 自动渲染 `extra.headSnippets` 和 `extra.bodySnippets`（来自激活插件的 `archive:header`/`archive:footer` hook）
- **Gravatar 头像** — 评论列表展示 Gravatar 头像
- **RSS/Feed 自动发现** — `<head>` 包含 feed 自动发现链接

## 主题配置

主题为纯 CSS + 模板组件主题，无独立配置项。站点级配置（标题、描述、时区等）通过 Typecho 系统设置管理。

## Props 接口

各组件接收的 props 定义在 `src/lib/theme-props.ts`：

- `Index.astro` → `ThemeIndexProps`（posts, pagination, sidebarData...）
- `Post.astro` → `ThemePostProps`（post, author, categories, tags, comments, prevPost, nextPost...）
- `Page.astro` → `ThemePageProps`（page, comments...）
- `Archive.astro` → `ThemeArchiveProps`（archiveTitle, archiveType, posts, pagination...）
- `NotFound.astro` → `ThemeNotFoundProps`（statusCode, errorTitle...）

所有组件共享 `ThemeBaseProps`（options, urls, user, isLoggedIn, pages, sidebarData, currentPath）。
