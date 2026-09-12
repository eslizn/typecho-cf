/**
 * Chat stream handling: SSE parsing for streaming completions, plus the
 * message/usage/audio normalizers shared with the non-streaming response
 * path in chat.ts.
 */
import { readWithDeadline, aiTimeoutError, decodeBase64, isRecord } from './io';
import { AiCapabilityError, AI_ERROR_CODES } from './errors';
import type {
  AiAudioOutput,
  AiNormalizedMessage,
  AiToolCall,
  AiUsage,
} from './types';
import type { AiChatStreamChunk } from './types';
import type { AiModelCandidate } from './provider';
export function numberOr(fallback: number, value: unknown): number {
  return Number.isSafeInteger(value) ? value as number : fallback;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
export function normalizeToolCalls(value: unknown): AiToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((call, index) => {
    const fn = isRecord(call.function) ? call.function : {};
    return {
      id: typeof call.id === 'string' ? call.id : `call_${index}`,
      type: 'function' as const,
      function: {
        name: typeof fn.name === 'string' ? fn.name : '',
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    };
  }).filter(call => call.function.name.length > 0);
}

/** Preserve argument-only fragments in streaming tool calls. */
export function normalizeStreamToolCalls(value: unknown): AiToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((call, index) => {
    const fn = isRecord(call.function) ? call.function : {};
    return {
      id: typeof call.id === 'string' ? call.id : `call_${index}`,
      type: 'function' as const,
      function: {
        name: typeof fn.name === 'string' ? fn.name : '',
        arguments: typeof fn.arguments === 'string' ? fn.arguments : '',
      },
    };
  }).filter(call => call.function.name.length > 0 || call.function.arguments.length > 0);
}

export function normalizeUsage(value: unknown): AiUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: AiUsage = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
    if (Number.isSafeInteger(value[key])) usage[key] = value[key] as number;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function normalizeAudio(value: Record<string, unknown>, maxMediaBytes: number): AiAudioOutput {
  const data = typeof value.data === 'string' ? decodeBase64(value.data, maxMediaBytes) : new Uint8Array();
  return {
    data,
    id: typeof value.id === 'string' ? value.id : undefined,
    format: typeof value.format === 'string' ? value.format : undefined,
    expires_at: Number.isSafeInteger(value.expires_at) ? value.expires_at as number : undefined,
    transcript: typeof value.transcript === 'string' ? value.transcript : undefined,
  };
}
export function createChatStream(
  body: ReadableStream<Uint8Array>,
  candidate: AiModelCandidate,
  maxOutputBytes: number,
  maxMediaBytes: number,
  signal: AbortSignal,
  deadline: number,
): ReadableStream<AiChatStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let outputBytes = 0;
  let wireBytes = 0;
  let done = false;

  return new ReadableStream<AiChatStreamChunk>({
    async pull(controller) {
      if (done) {
        controller.close();
        return;
      }
      try {
        while (true) {
          buffer = buffer.replace(/\r\n/g, '\n');
          const eventEnd = findSseEventEnd(buffer);
          if (eventEnd >= 0) {
            const event = buffer.slice(0, eventEnd);
            buffer = buffer.slice(eventEnd + 2);
            const data = sseData(event);
            if (!data) continue;
            if (data === '[DONE]') {
              done = true;
              controller.close();
              return;
            }
            const parsed = JSON.parse(data) as unknown;
            const chunk = normalizeStreamChunk(parsed, candidate, maxMediaBytes);
            outputBytes += chunkOutputBytes(chunk);
            if (outputBytes > maxOutputBytes) throw new AiCapabilityError(AI_ERROR_CODES.upstreamServerError, 'The upstream stream is too large.');
            controller.enqueue(chunk);
            return;
          }
          const next = await readWithDeadline(reader, deadline, signal, aiTimeoutError());
          if (next.done) {
            buffer += decoder.decode().replace(/\r\n/g, '\n');
            if (new TextEncoder().encode(buffer).byteLength > maxOutputBytes) {
              throw new AiCapabilityError(AI_ERROR_CODES.upstreamServerError, 'The upstream stream is too large.');
            }
            const data = sseData(buffer);
            buffer = '';
            done = true;
            if (data && data !== '[DONE]') {
              const chunk = normalizeStreamChunk(JSON.parse(data) as unknown, candidate, maxMediaBytes);
              outputBytes += chunkOutputBytes(chunk);
              if (outputBytes > maxOutputBytes) throw new AiCapabilityError(AI_ERROR_CODES.upstreamServerError, 'The upstream stream is too large.');
              controller.enqueue(chunk);
            }
            controller.close();
            return;
          }
          wireBytes += next.value.byteLength;
          if (wireBytes > maxOutputBytes) {
            throw new AiCapabilityError(AI_ERROR_CODES.upstreamServerError, 'The upstream stream is too large.');
          }
          buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, '\n');
          if (new TextEncoder().encode(buffer).byteLength > maxOutputBytes) {
            throw new AiCapabilityError(AI_ERROR_CODES.upstreamServerError, 'The upstream stream is too large.');
          }
        }
      } catch (error) {
        done = true;
        void reader.cancel().catch(() => {});
        controller.error(error instanceof AiCapabilityError ? error : new AiCapabilityError(AI_ERROR_CODES.upstreamServerError, 'The upstream stream is invalid.'));
      }
    },
    cancel() {
      done = true;
      void reader.cancel().catch(() => {});
    },
  });
}

