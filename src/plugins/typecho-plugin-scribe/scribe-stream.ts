export type ScribeMode = 'generate' | 'polish' | 'correct';

export type ScribeActivity = 'preparing' | 'requesting' | 'streaming' | 'finalizing';

export type ScribeTaskPhase = 'queued' | 'requesting' | 'streaming' | 'completed' | 'failed' | 'cancelled';

export interface ScribeUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export interface ScribeUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  inputTokensEstimated?: boolean;
  outputTokensEstimated?: boolean;
}

export interface ScribeProgressEvent {
  phase: ScribeTaskPhase;
  elapsedMs: number;
  timeToFirstTokenMs?: number;
  usage: ScribeUsageSummary;
  inputTokensPerSecond?: number;
  outputTokensPerSecond?: number;
}

export interface ScribeChatStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ function?: { arguments?: string } }>;
    };
  }>;
  usage?: ScribeUsage;
}

export interface ScribeProgressPayload extends ScribeProgressEvent {
  activity: ScribeActivity;
}

export interface ScribeDonePayload {
  phase: 'completed' | 'failed' | 'cancelled';
  activity: 'finalizing';
  elapsedMs: number;
  timeToFirstTokenMs?: number;
  usage: ScribeUsageSummary;
  inputTokensPerSecond?: number;
  outputTokensPerSecond?: number;
}

export interface ScribeTaskPayload {
  mode: ScribeMode;
  activity: ScribeActivity;
}

export interface ScribeStreamWriter {
  task(payload: ScribeTaskPayload): void;
  text(delta: string): void;
  progress(payload: ScribeProgressPayload): void;
  error(message: string): void;
  done(payload: ScribeDonePayload): void;
}

export const SCRIBE_STREAM_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Typecho-Plugin-Stream': '1',
} as const;

const encoder = new TextEncoder();

export function encodeScribeEvent(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Keep the browser-facing activity vocabulary finite and free of prompt data. */
export function activityForPhase(phase: ScribeTaskPhase): ScribeActivity {
  switch (phase) {
    case 'requesting':
      return 'requesting';
    case 'streaming':
      return 'streaming';
    case 'completed':
    case 'failed':
    case 'cancelled':
      return 'finalizing';
    case 'queued':
    default:
      return 'preparing';
  }
}

/**
 * Run a producer on demand while keeping the response body as a real SSE
 * stream. The producer owns user-facing error messages and emits an `error`
 * event when it can recover; unexpected producer errors still terminate the
 * stream without serializing the error object.
 */
export function createScribeEventStream(
  producer: (writer: ScribeStreamWriter) => Promise<void>,
): ReadableStream<Uint8Array> {
  let cancelled = false;
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (name: string, payload: unknown): void => {
        if (cancelled || closed) return;
        controller.enqueue(encoder.encode(encodeScribeEvent(name, payload)));
      };
      const writer: ScribeStreamWriter = {
        task: payload => write('task', payload),
        text: delta => {
          if (typeof delta === 'string' && delta) write('text', { delta });
        },
        progress: payload => write('progress', payload),
        error: message => write('error', { message: safeErrorMessage(message) }),
        done: payload => write('done', payload),
      };

      void producer(writer).then(() => {
        if (!cancelled && !closed) {
          closed = true;
          controller.close();
        }
      }).catch(() => {
        if (!cancelled && !closed) {
          closed = true;
          controller.error(new Error('Scribe stream failed.'));
        }
      });
    },
    cancel() {
      cancelled = true;
    },
  });
}

function safeErrorMessage(message: unknown): string {
  if (typeof message !== 'string') return 'AI 写作失败';
  const normalized = message.trim();
  return normalized.length > 512 ? normalized.slice(0, 512) : normalized || 'AI 写作失败';
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function safeNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value * 100) / 100
    : undefined;
}

