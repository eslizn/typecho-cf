# WeChat Publisher

Typecho-CF 微信公众号同步插件，将文章同步到微信公众号草稿箱，自动处理 Markdown → 微信 HTML 转换和图片上传。

## 功能

- **一键同步** — 文章列表每篇文章旁显示「同步到微信」按钮
- **Markdown 转换** — 自动将 Markdown 转为微信公众号兼容 HTML（`sanitize-html` 白名单过滤）
- **封面图处理** — 自动提取文章第一张图片作为封面，支持默认封面兜底
- **正文图片上传** — 将正文中的图片上传为微信永久素材并替换 URL
- **草稿管理** — 首次同步创建草稿，再次同步更新草稿
- **原文链接** — 可选择附带站内永久链接或留空

## 配置参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `appId` | text | — | 微信公众号开发者 AppID |
| `appSecret` | password | — | 微信公众号开发者 AppSecret |
| `author` | text | — | 默认作者名，留空使用文章作者显示名 |
| `defaultCoverUrl` | text | — | 文章无图片时使用的封面图 URL（草稿必须包含封面） |
| `sourceUrlMode` | select | `permalink` | 原文链接：使用站内永久链接 / 不填写 |
| `needOpenComment` | select | 关闭 | 公众号评论开关 |
| `onlyFansCanComment` | select | 否 | 仅粉丝可评论 |

## 工作流程

```
配置保存
  → plugin:config:beforeSave hook 触发
  → 调用微信 /cgi-bin/token 获取 access_token 验证 appId/appSecret
  → 失败则阻止保存

文章列表页面
  → admin:managePosts:titleActions hook 注入「同步到微信」链接
  → admin:footer hook 注入点击处理 JS

用户点击同步
  → plugin:<id>:action hook 触发（action=sync）
  → ① 获取微信 access_token
  → ② 读取文章数据（标题、正文、附件）
  → ③ 上传封面图（thumb）→ 获取 media_id
  → ④ 提取正文图片 → 逐张上传微信永久素材 → 替换 URL
  → ⑤ Markdown → 微信兼容 HTML（sanitize 白名单过滤）
  → ⑥ 检查是否已有草稿（通过文章 slug 匹配）
    → 已有：调用 /cgi-bin/draft/update 更新
    → 没有：调用 /cgi-bin/draft/add 创建
  → 返回结果（含 media_id、上传图片数）
```

## 注册的 Hook

| Hook | 类型 | 用途 |
|------|------|------|
| `admin:managePosts:titleActions` | filter | 文章列表标题旁注入同步按钮 |
| `admin:footer` | filter | 注入同步按钮的点击处理 JS |
| `plugin:config:beforeSave` | filter | 保存前验证微信 AppID/AppSecret |
| `plugin:<id>:action` | action | 处理同步操作 |

## 依赖

- 微信公众号开发者账号（服务号或订阅号）
- 微信 API：`api.weixin.qq.com`
  - `/cgi-bin/token` — 获取 access_token
  - `/cgi-bin/draft/add` — 创建草稿
  - `/cgi-bin/draft/update` — 更新草稿
  - `/cgi-bin/material/add_material` — 上传永久素材
  - `/cgi-bin/media/uploadimg` — 上传图文图片
- `sanitize-html`（HTML 白名单过滤）