export function normalizeStreamChunk(body: unknown, candidate: AiModelCandidate, maxMediaBytes: number): AiChatStreamChunk {
  if (!isRecord(body)) throw new AiCapabilityError(AI_ERROR_CODES.upstreamServerError, 'The upstream returned an invalid stream chunk.');
  const choices = Array.isArray(body.choices) ? body.choices.map((choice, index) => {
    const raw = isRecord(choice) ? choice : {};
    const delta = isRecord(raw.delta) ? raw.delta : {};
    const normalizedDelta: AiChatStreamChunk['choices'][number]['delta'] = {};
    if (delta.role === 'assistant') normalizedDelta.role = 'assistant';
    if (typeof delta.content === 'string' || delta.content === null) normalizedDelta.content = delta.content;
    const calls = normalizeStreamToolCalls(delta.tool_calls);
    if (calls.length > 0) normalizedDelta.tool_calls = calls;
    if (isRecord(delta.function_call)) {
      const legacy = {
        id: 'call_legacy_0',
        type: 'function' as const,
        function: {
          name: typeof delta.function_call.name === 'string' ? delta.function_call.name : '',
          arguments: typeof delta.function_call.arguments === 'string' ? delta.function_call.arguments : '',
        },
      };
      normalizedDelta.tool_calls = [...(normalizedDelta.tool_calls ?? []), legacy];
    }
    if (isRecord(delta.audio) && typeof delta.audio.data === 'string') normalizedDelta.audio = normalizeAudio(delta.audio, maxMediaBytes);
    return {
      index: numberOr(index, raw.index),
      delta: normalizedDelta,
      finish_reason: typeof raw.finish_reason === 'string' || raw.finish_reason === null ? raw.finish_reason : undefined,
    };
  }) : [];
  return {
    id: typeof body.id === 'string' ? body.id : crypto.randomUUID(),
    object: 'chat.completion.chunk',
    created: numberOr(Math.floor(Date.now() / 1000), body.created),
    model: candidate.logicalModel,
    choices,
    usage: normalizeUsage(body.usage),
  };
}

export function chunkOutputBytes(chunk: AiChatStreamChunk): number {
  let bytes = 0;
  for (const choice of chunk.choices) {
    if (choice.delta.content) bytes += new TextEncoder().encode(choice.delta.content).byteLength;
    if (choice.delta.audio?.data) bytes += choice.delta.audio.data.byteLength;
    for (const call of choice.delta.tool_calls ?? []) bytes += new TextEncoder().encode(call.function.arguments).byteLength;
  }
  return bytes;
}
export function findSseEventEnd(value: string): number {
  const lf = value.indexOf('\n\n');
  return lf;
}

export function sseData(event: string): string {
  return event.split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
    .trim();
}
