# Scribe AI 任务与 Token 遥测展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Scribe 的生成、润色和纠错操作在编辑器中实时显示当前任务、与 LLM 交互的安全摘要、上下行 Token 速率及最终用量。

**Architecture:** 在 `typecho-plugin-ai` 的 `ai.chat.generate` Capability 上增加可选的请求级 `onProgress` 回调，AI 侧统一计算真实或估算 usage、TTFT 和速率；Scribe 将回调和流式文本封装为内部 SSE。浏览器只接收有限的任务状态键、文本增量和聚合统计，交互摘要由前端本地化生成，不传递 Prompt、正文或 Provider 凭据。

**Tech Stack:** TypeScript 7、Vitest 4、Astro SSR、Cloudflare Workers `ReadableStream`、OpenAI-compatible Chat Completions SSE。

**Spec:** `docs/superpowers/specs/2026-09-13-ai-capability-telemetry-design.md`

## Global Constraints

- `ai.chat.generate` Capability 版本保持为 1；新增的第二参数必须可选，旧 Consumer 和旧实现仍可调用。
- 进度回调是请求级运行时回调，不进入 Provider JSON、日志、D1、缓存或浏览器 Prompt/正文。
- Provider 返回真实 usage 时覆盖估算值；没有真实 usage 时明确保留 `inputTokensEstimated` / `outputTokensEstimated`。
- Scribe SSE 只允许 `task`、`text`、`progress`、`error`、`done` 五类事件，响应设置 `text/event-stream` 与 `Cache-Control: no-store`。
- 交互摘要只使用 `mode` 与固定 activity 状态键，由前端通过 i18n 文案渲染。
- 模型输出继续写入编辑器 value 或 DOM `textContent`，禁止把模型输出拼入 `innerHTML`。
- 保持既有管理员权限、CSRF、Origin 同源校验、请求体/媒体/超时/并发和错误本地化行为。
- 每个任务完成后运行对应测试和 `git diff --check`；最终运行 `pnpm run test`、`pnpm run test:astro`、`pnpm run typecheck`、`pnpm run lint`、`pnpm run build`。

## File Map

- Create `src/plugins/typecho-plugin-ai/telemetry.ts`: AI usage 映射、输入/输出估算和限频进度 reporter。
- Create `src/plugins/typecho-plugin-ai/telemetry.test.ts`: reporter 的真实 usage、估算、速率、限频和异常测试。
- Modify `src/plugins/typecho-plugin-ai/types.ts`: 导出规范化 usage、phase、progress 和 generation options 类型。
- Modify `src/plugins/typecho-plugin-ai/chat.ts`: 接受 observer、发出生命周期事件、请求流式 usage，并对明确不支持 `include_usage` 的 Provider 做一次兼容回退。
- Modify `src/plugins/typecho-plugin-ai/chat-stream.ts`: 对规范化 chunk、完成和流错误通知 reporter。
- Modify `src/plugins/typecho-plugin-ai/index.test.ts`: 覆盖 Chat service 的 observer、stream usage 和 Provider fallback。
- Create `src/plugins/typecho-plugin-scribe/scribe-stream.ts`: Scribe SSE 类型、编码器、activity 映射和异步事件流。
- Modify `src/plugins/typecho-plugin-scribe/index.ts`: 传入 observer、消费 Chat stream、发送 SSE、保留旧 Capability/纯文本降级。
- Modify `src/plugins/typecho-plugin-scribe/editor-ui.ts`: 状态面板、SSE parser、任务摘要、速率/用量格式化和错误恢复。
- Create `src/plugins/typecho-plugin-scribe/scribe-stream.test.ts`: SSE 编码、跨 chunk 语义和安全 payload 测试。
- Modify `src/plugins/typecho-plugin-scribe/index.test.ts`: Scribe action 的 SSE、fallback、任务摘要和 usage 覆盖测试。
- Modify `src/plugins/typecho-plugin-scribe/locales/zh-CN.json` and `src/plugins/typecho-plugin-scribe/locales/en.json`: 状态、activity、速率和估算文案。
- Modify `src/plugins/typecho-plugin-ai/README.md` and `src/plugins/typecho-plugin-scribe/README.md`: 记录通用 progress contract、SSE 和兼容降级。

