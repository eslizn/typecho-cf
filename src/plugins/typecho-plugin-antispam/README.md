# AntiSpam

Typecho-CF 本地反垃圾评论插件，基于蜜罐陷阱 + 时间验证 + 链接检测三层过滤，无需外部 API。

## 功能

- **蜜罐陷阱** — 在评论表单中注入 CSS 隐藏字段，机器人自动填充后触发拦截
- **时间验证** — 表单加载时生成 HMAC 签名的时间令牌，验证提交耗时是否在合理范围
- **链接检测** — 统计评论内容中的 URL 数量，超出阈值后拦截
- **多模式处置** — 支持 垃圾箱 / 待审核 / 丢弃 三种处置方式

## 配置参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `mode` | select | `spam` | 处置方式：`spam` 垃圾箱、`waiting` 待审核、`discard` 直接丢弃 |
| `honeypot` | checkbox | 开启 | 启用蜜罐陷阱检测 |
| `timeCheck` | checkbox | 开启 | 启用表单提交时间验证 |
| `minTime` | text | `3` | 最短提交时间（秒），拦截秒填机器人 |
| `maxTime` | text | `86400` | 最长有效时间（秒），默认 24 小时 |
| `linkCheck` | checkbox | 关闭 | 启用链接数量检测 |
| `maxLinks` | text | `2` | 允许的最大链接数，0 表示不允许任何链接 |

## 工作流程

```
用户访问评论页面
  → archive:footer hook 注入蜜罐 HTML + 时间令牌（HMAC-SHA256）
  → 用户填写表单期间令牌持续计时
用户提交评论
  → feedback:comment hook 触发
  → 已登录用户跳过所有检测
  → ① 蜜罐检测：隐藏字段有值 → 拦截
  → ② 时间检测：令牌缺失/过期/提交过快 → 拦截
  → ③ 链接检测：URL 数量超限 → 拦截
  → 根据 mode 设置处置方式（status=spam/waiting 或 _rejected 拒绝）
```

## 注册的 Hook

| Hook | 类型 | 用途 |
|------|------|------|
| `feedback:comment` | filter | 评论提交时执行三层检测，设置 spam/waiting/rejected |
| `archive:footer` | filter | 评论页面注入蜜罐 HTML 和 HMAC 时间令牌 |

## 依赖

无外部 API 依赖，完全本地运行。令牌签名依赖站点的 `secret` 配置项和 Web Crypto API。
