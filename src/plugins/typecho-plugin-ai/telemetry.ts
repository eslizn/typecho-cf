import type {
  AiChatMessage,
  AiChatRequest,
  AiChatStreamChunk,
  AiProgressEvent,
  AiTaskPhase,
  AiUsage,
  AiUsageSummary,
} from './types';

const PROGRESS_INTERVAL_MS = 100;
const TOKEN_BYTES_PER_ESTIMATE = 4;

export interface AiProgressReporter {
  reportPhase(phase: AiTaskPhase): void;
  reportChunk(chunk: AiChatStreamChunk): void;
  complete(usage?: AiUsage): void;
  fail(): void;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function estimateBytes(bytes: number): number {
  return bytes > 0 ? Math.max(1, Math.ceil(bytes / TOKEN_BYTES_PER_ESTIMATE)) : 0;
}

export function estimateTextTokens(value: string): number {
  return estimateBytes(new TextEncoder().encode(value).byteLength);
}

function messageTokenEstimate(message: AiChatMessage): number {
  if (!message || typeof message !== 'object') return 0;
  let total = estimateTextTokens(typeof message.role === 'string' ? message.role : '') + 4;
  if (typeof message.name === 'string' && message.name) total += estimateTextTokens(message.name);
  if (typeof message.content === 'string') {
    total += estimateTextTokens(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') total += estimateTextTokens(part.text);
      if (part.type === 'input_audio' && part.input_audio && typeof part.input_audio.format === 'string') {
        total += estimateTextTokens(part.input_audio.format);
      }
    }
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!call || typeof call !== 'object' || !call.function) continue;
    if (typeof call.function.name === 'string') total += estimateTextTokens(call.function.name);
    if (typeof call.function.arguments === 'string') total += estimateTextTokens(call.function.arguments);
  }
  if (message.function_call && typeof message.function_call === 'object') {
    if (typeof message.function_call.name === 'string') total += estimateTextTokens(message.function_call.name);
    if (typeof message.function_call.arguments === 'string') total += estimateTextTokens(message.function_call.arguments);
  }
  return total;
}

export function estimateChatInputTokens(request: AiChatRequest): number {
  let total = (Array.isArray(request?.messages) ? request.messages : [])
    .reduce((sum, message) => sum + messageTokenEstimate(message), 0);
  for (const tool of Array.isArray(request?.tools) ? request.tools : []) {
    if (!tool || typeof tool !== 'object' || !tool.function) continue;
    if (typeof tool.function.name === 'string') total += estimateTextTokens(tool.function.name);
    if (typeof tool.function.description === 'string') total += estimateTextTokens(tool.function.description);
    total += estimateJsonTokens(tool.function.parameters);
  }
  for (const fn of Array.isArray(request?.functions) ? request.functions : []) {
    if (!fn || typeof fn !== 'object') continue;
    if (typeof fn.name === 'string') total += estimateTextTokens(fn.name);
    if (typeof fn.description === 'string') total += estimateTextTokens(fn.description);
    total += estimateJsonTokens(fn.parameters);
  }
  return total;
}

function estimateJsonTokens(value: unknown): number {
  if (value === undefined) return 0;
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' ? estimateTextTokens(encoded) : 0;
  } catch {
    return 0;
  }
}

function chunkTokenEstimate(chunk: AiChatStreamChunk): number {
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const choice of chunk.choices) {
    if (choice.delta.content) bytes += encoder.encode(choice.delta.content).byteLength;
    for (const call of choice.delta.tool_calls ?? []) {
      bytes += encoder.encode(call.function.name).byteLength;
      bytes += encoder.encode(call.function.arguments).byteLength;
    }
    if (choice.delta.audio?.data) bytes += choice.delta.audio.data.byteLength;
  }
  return estimateBytes(bytes);
}

export function summarizeAiUsage(usage?: AiUsage): AiUsageSummary {
  if (!usage) return {};
  const inputTokens = safeInteger(usage.input_tokens) ?? safeInteger(usage.prompt_tokens);
  const outputTokens = safeInteger(usage.output_tokens) ?? safeInteger(usage.completion_tokens);
  const totalTokens = safeInteger(usage.total_tokens);
  const cachedInputTokens = safeInteger(usage.input_tokens_details?.cached_tokens)
    ?? safeInteger(usage.prompt_tokens_details?.cached_tokens);
  const reasoningOutputTokens = safeInteger(usage.output_tokens_details?.reasoning_tokens)
    ?? safeInteger(usage.completion_tokens_details?.reasoning_tokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
  };
}