### Task 1: 建立 AI progress/usage contract 与 reporter

**Files:**

- Modify: `src/plugins/typecho-plugin-ai/types.ts:180-247`
- Create: `src/plugins/typecho-plugin-ai/telemetry.ts`
- Create: `src/plugins/typecho-plugin-ai/telemetry.test.ts`

**Interfaces:**

- `AiUsageSummary` 提供 `inputTokens`、`outputTokens`、`totalTokens`、`cachedInputTokens`、`reasoningOutputTokens` 和两类估算标记。
- `AiProgressEvent` 提供 `phase`、`elapsedMs`、`timeToFirstTokenMs`、`usage`、`inputTokensPerSecond` 和 `outputTokensPerSecond`。
- `AiGenerationOptions` 提供可选的同步 `onProgress(event: AiProgressEvent): void`。
- `createAiProgressReporter(request, callback, now)` 返回 `reportPhase`、`reportChunk`、`complete` 和 `fail` 四个请求级方法；`now` 只用于确定性测试，生产默认使用 `Date.now`。

- [ ] **Step 1: Write the failing reporter tests**

```ts
it('starts with estimated input usage and replaces it with provider usage', () => {
  let clock = 1000;
  const events: AiProgressEvent[] = [];
  const reporter = createAiProgressReporter(
    { messages: [{ role: 'user', content: '写一篇 TypeScript 文章' }] },
    event => events.push(event),
    () => clock,
  );

  reporter.reportPhase('requesting');
  clock = 1200;
  reporter.reportChunk({
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'scribe',
    choices: [{ index: 0, delta: { content: '正文' } }],
  });
  clock = 1500;
  reporter.complete({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });

  expect(events.at(-1)).toMatchObject({
    phase: 'completed',
    usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
  });
  expect(events.at(-1)?.usage.inputTokensEstimated).toBeUndefined();
  expect(events.at(-1)?.usage.outputTokensEstimated).toBeUndefined();
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm exec vitest run src/plugins/typecho-plugin-ai/telemetry.test.ts`

Expected: FAIL because `AiProgressEvent` and `createAiProgressReporter` are not implemented.

- [ ] **Step 3: Add the public types and minimal reporter implementation**

```ts
export type AiTaskPhase = 'queued' | 'requesting' | 'streaming' | 'completed' | 'failed' | 'cancelled';

export interface AiGenerationOptions {
  onProgress?: (event: AiProgressEvent) => void;
}

export interface AiChatGenerationService {
  generate(request: AiChatRequest, options?: AiGenerationOptions): Promise<AiChatResult>;
}
```

The reporter will estimate text input/output with a bounded UTF-8 byte heuristic, set the matching estimated flag, calculate input rate from the `requesting` interval and output rate from the first output to the current event, merge exact `AiUsage` fields at completion, swallow callback exceptions, and suppress intermediate callbacks to one event per 100 ms. Terminal `completed` and `failed` events always flush.

- [ ] **Step 4: Add edge-case tests and run them**

Test empty content, usage-only stream chunks, missing provider usage, callback exceptions, rate values, TTFT, output estimate flags, and the 100 ms intermediate limit.

Run: `pnpm exec vitest run src/plugins/typecho-plugin-ai/telemetry.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the contract slice**

```bash
git add src/plugins/typecho-plugin-ai/types.ts src/plugins/typecho-plugin-ai/telemetry.ts src/plugins/typecho-plugin-ai/telemetry.test.ts
git commit -m "feat(ai): add request progress telemetry contract"
```

### Task 2: Wire telemetry into AI Chat streaming and usage compatibility

**Files:**

- Modify: `src/plugins/typecho-plugin-ai/chat.ts:47-105,280-390`
- Modify: `src/plugins/typecho-plugin-ai/chat-stream.ts:70-170`
- Modify: `src/plugins/typecho-plugin-ai/index.test.ts:300-430`

**Interfaces:**

- Extend `createChatStream` with an optional callback object: `onChunk(chunk)`, `onComplete(usage?)`, and `onError()`.
- `createAiChatService().generate(request, options?)` creates one reporter, sends `queued` and `requesting`, and binds the reporter to the non-stream or stream lifecycle.

- [ ] **Step 1: Add failing Chat observer tests**

Cover these concrete cases:

```ts
const progress = vi.fn();
const service = createAiChatService(runtime(), config(), { fetcher });
const result = await service.generate(
  { model: 'chat', messages: [{ role: 'user', content: 'x' }], stream: true, stream_options: { include_usage: true } },
  { onProgress: progress },
);
await readStream(result as ReadableStream<AiChatStreamChunk>);
expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'completed' }));

expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
  stream_options: { include_usage: true },
});
```

Also make a fetcher return HTTP 400 with an error body containing `include_usage`, then return a valid stream on the second call; assert the stream succeeds and the body of the retry omits `include_usage`.

- [ ] **Step 2: Run the focused AI tests and verify the new assertions fail**

Run: `pnpm exec vitest run src/plugins/typecho-plugin-ai/index.test.ts`

Expected: FAIL because `generate` currently accepts one argument, stream callbacks are absent, and unsupported usage options are not retried.

- [ ] **Step 3: Integrate the reporter without changing the public Chat response shape**

Wrap the existing `generate` body in a try/catch. Report `failed` before rethrowing setup/fetch/normalization errors. For streams, pass reporter callbacks into `createChatStream`; on `[DONE]` or clean EOF call `complete`, and on parser/size/deadline error call `fail` before propagating the existing `AiCapabilityError`.

When `stream_options.include_usage` is not explicitly set for a stream, send it as `true` in the copied upstream request. If a 400/422 response body explicitly mentions `include_usage` or `stream_options`, issue exactly one same-deadline retry without that option; all other upstream errors retain the existing single-attempt behavior and error mapping.

- [ ] **Step 4: Run AI tests and typecheck the changed surface**

Run: `pnpm exec vitest run src/plugins/typecho-plugin-ai/index.test.ts src/plugins/typecho-plugin-ai/telemetry.test.ts`

Expected: PASS, including existing multimodal/tool-call tests and the new observer/fallback tests.

- [ ] **Step 5: Commit the AI integration slice**

```bash
git add src/plugins/typecho-plugin-ai/chat.ts src/plugins/typecho-plugin-ai/chat-stream.ts src/plugins/typecho-plugin-ai/index.test.ts
git commit -m "feat(ai): report chat progress and usage"
```

### Task 3: Convert Scribe generation to a typed SSE response

**Files:**

- Create: `src/plugins/typecho-plugin-scribe/scribe-stream.ts`
- Modify: `src/plugins/typecho-plugin-scribe/index.ts:150-185,620-730`
- Create: `src/plugins/typecho-plugin-scribe/scribe-stream.test.ts`
- Modify: `src/plugins/typecho-plugin-scribe/index.test.ts:240-330`

**Interfaces:**

- `ScribeWriterMode = 'generate' | 'polish' | 'correct'`.
- `ScribeActivity = 'preparing' | 'requesting' | 'streaming' | 'finalizing'`.
- `ScribeStreamEvent` is the union of `task`, `text`, `progress`, `error`, and `done` events; `task` carries only `mode` and `activity`.
- `encodeScribeEvent(name, payload): string` JSON-encodes payload and terminates each event with two newlines.
- `createScribeEventStream(producer): ReadableStream<Uint8Array>` starts the producer when the response body starts, closes once, and ignores enqueue attempts after cancellation.

- [ ] **Step 1: Write failing SSE encoder and action tests**

```ts
expect(encodeScribeEvent('task', { mode: 'generate', activity: 'preparing' })).toBe(
  'event: task\ndata: {"mode":"generate","activity":"preparing"}\n\n',
);

const result = await action({ handled: false }, {
  action: 'generate',
  payload: { contentType: 'post', title: '测试标题' },
  capabilityRuntime: aiRuntime(generate),
  options: scribeOptions(),
});

