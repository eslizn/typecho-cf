# 插件开发规范

> 本文档是 Typecho-CF 插件开发的完整参考。以 `typecho-plugin-captcha/` 目录为示例。

[English](README.en.md)

---

## 目录结构

```
typecho-plugin-example/
├── package.json     # npm 包声明（keywords 必须包含 typecho + plugin）
├── plugin.json      # 插件元数据（含可选配置声明）
└── index.js         # 入口文件（ESM，export default init 函数）
```

> 使用 TypeScript 时入口可为 `index.ts`，发布前编译成 `.js`。本地开发直接用 `.js` 可省去编译步骤。

---

## package.json

```json
{
  "name": "typecho-plugin-example",
  "version": "1.0.0",
  "description": "插件描述",
  "keywords": ["typecho", "plugin"],
  "author": "Your Name",
  "license": "MIT",
  "type": "module",
  "main": "index.js"
}
```

**关键约束**：
- `keywords` 必须同时包含 `"typecho"` 和 `"plugin"`，否则构建时不会被发现
- `"type": "module"` — 使用 ESM（`export default`，不用 `module.exports`）
- `main` 指向编译后的入口文件

---

## plugin.json

```json
{
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
```

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

声明了 `config` 后，管理插件列表中自动显示「设置」链接，跳转到 `/admin/plugin-config?id=<pluginId>`。

---

## index.js 入口

```javascript
/**
 * 插件入口函数，由系统在构建时调用。
 * 所有 Hook 注册通过 addHook 完成，此处不要执行 I/O。
 */
export default function init({ addHook, pluginId }) {
  // filter 钩子：修改数据并返回
  addHook('content:content', pluginId, (html) => {
    return html + '<!-- powered by example plugin -->';
  });

  // call 钩子：执行副作用，不需要返回值
  addHook('feedback:finishComment', pluginId, (comment) => {
    console.log('新评论：', comment.coid);
  });
}
```

### 参数说明

| 参数 | 类型 | 说明 |
|------|------|------|
| `addHook(point, pluginId, handler, priority?)` | function | 注册钩子处理函数。`priority` 默认 10，越小越早执行 |
| `pluginId` | string | 当前插件 ID（来自 `plugin.json` 的 `id` 字段） |

---

## 读取插件配置

在 filter/call 处理函数中，从传入的 `extra.options` 读取配置：

```javascript
// 主项目内的插件可 import loadPluginConfig from '@/lib/plugin'
// 独立 npm 插件自行解析（参考 captcha 示例）

addHook('feedback:comment', pluginId, async (commentData, extra) => {
  if (!extra?.options) return commentData;

  // 读取本插件配置（已与 plugin.json 默认值合并）
  const raw = extra.options[`plugin:${pluginId}`];
  const config = raw ? JSON.parse(raw) : {};

  if (!config.apiKey) return commentData;  // 未配置，跳过

  // ... 业务逻辑
  return commentData;
});
```

配置存储：`typecho_options` 表，`name = "plugin:<pluginId>"`，值为 JSON 字符串。

---

## 完整 Hook 参考

### call 类型（副作用，无需返回值）

| Hook | 触发位置 | 参数 |
|------|---------|------|
| `system:begin` | 每次请求初始化 | `(context)` |
| `admin:header` | 管理后台 `<head>` | — |
| `admin:footer` | 管理后台底部 | — |
| `admin:navBar` | 管理后台导航 | — |
| `admin:writePost:option` | 文章编辑器侧边栏选项 | `(post)` |
| `admin:writePost:advanceOption` | 文章编辑器高级选项 | `(post)` |
| `admin:writePost:bottom` | 文章编辑器底部区域 | `(post)` |
| `admin:writePage:option` | 页面编辑器侧边栏选项 | `(page)` |
| `admin:writePage:advanceOption` | 页面编辑器高级选项 | `(page)` |
| `admin:writePage:bottom` | 页面编辑器底部区域 | `(page)` |
| `post:finishPublish` | 文章发布后 | `(post)` |
| `post:finishSave` | 文章保存后 | `(post)` |
| `post:delete` | 文章删除前 | `(post)` |
| `post:finishDelete` | 文章删除后 | `(cid)` |
| `page:finishPublish` | 页面发布后 | `(page)` |
| `page:finishSave` | 页面保存后 | `(page)` |
| `page:delete` | 页面删除前 | `(page)` |
| `page:finishDelete` | 页面删除后 | `(cid)` |
| `feedback:finishComment` | 评论保存后 | `(comment)` |
| `upload:beforeUpload` | 文件上传前 | `(file)` |
| `upload:upload` | 文件上传后 | `(file)` |
| `upload:delete` | 文件删除 | `(path)` |