export function sanitizeUsageSummary(value: unknown): ScribeUsageSummary {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  const inputTokens = safeNonNegativeInteger(source.inputTokens);
  const outputTokens = safeNonNegativeInteger(source.outputTokens);
  const totalTokens = safeNonNegativeInteger(source.totalTokens);
  const cachedInputTokens = safeNonNegativeInteger(source.cachedInputTokens);
  const reasoningOutputTokens = safeNonNegativeInteger(source.reasoningOutputTokens);
  const result: ScribeUsageSummary = {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
  };
  if (source.inputTokensEstimated === true) result.inputTokensEstimated = true;
  if (source.outputTokensEstimated === true) result.outputTokensEstimated = true;
  return result;
}

export function sanitizeProgressEvent(value: unknown): ScribeProgressEvent | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const phases: ScribeTaskPhase[] = ['queued', 'requesting', 'streaming', 'completed', 'failed', 'cancelled'];
  const phase = phases.includes(source.phase as ScribeTaskPhase) ? source.phase as ScribeTaskPhase : null;
  if (!phase) return null;
  const elapsedMs = safeNonNegativeNumber(source.elapsedMs) ?? 0;
  const timeToFirstTokenMs = safeNonNegativeNumber(source.timeToFirstTokenMs);
  const inputTokensPerSecond = safeNonNegativeNumber(source.inputTokensPerSecond);
  const outputTokensPerSecond = safeNonNegativeNumber(source.outputTokensPerSecond);
  return {
    phase,
    elapsedMs,
    ...(timeToFirstTokenMs === undefined ? {} : { timeToFirstTokenMs }),
    usage: sanitizeUsageSummary(source.usage),
    ...(inputTokensPerSecond === undefined ? {} : { inputTokensPerSecond }),
    ...(outputTokensPerSecond === undefined ? {} : { outputTokensPerSecond }),
  };
}

export function progressPayload(event: ScribeProgressEvent): ScribeProgressPayload {
  return { ...event, activity: activityForPhase(event.phase) };
}

export function donePayload(event: ScribeProgressEvent): ScribeDonePayload {
  const phase = event.phase === 'failed' || event.phase === 'cancelled' ? event.phase : 'completed';
  return {
    phase,
    activity: 'finalizing',
    elapsedMs: event.elapsedMs,
    ...(event.timeToFirstTokenMs === undefined ? {} : { timeToFirstTokenMs: event.timeToFirstTokenMs }),
    usage: event.usage,
    ...(event.inputTokensPerSecond === undefined ? {} : { inputTokensPerSecond: event.inputTokensPerSecond }),
    ...(event.outputTokensPerSecond === undefined ? {} : { outputTokensPerSecond: event.outputTokensPerSecond }),
  };
}

function estimateBytes(bytes: number): number {
  return bytes > 0 ? Math.max(1, Math.ceil(bytes / 4)) : 0;
}

export function estimateScribeTextTokens(value: string): number {
  return estimateBytes(encoder.encode(value).byteLength);
}

function rate(tokens: number | undefined, startedAt: number | undefined, endedAt: number): number | undefined {
  if (tokens === undefined || tokens <= 0 || startedAt === undefined || endedAt <= startedAt) return undefined;
  return Math.round((tokens * 1000 / (endedAt - startedAt)) * 100) / 100;
}

function usageSummaryFromUsage(usage?: ScribeUsage): ScribeUsageSummary {
  if (!usage) return {};
  const inputTokens = safeNonNegativeInteger(usage.input_tokens) ?? safeNonNegativeInteger(usage.prompt_tokens);
  const outputTokens = safeNonNegativeInteger(usage.output_tokens) ?? safeNonNegativeInteger(usage.completion_tokens);
  const totalTokens = safeNonNegativeInteger(usage.total_tokens);
  const cachedInputTokens = safeNonNegativeInteger(usage.input_tokens_details?.cached_tokens)
    ?? safeNonNegativeInteger(usage.prompt_tokens_details?.cached_tokens);
  const reasoningOutputTokens = safeNonNegativeInteger(usage.output_tokens_details?.reasoning_tokens)
    ?? safeNonNegativeInteger(usage.completion_tokens_details?.reasoning_tokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
  };
}