expect(result.response?.headers.get('Content-Type')).toContain('text/event-stream');
expect(await result.response?.text()).toContain('event: progress');
```

- [ ] **Step 2: Run Scribe tests and verify they fail**

Run: `pnpm exec vitest run src/plugins/typecho-plugin-scribe/index.test.ts src/plugins/typecho-plugin-scribe/scribe-stream.test.ts`

Expected: FAIL because the action currently returns `text/plain` and no SSE encoder exists.

- [ ] **Step 3: Implement the async Scribe producer and safe event contract**

Make `requestDraftStream` return the `Response` immediately. The producer emits `task(preparing)`, loads style/assets, calls `service.generate(request, { onProgress })`, maps AI phases to activity keys, forwards only aggregate usage/rates, emits sanitized text deltas, and emits `done` on clean completion. If the stream fails after headers are sent, emit `error` with the localized safe message followed by `done` with `phase: failed`; do not enqueue an Error object or upstream response body.

Keep the current code-fence tail hold and `sanitizeAssistantText` behavior. A non-stream result emits one `text` event and one `done`; a legacy AI service that ignores the second argument still works through Scribe-local input/output estimates.

Use these headers:

```ts
const SCRIBE_STREAM_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Typecho-Plugin-Stream': '1',
} as const;
```

- [ ] **Step 4: Add security and compatibility tests**

Assert task/progress/done payloads contain no title, body, assembled prompt, API key, provider URL, raw error body, or stack; assert old one-argument mock services still return text and done; assert a mid-stream failure returns a failed event and preserves the editor's old content in the client-facing contract.

Run: `pnpm exec vitest run src/plugins/typecho-plugin-scribe/index.test.ts src/plugins/typecho-plugin-scribe/scribe-stream.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the Scribe transport slice**

```bash
git add src/plugins/typecho-plugin-scribe/scribe-stream.ts src/plugins/typecho-plugin-scribe/index.ts src/plugins/typecho-plugin-scribe/index.test.ts src/plugins/typecho-plugin-scribe/scribe-stream.test.ts
git commit -m "feat(scribe): stream AI progress over SSE"
```

### Task 4: Add the editor task/status panel and browser SSE parser

**Files:**

- Modify: `src/plugins/typecho-plugin-scribe/editor-ui.ts:13-570`
- Modify: `src/plugins/typecho-plugin-scribe/index.test.ts:75-100`

**Interfaces:**

- The injected markup contains a persistent status panel with task, activity, phase, input metric, output metric, total and elapsed fields.
- The inline parser accepts arbitrary network chunk boundaries, normalizes CRLF/CR, parses JSON only for known event names, and reports whether a terminal `done` event was received.
- `runScribe` initializes `preparing` status before `fetch`; `readStreamIntoEditor` uses SSE parsing when the response content type is `text/event-stream` and retains the existing plain-text/JSON fallback otherwise.

- [ ] **Step 1: Add markup/script assertions for the new UI**

```ts
const html = hooks.get('admin:writePost:bottom')![0]('');
expect(html).toContain('typecho-scribe-status');
expect(html).toContain('outputTokensPerSecond');
expect(html).toContain('text/event-stream');
expect(html).toContain('textContent');
expect(html).toContain('event === \'progress\'');
```

- [ ] **Step 2: Run the Scribe UI assertion and verify the new assertions fail**

Run: `pnpm exec vitest run src/plugins/typecho-plugin-scribe/index.test.ts`

Expected: FAIL because the current HTML has only the spinner and reads every response as plain text.

- [ ] **Step 3: Implement status rendering and SSE parsing**

Add localized, fixed activity mappings:

```js
var activityMessages = {
  preparing: messages.progressPreparing,
  requesting: messages.progressRequesting,
  streaming: messages.progressStreaming,
  finalizing: messages.progressFinalizing
};
```

Render all dynamic values with `textContent`. Format exact values without a suffix and estimates with the localized estimate marker; render unavailable rates/counts as `—`. Update the panel on `task`, `progress`, `error`, and `done`, keep the final summary visible after the overlay closes, and reset it at the beginning of the next operation.

For SSE parsing, accumulate decoded text until a blank line, support multiple `data:` lines, reject malformed known JSON, append only `text.delta` to the editor, and throw if the stream ends without `done`. On `error` or failed `done`, restore `oldText` and use the existing localized notice path.

Retain the non-SSE path for already deployed Scribe versions and plain-text responses. Do not use `innerHTML` for task, activity, metrics, error messages, or model output.

