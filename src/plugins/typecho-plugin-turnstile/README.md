# Turnstile

Typecho-CF Cloudflare Turnstile 验证码插件，集成 Cloudflare Turnstile 保护评论和登录。

## 功能

- **评论验证** — 评论提交时要求完成 Turnstile 人机验证
- **登录保护** — 管理后台登录页面集成 Turnstile 验证
- **外观模式** — 支持始终显示 / 编程式调用 / 仅交互时显示
- **主题/尺寸** — 支持自动/浅色/深色主题，正常/紧凑尺寸
- **已登录用户豁免** — 评论场景下已登录用户自动跳过验证

## 配置参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `sitekey` | text | — | Cloudflare Turnstile Site Key，[申请地址](https://dash.cloudflare.com/?to=/:account/turnstile) |
| `secret` | password | — | Cloudflare Turnstile Secret Key；保存后由通用配置页掩码，不回显原文 |
| `input` | text | `cf-turnstile-response` | 验证 token 的字段名 |
| `appearance` | select | `always` | 外观模式：始终显示 / 编程式调用 / 仅交互时显示 |
| `theme` | select | `auto` | 主题：自动 / 浅色 / 深色 |
| `size` | select | `normal` | 尺寸：正常 / 紧凑 |

## 工作流程

```
前端页面加载
  → frontend:head hook 注入 Turnstile SDK + 状态管理 JS + 样式
  → frontend:footer hook 注入 Turnstile Widget HTML
  → admin:login:head / admin:login:form hook 同理会注入登录页面
  → only on pages that have comments (pageContext.hasComments)

用户提交评论
  → comment:beforeSave hook 触发
  → 已登录用户跳过
  → 检查 Widget token 是否存在 → 不存在则提示"请完成人机验证"
  → 调用 Cloudflare /siteverify API 验证 token
  → 失败则 _rejected → 403

用户登录
  → user:login:before hook 触发
  → 同上验证流程（登录场景不跳过已登录用户）
```

## 注册的 Hook

| Hook | 类型 | 用途 |
|------|------|------|
| `csp:directives` | filter | 为 Turnstile SDK、验证请求和 iframe 追加 CSP 来源 |
| `comment:beforeSave` | filter | 评论提交时验证 Turnstile token |
| `frontend:head` | filter | 评论页面 `<head>` 注入 SDK 和状态管理 JS |
| `frontend:footer` | filter | 评论页面注入 Widget HTML |
| `admin:login:head` | filter | 登录页 `<head>` 注入 SDK |
| `admin:login:form` | filter | 登录表单注入 Widget |
| `user:login:before` | filter | 登录请求验证 Turnstile token |

## 依赖

- Cloudflare Turnstile 服务（免费）
- `challenges.cloudflare.com/turnstile/v0/api.js`（前端 SDK）
- `challenges.cloudflare.com/turnstile/v0/siteverify`（验证 API）

## 备注

可与其他反垃圾插件（如 AntiSpam）同时使用，Turnstile 在提交时先执行。
