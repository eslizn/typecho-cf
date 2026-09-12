# AI (typecho-plugin-ai)

Typecho-CF 的 AI 能力插件：把多个 OpenAI 兼容 Provider/模型收敛成通用的对话能力，另提供一个可选的 OpenAI 兼容 HTTP 端点。

## Capability

| Capability | 版本 | 说明 |
|------------|------|------|
| `ai.chat.generate` | 1 | 对话生成。请求/响应类型见 `types.ts`，实现由 `createAiChatService()` 提供 |
| `ai.models.list` | 1 | 发布可选的对话模型清单：**只包含已设置 `alias`**、已启用、支持文本对话且 `baseUrl` 为公网 HTTPS 的模型；按别名跨 Provider 合并去重。服务实现 `listOptions(): Array<{ value, label? }>` |

`ai.image.generate`、`ai.audio.speech.generate`、`ai.audio.transcribe`、`ai.embeddings.create` 是预留 ID，不代表已有实现。

消费方（例如 Scribe）只依赖上述能力契约：不 import 本插件，也不直接读取 `plugin:typecho-plugin-ai` 配置。

## 配置

- `providers[].baseUrl` 必须是公网 HTTPS（拒绝 IP 字面量、私网域名，以及带凭据、查询串或片段的 URL）
- `providers[].models[].alias` 决定公开名：设置别名后**上游模型名不再被接受**；未设置别名的模型不会出现在 `ai.models.list`，也不会出现在 `GET {basePath}/v1/models`
- 保存配置时会对启用模型做 `/models` 校验（并行、有超时与总预算上限，失败会阻止保存）
- `http.*` 控制下面这个可选的 HTTP 兼容端点

## HTTP 兼容端点（可选）

启用后（`http.enabled` 开启，路径由 `http.basePath` 决定，默认 `/ai`）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `{basePath}/v1/models` | 列出已发布的模型别名 |
| POST | `{basePath}/v1/chat/completions` | OpenAI 兼容对话，支持 `stream: true`（SSE） |

- 鉴权：`Authorization: Bearer <token>`，token 在插件配置页生成（16–128 位 `A-Za-z0-9_-`，最多 20 个）
- **token 列表为空时端点一律不可达**（返回 401）：删除全部 token 即关闭外部访问
- 签名比较使用常量时间实现，并遍历完全部 token 后才给出结果，不泄漏匹配位置
- 路径必须精确匹配；同一 basePath 下的其他路径会交回核心路由（不会回 `AI` 专属错误）
- 路径带尾斜杠**不匹配**
- 中间件对携带 `Authorization` 的请求禁用边缘缓存（读与写都跳过），避免缓存绕过 Bearer 鉴权
- capability 解析失败时返回 503：带 `Authorization` 的调用方会拿到具体原因（`unavailable` / `ambiguous` / `version-mismatch` / `factory-failed`），匿名探测只拿到笼统错误码；同时输出 `ai_http_capability_unavailable` 结构化日志

### 已知限制（有意为之）

- 失败鉴权的计数窗口与「同时进行的生成数」上限（4）都是 **isolate 内存级**，不跨 PoP/isolate 共享；只有核心登录限流走 D1（`typecho_login_failures`）。Bearer token 熵足够高，这里的内存级限制只用于抬高爆破成本与保护本 isolate 的上游预算，不作为强安全边界
- 流式响应头为 `Cache-Control: no-cache, no-store`

## 文件

| 文件 | 作用 |
|------|------|
| `index.ts` | 插件入口：注册 capability、路由声明、`plugin:config:beforeSave`、`request:route` |
| `provider.ts` | 配置归一化/校验、模型选举（`selectAiModel`）、模型目录（`listChatModelOptions`） |
| `chat.ts` | `ai.chat.generate` 实现：请求转换、上游调用、流式解析 |
| `http.ts` | 可选的 OpenAI 兼容 HTTP 端点 |
| `io.ts` | 有界读取 / 超时竞态 / base64 等共享工具 |
| `types.ts` | 能力契约与配置字段定义 |