### filter 类型（必须返回值）

| Hook | 触发位置 | 参数 | 说明 |
|------|---------|------|------|
| `content:markdown` | Markdown 渲染前 | `(markdown, post)` | 过滤原始 Markdown 文本 |
| `content:content` | Markdown 渲染后 | `(html, post)` | 过滤输出 HTML |
| `content:title` | 标题输出 | `(title, post)` | 过滤文章标题 |
| `content:excerpt` | 摘要输出 | `(excerpt, post)` | 过滤文章摘要 |
| `comment:content` | 评论内容输出 | `(html, comment)` | 过滤评论 HTML |
| `comment:markdown` | 评论 Markdown | `(markdown, comment)` | 过滤评论原始文本 |
| `post:write` | 文章保存前 | `(data, extra)` | 过滤文章写入数据 |
| `page:write` | 页面保存前 | `(data, extra)` | 过滤页面写入数据 |
| `feedback:comment` | 评论保存前 | `(commentData, extra)` | 验证/修改评论，设置 `_rejected` 可拒绝 |
| `feed:item` | RSS/Atom 生成 | `(item, post)` | 过滤 feed 条目 |
| `widget:sidebar` | 侧边栏渲染 | `(sidebarData, context)` | 过滤侧边栏数据 |

---

## 拒绝评论

在 `feedback:comment` filter 中，设置 `commentData._rejected` 可拒绝评论：

```javascript
addHook('feedback:comment', pluginId, async (commentData, extra) => {
  if (spamDetected) {
    commentData._rejected = '检测到垃圾评论';  // 非空字符串 = 拒绝，返回 403
  }
  return commentData;
});
```

---

## 向主题提供客户端代码

插件可通过 `archive:header` 和 `archive:footer` filter 自动向前端页面注入 HTML/JS，无需主题手动适配：

```javascript
// index.js
export default function init({ addHook, pluginId }) {
  // 注入 <head> 内容（如 SDK 脚本）
  addHook('archive:header', pluginId, (headHtml, extra) => {
    const config = getPluginConfig(extra?.options);
    if (!config.sitekey) return headHtml;
    return headHtml + '<script src="..."></script>';
  });

  // 注入 </body> 前内容（如交互脚本）
  addHook('archive:footer', pluginId, (bodyHtml, extra) => {
    const config = getPluginConfig(extra?.options);
    if (!config.sitekey) return bodyHtml;
    return bodyHtml + '<script>/* ... */</script>';
  });
}
```

`Base.astro` 布局会自动调用 `getClientSnippets(options)` 收集所有激活插件的注入内容，主题无需任何额外代码。

---

## 安装到项目

### 本地开发（工作区包）

1. 将插件目录放在 `src/plugins/` 下
2. 在根 `package.json` 的 `workspaces` 中添加路径（如已有 `src/plugins/*` 则自动包含）
3. 运行 `pnpm install`
4. 重新执行 `pnpm run build`

### npm 发布后安装

```bash
pnpm add typecho-plugin-example
pnpm run build
```

---

## 参考示例

`typecho-plugin-captcha/` 目录演示了：
- `plugin.json` 配置声明（6 种字段类型）
- `feedback:comment` filter 钩子（token 验证 + 评论拒绝）
- 读取插件配置（含 DEFAULTS fallback）
- 具名导出 `getClientSnippet()` 供主题集成
- 正确提取客户端 IP（优先 CF-Connecting-IP）
