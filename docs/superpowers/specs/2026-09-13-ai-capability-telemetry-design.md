# AI 能力层与 Scribe 遥测展示设计

## 状态

待用户评审。本文扩展了 Scribe 实时任务与 Token 速率展示需求，目标是把 `typecho-plugin-ai` 建设为可供多个插件消费的站点级 AI 能力层。

## 背景与问题

当前 `typecho-plugin-ai` 已通过通用 Capability 注册：

- `ai.chat.generate`：提供 OpenAI Chat Completions 语义的普通结果和流式结果；
- `ai.models.list`：提供已发布模型的下拉选项。

Chat 结果已经能够携带 `prompt_tokens`、`completion_tokens` 和 `total_tokens`，流式 chunk 也能保留上游最终 usage（如果 Provider 返回）。但 `typecho-plugin-scribe` 当前只把 chunk 转为纯文本流，编辑器只能显示静态的“AI 正在生成”，无法展示任务阶段、实时输入/输出速率或最终用量。

官方 OpenAI API 将文本/图像输入输出、工具调用、Embeddings、Images、Audio、Moderations 等能力分成可组合的资源与模型能力；Responses API 使用 input/output/total usage 语义。参考：[OpenAI API Reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create) 和 [OpenAI Models](https://developers.openai.com/api/docs/models/all)。

## 目标

1. 为所有长耗时 AI Capability 定义统一、可选、请求级的进度与 usage 契约。
2. 让 `ai.chat.generate` 在不破坏既有消费者的情况下提供实时遥测：任务阶段、耗时、输入/输出 Token、Token/s 和估算标记。
3. 让 Scribe 在生成、润色、纠错期间实时展示任务和上行/下行 Token 速率，并在完成后展示最终统计。
4. 建立清晰的 OpenAI 风格能力目录：已实现能力可解析调用，未来能力可登记为预留但不能伪装成已实现。
5. 保持 AI 插件与具体消费者解耦，未来插件只依赖 Capability 契约，不读取 AI 配置或导入 AI 实现模块。
6. 遥测只服务当前请求和当前编辑器会话，不新增 D1 用量表，不记录 Prompt、正文、API Key 或完整上游响应。

## 非目标

- 本次不实现 Responses、Embeddings、图片、音频、Moderations 等具体新 Provider 适配器；本次只完善目录、契约和 Chat 实现的可复用基础。
- 本次不实现价格计算、账单、跨请求累计额度、管理员用量报表或历史用量存储。
- AI 插件不执行工具调用；工具调用仍由 Consumer 按自身权限和确认策略执行。
- 本次不实现 Realtime/WebSocket、视频、Files、Vector Stores、Batch 等异步或长连接资源。
- 不改变现有 HTTP 兼容端点的外部协议和 Bearer 鉴权规则。

## 能力目录与生命周期

### 当前稳定能力

| Capability | 版本 | 状态 | 说明 |
|---|---:|---|---|
| `ai.chat.generate` | 1 | 已实现 | Chat Completions 语义；支持文本、图片/音频输入、音频输出、tools/function-call 兼容、普通结果和流式结果；增加可选进度观察器 |
| `ai.models.list` | 1 | 已实现 | 返回公开模型选项；增加可选的完整模型元数据列表，保留 `listOptions()` 兼容现有 Scribe 配置页 |
| `ai.capabilities.list` | 1 | 已实现 | 发布 AI 能力目录及实现/预留状态，供消费者发现能力；不作为模型配置中的模型能力 |

`ai.capabilities.list` 只描述能力契约本身，不代表当前已经配置了可用模型。`implemented` 表示 AI 插件已注册对应 factory；调用仍可能因为没有可用模型而返回 `no-available-model`。`reserved` 只用于路线图和配置界面发现，不能被解析调用。

```ts
type AiCapabilityStatus = 'implemented' | 'reserved';

interface AiCapabilityDescriptor {
  capability: string;
  version: number;
  status: AiCapabilityStatus;
  category: 'generation' | 'embedding' | 'image' | 'audio' | 'moderation' | 'resource';
  inputModalities: ReadonlyArray<string>;
  outputModalities: ReadonlyArray<string>;
}

interface AiCapabilityCatalogService {
  listCapabilities(): ReadonlyArray<AiCapabilityDescriptor>;
}
```

`ai.capabilities.list` 自身不出现在模型的 `capabilities` 多选项中；模型能力只引用具体操作（例如 `ai.chat.generate`）。

`ai.chat.generate` 的进度参数和 `ai.models.list` 的扩展方法均为可选字段，因此 Capability 版本保持为 1。未理解这些可选字段的旧 Consumer/实现仍可完成原有调用。

### 近期预留能力

这些 ID 纳入 AI 能力目录和模型配置枚举，但在对应工厂实现前保持 disabled，不允许配置成可解析的实现：

- `ai.responses.generate`
- `ai.embeddings.create`
- `ai.image.generate`
- `ai.image.edit`
- `ai.audio.speech.generate`
- `ai.audio.transcribe`
- `ai.audio.translate`
- `ai.moderations.create`

### 后续资源型能力

下列能力暂不进入可调用契约，只作为路线图名称，避免把不同生命周期、权限和存储模型过早塞入同步生成接口：

- `ai.video.generate`
- `ai.realtime.connect`
- `ai.files.*`
- `ai.vector-stores.*`
- `ai.batch.*`

Capability 注册表继续执行版本匹配、owner 绑定、激活代次和停用清理。预留 ID 不代表存在实现；Consumer 必须处理 `unavailable`、`ambiguous`、`version-mismatch`、`factory-failed` 等解析结果。

## 统一遥测契约

### Token usage

新增与具体 OpenAI 资源无关的规范化 usage 类型，把 Chat Completions 的 `prompt_tokens/completion_tokens` 和 Responses 的 `input_tokens/output_tokens` 映射为同一语义：

```ts
interface AiUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  inputTokensEstimated?: boolean;
  outputTokensEstimated?: boolean;
}
```

现有公开 Chat 结果中的 OpenAI 字段保持不变；规范化 summary 只作为进度/通用操作契约使用。没有上游 usage 时不能伪造精确值，估算值必须带对应标记。

### Progress event

```ts
type AiTaskPhase =
  | 'queued'
  | 'requesting'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface AiProgressEvent {
  phase: AiTaskPhase;
  elapsedMs: number;
  timeToFirstTokenMs?: number;
  usage: AiUsageSummary;
  inputTokensPerSecond?: number;
  outputTokensPerSecond?: number;
}

interface AiGenerationOptions {
  onProgress?: (event: AiProgressEvent) => void;
}
```

`ai.chat.generate` 扩展为接受可选的第二参数：

```ts
generate(request: AiChatRequest, options?: AiGenerationOptions): Promise<AiChatResult>;
```

这些公共契约类型由 AI 插件以 type-only 方式导出，Consumer 可以只导入类型或在没有包依赖时采用等价的结构化类型；运行时仍必须通过通用 `resolveCapability` 获取服务，不得导入 AI 实现模块或读取其配置。

约束：

- 观察器是请求级回调，不写入请求 JSON，不会被转发给 Provider；
- 观察器异常必须被吞掉，不能改变生成结果或中断上游请求；
- AI 插件最多以每秒 10 次的频率发送进度事件，Consumer 可继续节流 UI；
- `requesting` 阶段的输入速率表示输入 Token 相对于请求阶段耗时的处理速率，不是精确的 TCP 上传带宽；
- Provider 返回真实 usage 后，以真实值覆盖估算值；若没有真实 usage，保留估算标记；
- 输出速率按流式输出期间新增的输出 Token 和时间计算；没有逐 Token 计数时使用受限的文本/字节估算，并标记 `outputTokensEstimated`；
- `timeToFirstTokenMs` 只在首次有效输出到达后填写。

### OpenAI usage 适配

Chat Completions 流式请求在能力实现内部尽量请求标准的最终 usage（等价于 `stream_options.include_usage` 的语义），但不能假定所有 OpenAI-compatible Provider 都支持该选项。Provider 拒绝或忽略时，Chat 流仍须正常工作并退回估算；不能因遥测缺失让正文生成失败。

Responses、Embedding、Image、Audio、Moderation 后续实现都复用 `AiUsageSummary` 和 `AiProgressEvent`，只在各自适配层把资源特有字段映射进来。

## AI 模型目录扩展

保留现有：

```ts
listOptions(): ReadonlyArray<{ value: string; label?: string }>;
```

增加可选的完整列表方法：

```ts
interface AiPublishedModel {
  id: string;
  label?: string;
  capabilities: ReadonlyArray<string>;
  modalities: ReadonlyArray<string>;
}

interface AiModelCatalogService {
  listOptions(): ReadonlyArray<{ value: string; label?: string }>;
  listModels?(): ReadonlyArray<AiPublishedModel>;
}
```

目录只发布已启用、已设置公开 alias、满足能力和模态约束的模型。不得返回 API Key、Provider 凭据、内部 URL 或未公开的上游模型名。Scribe 继续使用 `listOptions()`；未来插件可用 `listModels()` 决定文本、视觉、音频或 Embedding 功能是否展示。

`AiPublishedModel.id` 是对外公开的 alias（未设置 alias 的模型不进入目录），不是 Provider 的上游模型名；`listModels()` 的 `capabilities` 只返回当前已实现的具体 Capability ID，不把预留项伪装成可用能力。

## Scribe 数据流与展示

### 服务端

Scribe 调用 `ai.chat.generate` 时传入 `onProgress`，并继续请求流式结果。Scribe 将内部类型化 Chat chunk 和 progress event 转换为仅供编辑器使用的 SSE：

```text
event: text
data: {"delta":"..."}

event: progress
data: {"phase":"streaming","elapsedMs":...,"usage":...,"outputTokensPerSecond":...}

event: done
data: {"phase":"completed","usage":...,"elapsedMs":...}
```

事件约束：

- `text` 只包含需要写入编辑器的正文增量；
- `progress` 和 `done` 只包含状态、耗时、usage、速率和估算标记，不包含 Prompt、正文、API Key、原始 Provider 响应或堆栈；
- 使用 `text/event-stream`、`Cache-Control: no-store`，不进入边缘缓存；
- 非流式或旧 Consumer 降级时，Scribe 也可发送单个 `text` 事件和最终 `done` 事件，保持客户端协议一致；
- 服务端只负责把事件写入当前响应，不落库、不产生日志正文。

### 浏览器

编辑器状态区至少展示：

- 任务：`AI 生成`、`AI 润色` 或 `AI 纠错`；
- 阶段：准备中、请求中、生成中、完成、失败；
- 上行：输入 Token 数与输入阶段速率；
- 下行：输出 Token 数与输出速率；
- 总用量和耗时。

流式期间使用 progress event 更新，最终 done event 覆盖估算值。缺少真实 usage 时显示估算符号或“估算”，不把估算当作计费精确值。状态区在完成后保留本次摘要，开始下一次操作时重置。

客户端 SSE 解析必须支持跨网络 chunk 的事件边界、空行和异常结束；正文仍通过 `textContent`/编辑器 value 写入，禁止把模型输出作为 HTML 注入。异常响应沿用现有错误读取和原文恢复逻辑。

## 安全与隐私边界

### 信任边界与资产

- 浏览器到 Scribe action：标题、正文、附件 ID 和管理员配置是外部输入；
- AI 插件到 Provider：Prompt、媒体和工具定义跨出站边界；
- AI 插件到 Scribe/浏览器：模型输出和 usage 是不可信返回数据；
- 需要保护的资产包括 API Key、Bearer Token、Prompt/正文、用户附件、模型输出和用户身份。

### 必须保持的控制

- progress observer 不接收或复制 Prompt、正文、媒体内容和密钥；
- 不新增用量 D1 表、日志字段、localStorage 或跨请求缓存；
- 逻辑模型 alias 可以用于展示，Provider URL、API Key 和上游模型名不能进入浏览器遥测；
- 所有模型输出继续按不可信文本处理，不进入 `innerHTML`、`eval`、SQL、Shell 或文件路径；
- 既有 action 权限、CSRF、Origin 同源检查、请求体/超时/并发上限保持不变；
- Scribe SSE 设置 `no-store`，避免编辑器内容或 usage 被缓存；
- 进度事件缺失、格式错误或观察器抛错只影响展示，不改变 AI 主请求的成功/失败。

## 兼容性与失败语义

- `ai.chat.generate` Capability 版本保持 1；新增第二参数为可选，旧实现忽略即可。
- Scribe 如果没有收到任何 progress event，使用自身已收到的 chunk 做输出估算，并将输入速率标为不可用或估算；不能因此拒绝生成。
- Provider 没有 usage、只返回部分 usage、拒绝 include-usage 或中途断流时，Scribe 仍恢复原有错误/正文行为，最终统计中缺失字段显示 `—`。
- Capability 解析失败时，Scribe 保持现有本地化错误；不向浏览器暴露工厂堆栈、Provider 凭据或完整上游错误体。
- 未实现的预留能力解析为 `unavailable`，配置字段继续 disabled；只有真正注册 factory 后才可被 Consumer 解析。

## 测试与验收

### AI 插件单元测试

- Chat 非流式真实 usage 映射为 `AiUsageSummary`；
- 流式末块 usage 覆盖估算值；Provider 不支持 usage 时估算并带标记；
- progress phase、TTFT、输入/输出速率和 10 次/秒上限正确；
- observer 抛错不影响生成；observer 不进入 Provider 请求 body；
- `stream_options.include_usage` 的兼容转发不阻断不支持该字段的 Provider；
- 模型目录 `listOptions()` 旧行为、`listModels()` 新元数据和 `ai.capabilities.list` 均不泄露凭据/内部 URL；
- 预留 Capability 仍不可解析，已禁用配置选项不会被伪造提交开启。

### Scribe 单元/渲染测试

- `generate`、`polish`、`correct` 产生正确任务标签和状态；
- SSE text/progress/done 事件编码、跨 chunk 解析和异常收尾；
- 估算值到最终真实 usage 的替换、缺失字段降级和失败恢复；
- 模型输出中的 HTML/脚本只作为文本写入，不触发 DOM 注入；
- `editorHtml` 的中英文状态文案和无 usage 场景。

### 集成与最终验证

- `POST /api/admin/plugin-action` 返回 Scribe SSE，并保持权限、CSRF、Origin 和 action 路由行为；
- 每个 AI 操作期间浏览器只收到当前任务的聚合遥测，不包含 Prompt/正文/API Key；
- 运行 `pnpm run test`、`pnpm run test:astro`、`pnpm run typecheck`、`pnpm run lint`、`pnpm run build` 和 `git diff --check`。

## 实施顺序

1. 在 AI 类型和 Chat service 中加入规范化 usage、progress event、observer 安全调用与流式统计。
2. 实现 `ai.capabilities.list`，扩展模型目录的可选元数据方法，整理完整能力目录和预留项，保持未实现项 disabled。
3. 在 Scribe 中加入 progress consumer、SSE 事件编码与兼容降级。
4. 更新 Scribe 编辑器状态区、国际化文案和无 usage/估算展示。
5. 添加单元、Scribe 渲染和 action 集成测试。
6. 更新 AI/Scribe/插件开发文档，运行完整验证并进行安全审查。

## 验收标准

1. Scribe 的三种 AI 操作均能显示任务、阶段、上行/下行速率和最终 Token 统计。
2. Provider 有真实 usage 时最终数值准确；无 usage 时明确标记估算或缺失。
3. `ai.chat.generate` 的旧调用方无需修改即可继续工作。
4. 消费者可以通过能力目录发现当前/预留能力；未来 AI 能力可复用同一套 usage/progress 契约，且未实现能力不会被错误解析。
5. 没有新增敏感数据持久化、日志泄露、缓存绕过或权限放宽。
6. 所有新增测试和项目完整验证命令通过。