function rate(tokens: number | undefined, startedAt: number | undefined, endedAt: number): number | undefined {
  if (tokens === undefined || tokens <= 0 || startedAt === undefined) return undefined;
  const elapsed = endedAt - startedAt;
  if (elapsed <= 0) return undefined;
  return Math.round((tokens * 1000 / elapsed) * 100) / 100;
}

export function createAiProgressReporter(
  request: AiChatRequest,
  onProgress?: (event: AiProgressEvent) => void,
  now: () => number = Date.now,
): AiProgressReporter {
  const startedAt = now();
  let phase: AiTaskPhase = 'queued';
  let requestingStartedAt: number | undefined;
  let firstOutputAt: number | undefined;
  let outputStartedAt: number | undefined;
  let estimatedOutputTokens = 0;
  let usage: AiUsageSummary = {};
  let lastEmittedAt = Number.NEGATIVE_INFINITY;
  let terminal = false;

  const inputEstimate = Array.isArray(request?.messages) ? estimateChatInputTokens(request) : 0;
  if (inputEstimate > 0) {
    usage.inputTokens = inputEstimate;
    usage.inputTokensEstimated = true;
  }

  function updateDerivedTotal(): void {
    if (usage.totalTokens !== undefined) return;
    if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
      usage.totalTokens = usage.inputTokens + usage.outputTokens;
    }
  }

  function mergeProviderUsage(providerUsage?: AiUsage): void {
    const summary = summarizeAiUsage(providerUsage);
    if (summary.inputTokens !== undefined) {
      usage.inputTokens = summary.inputTokens;
      delete usage.inputTokensEstimated;
    }
    if (summary.outputTokens !== undefined) {
      usage.outputTokens = summary.outputTokens;
      delete usage.outputTokensEstimated;
    }
    if (summary.totalTokens !== undefined) usage.totalTokens = summary.totalTokens;
    if (summary.cachedInputTokens !== undefined) usage.cachedInputTokens = summary.cachedInputTokens;
    if (summary.reasoningOutputTokens !== undefined) usage.reasoningOutputTokens = summary.reasoningOutputTokens;
    updateDerivedTotal();
  }

  function makeEvent(timestamp: number): AiProgressEvent {
    return {
      phase,
      elapsedMs: Math.max(0, timestamp - startedAt),
      ...(firstOutputAt === undefined ? {} : { timeToFirstTokenMs: Math.max(0, firstOutputAt - startedAt) }),
      usage: { ...usage },
      inputTokensPerSecond: rate(usage.inputTokens, requestingStartedAt, outputStartedAt ?? timestamp),
      outputTokensPerSecond: rate(usage.outputTokens, outputStartedAt, timestamp),
    };
  }

  function emit(force = false): void {
    const timestamp = now();
    if (!force && timestamp - lastEmittedAt < PROGRESS_INTERVAL_MS) return;
    lastEmittedAt = timestamp;
    if (!onProgress) return;
    try {
      onProgress(makeEvent(timestamp));
    } catch {
      // Telemetry must never affect the generation result.
    }
  }

  function reportPhase(nextPhase: AiTaskPhase): void {
    if (terminal) return;
    phase = nextPhase;
    if (nextPhase === 'requesting' && requestingStartedAt === undefined) requestingStartedAt = now();
    emit(true);
  }

  function reportChunk(chunk: AiChatStreamChunk): void {
    if (terminal) return;
    const additionalTokens = chunkTokenEstimate(chunk);
    const timestamp = now();
    if (additionalTokens > 0) {
      if (firstOutputAt === undefined) firstOutputAt = timestamp;
      if (outputStartedAt === undefined) outputStartedAt = firstOutputAt;
      estimatedOutputTokens += additionalTokens;
      if (usage.outputTokens === undefined || usage.outputTokensEstimated) {
        usage.outputTokens = estimatedOutputTokens;
        usage.outputTokensEstimated = true;
        updateDerivedTotal();
      }
    }
    if (phase !== 'streaming') phase = 'streaming';
    emit(false);
  }

  function complete(providerUsage?: AiUsage): void {
    if (terminal) return;
    const timestamp = now();
    mergeProviderUsage(providerUsage);
    if (usage.outputTokens !== undefined && outputStartedAt === undefined) outputStartedAt = requestingStartedAt ?? startedAt;
    if (usage.outputTokens !== undefined && firstOutputAt === undefined) firstOutputAt = timestamp;
    phase = 'completed';
    terminal = true;
    emit(true);
  }

  function fail(): void {
    if (terminal) return;
    phase = 'failed';
    terminal = true;
    emit(true);
  }

  return { reportPhase, reportChunk, complete, fail };
}