export function createScribeLocalProgressReporter(
  inputText: string,
  onProgress: (event: ScribeProgressEvent) => void,
  now: () => number = Date.now,
): {
  reportPhase: (phase: ScribeTaskPhase) => void;
  reportChunk: (chunk: ScribeChatStreamChunk) => void;
  complete: (usage?: ScribeUsage) => void;
  fail: () => void;
} {
  const startedAt = now();
  const inputEstimate = estimateScribeTextTokens(inputText);
  let phase: ScribeTaskPhase = 'queued';
  let requestingAt: number | undefined;
  let firstOutputAt: number | undefined;
  let outputTokens = 0;
  let usage: ScribeUsageSummary = inputEstimate > 0
    ? { inputTokens: inputEstimate, inputTokensEstimated: true }
    : {};
  let terminal = false;

  const emit = (timestamp: number): void => {
    try {
      onProgress({
        phase,
        elapsedMs: Math.max(0, timestamp - startedAt),
        ...(firstOutputAt === undefined ? {} : { timeToFirstTokenMs: Math.max(0, firstOutputAt - startedAt) }),
        usage: { ...usage },
        inputTokensPerSecond: rate(usage.inputTokens, requestingAt, firstOutputAt ?? timestamp),
        outputTokensPerSecond: rate(usage.outputTokens, firstOutputAt, timestamp),
      });
    } catch {
      // A fallback observer must never affect the editor operation.
    }
  };

  const reportPhase = (nextPhase: ScribeTaskPhase): void => {
    if (terminal) return;
    phase = nextPhase;
    if (nextPhase === 'requesting' && requestingAt === undefined) requestingAt = now();
    emit(now());
  };

  const reportChunk = (chunk: ScribeChatStreamChunk): void => {
    if (terminal) return;
    let bytes = 0;
    for (const choice of chunk.choices || []) {
      if (choice.delta?.content) bytes += encoder.encode(choice.delta.content).byteLength;
      for (const call of choice.delta?.tool_calls || []) bytes += encoder.encode(call.function?.arguments || '').byteLength;
    }
    const additional = estimateBytes(bytes);
    if (additional > 0) {
      if (firstOutputAt === undefined) firstOutputAt = now();
      outputTokens += additional;
      usage.outputTokens = outputTokens;
      usage.outputTokensEstimated = true;
      if (usage.inputTokens !== undefined && usage.totalTokens === undefined) {
        usage.totalTokens = usage.inputTokens + outputTokens;
      }
    }
    phase = 'streaming';
    emit(now());
  };

  const complete = (providerUsage?: ScribeUsage): void => {
    if (terminal) return;
    const timestamp = now();
    const exact = usageSummaryFromUsage(providerUsage);
    if (exact.inputTokens !== undefined) {
      usage.inputTokens = exact.inputTokens;
      delete usage.inputTokensEstimated;
    }
    if (exact.outputTokens !== undefined) {
      usage.outputTokens = exact.outputTokens;
      delete usage.outputTokensEstimated;
    }
    if (exact.totalTokens !== undefined) usage.totalTokens = exact.totalTokens;
    if (exact.cachedInputTokens !== undefined) usage.cachedInputTokens = exact.cachedInputTokens;
    if (exact.reasoningOutputTokens !== undefined) usage.reasoningOutputTokens = exact.reasoningOutputTokens;
    if (usage.inputTokens !== undefined && usage.outputTokens !== undefined && usage.totalTokens === undefined) {
      usage.totalTokens = usage.inputTokens + usage.outputTokens;
    }
    if (usage.outputTokens !== undefined && firstOutputAt === undefined) firstOutputAt = timestamp;
    phase = 'completed';
    terminal = true;
    emit(timestamp);
  };

  const fail = (): void => {
    if (terminal) return;
    phase = 'failed';
    terminal = true;
    emit(now());
  };

  return { reportPhase, reportChunk, complete, fail };
}