- [ ] **Step 4: Verify UI contract and XSS boundaries**

Run: `pnpm exec vitest run src/plugins/typecho-plugin-scribe/index.test.ts`

Expected: PASS; assertions must cover all three mode labels, all four activity mappings, estimated marker rendering, persistent final summary, plain-text fallback, and absence of dynamic `innerHTML` writes.

- [ ] **Step 5: Commit the editor UI slice**

```bash
git add src/plugins/typecho-plugin-scribe/editor-ui.ts src/plugins/typecho-plugin-scribe/index.test.ts
git commit -m "feat(scribe): show AI task and token telemetry"
```

### Task 5: Localize, document, and test the public behavior

**Files:**

- Modify: `src/plugins/typecho-plugin-scribe/locales/zh-CN.json`
- Modify: `src/plugins/typecho-plugin-scribe/locales/en.json`
- Modify: `src/plugins/typecho-plugin-ai/README.md`
- Modify: `src/plugins/typecho-plugin-scribe/README.md`
- Modify: `src/plugins/typecho-plugin-scribe/index.test.ts`

- [ ] **Step 1: Add all status and metric message keys in both locale files**

Add translations for preparing, requesting, streaming, finalizing, failed, input, output, total, elapsed, tokens-per-second, estimated, unavailable, incomplete stream, and the three operation task summaries. Keep JSON valid and use the same keys in both files.

- [ ] **Step 2: Add docs for the reusable contract and Scribe transport**

Document the exact optional `generate(request, { onProgress })` signature, the meaning of input/output rates, exact-versus-estimated usage, the observer non-serialization rule, the Scribe SSE event names, and the plain-text fallback. Explicitly state that task activity is an approximate fixed summary and never includes Prompt/body content.

- [ ] **Step 3: Add final action and rendering assertions**

Cover `generate`, `polish`, and `correct` labels; localized activity strings; exact usage replacing estimate; missing usage display; SSE parser split across chunks; malformed event handling; and old-text restoration on failure.

- [ ] **Step 4: Run focused tests and JSON/type validation**

Run: `pnpm exec vitest run src/plugins/typecho-plugin-ai/telemetry.test.ts src/plugins/typecho-plugin-ai/index.test.ts src/plugins/typecho-plugin-scribe/index.test.ts src/plugins/typecho-plugin-scribe/scribe-stream.test.ts`

Expected: PASS with both locale catalogs loading successfully.

- [ ] **Step 5: Commit docs and localization**

```bash
git add src/plugins/typecho-plugin-ai/README.md src/plugins/typecho-plugin-scribe/README.md src/plugins/typecho-plugin-scribe/locales/zh-CN.json src/plugins/typecho-plugin-scribe/locales/en.json src/plugins/typecho-plugin-scribe/index.test.ts
git commit -m "docs(scribe): document AI telemetry display"
```

### Task 6: Full verification and quality review

**Files:**

- Review all changed files from Tasks 1-5.
- No new source file is created in this task.

- [ ] **Step 1: Run focused and full test suites**

```bash
pnpm run test
pnpm run test:astro
pnpm run typecheck
pnpm run lint
pnpm run build
git diff --check
```

Expected: all commands exit successfully; the final diff contains no generated secrets, Prompt/body samples, or unrelated files.

- [ ] **Step 2: Perform the security review**

Verify that the observer receives only aggregate numbers, Scribe task events contain only fixed keys, no API key/provider URL enters SSE, SSE is not cacheable, and model output remains text-only. Verify that a cancelled browser stream cancels the upstream reader and does not keep enqueueing.

- [ ] **Step 3: Run the code-quality review before the final merge commit**

Use the code-review-and-quality skill against the complete diff. Resolve findings that affect correctness, security, compatibility, tests, or maintainability, then rerun the affected tests.

- [ ] **Step 4: Inspect repository state and create the final local commit**

```bash
git status --short
git diff --stat HEAD~5..HEAD
git log --oneline -6
```

Keep all commits local and do not run `git push`.

- [ ] **Step 5: Hand off with reproducible verification results**

Report the final commit IDs, the changed UI behavior, exact-versus-estimated usage semantics, and every validation command result. Include the local file links for the AI and Scribe entry points.
