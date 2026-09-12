import {
  AI_REQUEST_LIMITS,
  buildProviderEndpoint,
  selectAiModel,
  type AiRequestLimits,
  type AiModelCandidate,
} from './provider';
import { AiCapabilityError, AI_ERROR_CODES } from './errors';
import { aiTimeoutError, decodeBase64, encodeBase64, isRecord, readBoundedBytes, readWithDeadline } from './io';
import type {
  AiAudioOutput,
  AiBinary,
  AiChatGenerationService,
  AiChatMessage,
  AiChatRequest,
  AiChatResponse,
  AiChatResult,
  AiChatStreamChunk,
  AiContentPart,
  AiFunctionCall,
  AiNormalizedMessage,
  AiToolCall,
  AiUsage,
  AiRuntimeContext,
  AiTool,
} from './types';
import type { AiConfig } from './types';

export interface AiChatServiceOptions {
  fetcher?: typeof fetch;
  limits?: AiRequestLimits;
}

export function createAiChatService(
  runtime: AiRuntimeContext,
  config: AiConfig,
  options: AiChatServiceOptions = {},
): AiChatGenerationService {
  const fetcher = options.fetcher ?? fetch;
  const limits = options.limits ?? AI_REQUEST_LIMITS;

  return {
    async generate(request: AiChatRequest): Promise<AiChatResult> {
      validateChatRequest(request, limits);
      const selection = selectAiModel(config, request);
      if (!selection.candidate) {
        throw new AiCapabilityError(
          selection.reason === 'model-not-found'
            ? AI_ERROR_CODES.modelNotFound
            : selection.reason === 'unsupported-modality'
              ? AI_ERROR_CODES.unsupportedModality
              : AI_ERROR_CODES.noAvailableModel,
          selection.reason === 'model-not-found'
            ? 'The requested model is not available.'
            : selection.reason === 'unsupported-modality'
              ? 'The selected model does not support the requested modality.'
              : 'No enabled AI model is available.',
        );
      }

      const candidate = selection.candidate;
      const deadline = Date.now() + limits.timeoutMs;
      const upstreamMessages = await convertMessages(request.messages, limits.maxMediaBytes, runtime.signal, deadline);
      const body = buildUpstreamBody(request, candidate, upstreamMessages);
      const encodedBody = JSON.stringify(body);
      if (new TextEncoder().encode(encodedBody).byteLength > limits.requestBodyBytes) {
        throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'The AI request body is too large.');
      }

      const response = await fetchUpstream(
        candidate,
        encodedBody,
        request.stream === true,
        runtime,
        fetcher,
        deadline,
      );
      if (!response.ok) throw await upstreamError(response);
      if (request.stream === true) {
        if (!response.body) throw new AiCapabilityError(AI_ERROR_CODES.upstreamServerError, 'The upstream returned an empty stream.');
        return createChatStream(
          response.body,
          candidate,
          limits.responseBodyBytes,
          limits.maxMediaBytes,
          runtime.signal,
          deadline,
        );
      }
      const upstream = await readJsonBounded(response, limits.responseBodyBytes, runtime.signal, deadline);
      return normalizeChatResponse(upstream, candidate, limits.maxMediaBytes);
    },
  };
}

export function validateChatRequest(request: AiChatRequest, limits: AiRequestLimits = AI_REQUEST_LIMITS): void {
  if (!request || !Array.isArray(request.messages) || request.messages.length === 0) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'messages must be a non-empty array.');
  }
  if (request.messages.length > limits.maxMessages) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Too many messages.');
  }
  if (request.model !== undefined && (typeof request.model !== 'string' || !request.model.trim())) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'model must be a non-empty string when provided.');
  }
  for (const message of request.messages) validateMessage(message, limits.maxTextBytes);
  if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length > limits.maxTools)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Too many tools.');
  }
  if (request.tools !== undefined) {
    const schemaBytes = jsonByteLength(request.tools);
    if (schemaBytes > limits.maxToolSchemaBytes) {
      throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Tool definitions are too large.');
    }
    if (request.tools.some(tool => (
      !isRecord(tool)
      || tool.type !== 'function'
      || !isRecord(tool.function)
      || typeof tool.function.name !== 'string'
      || !tool.function.name.trim()
    ))) {
      throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Invalid tool definition.');
    }
  }
  if (request.functions !== undefined) {
    if (!Array.isArray(request.functions) || request.functions.length > limits.maxTools) {
      throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Too many functions.');
    }
    const schemaBytes = jsonByteLength(request.functions);
    if (schemaBytes > limits.maxToolSchemaBytes) {
      throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Function definitions are too large.');
    }
    if (request.functions.some(fn => (
      !isRecord(fn) || typeof fn.name !== 'string' || !fn.name.trim()
    ))) {
      throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Invalid function definition.');
    }
  }
  if (request.temperature !== undefined && (!isFiniteNumber(request.temperature) || request.temperature < 0 || request.temperature > 2)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'temperature must be between 0 and 2.');
  }
  if (request.top_p !== undefined && (!isFiniteNumber(request.top_p) || request.top_p < 0 || request.top_p > 1)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'top_p must be between 0 and 1.');
  }
  for (const key of ['max_tokens', 'max_completion_tokens'] as const) {
    if (request[key] !== undefined && (!Number.isSafeInteger(request[key]) || request[key] < 1)) {
      throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, `${key} must be a positive integer.`);
    }
  }
  if (request.modalities !== undefined && (!Array.isArray(request.modalities) || request.modalities.some(value => value !== 'text' && value !== 'audio'))) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Unsupported output modality.');
  }
  if (request.stream !== undefined && typeof request.stream !== 'boolean') {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'stream must be boolean.');
  }
  if (request.parallel_tool_calls !== undefined && typeof request.parallel_tool_calls !== 'boolean') {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'parallel_tool_calls must be boolean.');
  }
  if (request.logprobs !== undefined && typeof request.logprobs !== 'boolean') {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'logprobs must be boolean.');
  }
  if (request.store !== undefined && typeof request.store !== 'boolean') {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'store must be boolean.');
  }
  if (request.tool_choice !== undefined && !isValidToolChoice(request.tool_choice)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Invalid tool_choice.');
  }
  if (request.function_call !== undefined && !isValidFunctionCallChoice(request.function_call)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Invalid function_call.');
  }
  if (request.audio !== undefined && (
    !isRecord(request.audio)
    || typeof request.audio.voice !== 'string'
    || typeof request.audio.format !== 'string'
    || request.audio.voice.length > 128
    || request.audio.format.length > 32
  )) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'audio must contain a bounded voice and format.');
  }
  if (request.n !== undefined && (!Number.isSafeInteger(request.n) || request.n < 1 || request.n > 16)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'n must be an integer between 1 and 16.');
  }
  for (const key of ['presence_penalty', 'frequency_penalty'] as const) {
    if (request[key] !== undefined && !isFiniteNumber(request[key])) {
      throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, `${key} must be between -2 and 2.`);
    }
  }
  if (request.top_logprobs !== undefined && (!Number.isSafeInteger(request.top_logprobs) || request.top_logprobs < 0 || request.top_logprobs > 20)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'top_logprobs must be between 0 and 20.');
  }
  if (request.stop !== undefined && request.stop !== null && !isStringOrStringArray(request.stop)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'stop must be a string or string array.');
  }
  if (request.user !== undefined && (typeof request.user !== 'string' || request.user.length > 1024)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'user is too long.');
  }
  if (request.response_format !== undefined && !isRecord(request.response_format)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'response_format must be an object.');
  }
  if (request.stream_options !== undefined && !isRecord(request.stream_options)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'stream_options must be an object.');
  }
  if (request.logit_bias !== undefined) {
    if (!isRecord(request.logit_bias) || Object.keys(request.logit_bias).length > 4096
      || Object.values(request.logit_bias).some(value => !isFiniteNumber(value))) {
      throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'logit_bias must contain finite numeric values.');
    }
  }
  if (request.seed !== undefined && !Number.isSafeInteger(request.seed)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'seed must be a safe integer.');
  }
  for (const key of ['reasoning_effort', 'service_tier'] as const) {
    if (request[key] !== undefined && (typeof request[key] !== 'string' || request[key].length > 128)) {
      throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, `${key} must be a bounded string.`);
    }
  }
  if (request.metadata !== undefined && (
    !isRecord(request.metadata)
    || Object.keys(request.metadata).length > 64
    || Object.entries(request.metadata).some(([key, value]) => key.length > 128 || typeof value !== 'string' || value.length > 1024)
  )) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'metadata must contain bounded string values.');
  }
  if (request.tools !== undefined && request.tools.some(tool => !isValidTool(tool, limits.maxTextBytes))) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Invalid tool definition.');
  }
  if (request.functions !== undefined && request.functions.some(fn => !isValidFunction(fn, limits.maxTextBytes))) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Invalid function definition.');
  }
}

async function convertMessages(
  messages: AiChatMessage[],
  maxMediaBytes: number,
  signal: AbortSignal,
  deadline: number,
): Promise<AiChatMessage[]> {
  const converted: AiChatMessage[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      converted.push({ ...message });
      continue;
    }
    const content: AiContentPart[] = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        content.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        const value = typeof part.image_url.url === 'string'
          ? part.image_url.url
          : await binaryDataUrl(part.image_url.url, part.image_url.mimeType || 'image/jpeg', maxMediaBytes, signal, deadline);
        content.push({ type: 'image_url', image_url: { url: value, detail: part.image_url.detail } });
      } else if (part.type === 'input_audio') {
        const value = typeof part.input_audio.data === 'string'
          ? part.input_audio.data
          : await binaryBase64(part.input_audio.data, maxMediaBytes, signal, deadline);
        content.push({ type: 'input_audio', input_audio: { data: value, format: part.input_audio.format } });
      } else {
        throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Unsupported content part.');
      }
    }
    converted.push({ ...message, content });
  }
  return converted;
}

function buildUpstreamBody(
  request: AiChatRequest,
  candidate: AiModelCandidate,
  messages: AiChatMessage[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: candidate.model.model,
    messages,
    stream: request.stream === true,
  };
  for (const key of [
    'temperature', 'top_p', 'max_tokens', 'max_completion_tokens',
    'modalities', 'audio', 'user',
    'n', 'stop', 'presence_penalty', 'frequency_penalty', 'logit_bias',
    'logprobs', 'top_logprobs', 'response_format', 'stream_options', 'seed',
    'reasoning_effort', 'metadata', 'prediction', 'store', 'service_tier',
  ] as const) {
    if (request[key] !== undefined) body[key] = request[key];
  }
  if (request.tools !== undefined || request.functions === undefined) {
    if (request.tools !== undefined) body.tools = request.tools;
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
    if (request.parallel_tool_calls !== undefined) body.parallel_tool_calls = request.parallel_tool_calls;
    if (request.tools === undefined && request.functions === undefined && request.function_call !== undefined) {
      body.function_call = request.function_call;
    }
  } else {
    body.functions = request.functions;
    if (request.function_call !== undefined) body.function_call = request.function_call;
  }
  return body;
}

async function fetchUpstream(
  candidate: AiModelCandidate,
  body: string,
  stream: boolean,
  runtime: AiRuntimeContext,
  fetcher: typeof fetch,
  deadline: number,
): Promise<Response> {
  if (runtime.signal.aborted) {
    throw new AiCapabilityError(AI_ERROR_CODES.upstreamTimeout, 'The upstream request timed out.');
  }
  const controller = new AbortController();
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new AiCapabilityError(AI_ERROR_CODES.upstreamTimeout, 'The upstream request timed out.');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const timeoutError = () => new AiCapabilityError(AI_ERROR_CODES.upstreamTimeout, 'The upstream request timed out.');
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, remaining);
  });
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(timeoutError());
  });
  const abort = () => {
    controller.abort();
    rejectAbort?.();
  };
  runtime.signal.addEventListener('abort', abort, { once: true });
  try {
    const headers = new Headers({
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
    });
    if (candidate.provider.apiKey) headers.set('Authorization', `Bearer ${candidate.provider.apiKey}`);
    return await Promise.race([
      fetcher(buildProviderEndpoint(candidate.provider.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      }),
      timeout,
      aborted,
    ]);
  } catch (error) {
    if (error instanceof AiCapabilityError) throw error;
    if (controller.signal.aborted || runtime.signal.aborted) {
      throw new AiCapabilityError(AI_ERROR_CODES.upstreamTimeout, 'The upstream request timed out.');
    }
    throw new AiCapabilityError(
      AI_ERROR_CODES.upstreamServerError,
      error instanceof Error ? `The upstream request failed: ${error.message}` : 'The upstream request failed.',
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    runtime.signal.removeEventListener('abort', abort);
  }
}

async function upstreamError(response: Response): Promise<AiCapabilityError> {
  const status = response.status;
  const code = status >= 500 || status === 429
    ? AI_ERROR_CODES.upstreamServerError
    : AI_ERROR_CODES.upstreamClientError;
  return new AiCapabilityError(code, `The upstream returned HTTP ${status}.`);
}

function normalizeChatResponse(body: unknown, candidate: AiModelCandidate, maxMediaBytes: number): AiChatResponse {
  if (!isRecord(body) || !Array.isArray(body.choices)) {
    throw new AiCapabilityError(AI_ERROR_CODES.upstreamServerError, 'The upstream returned an invalid chat response.');
  }
  const choices = body.choices.map((choice, index) => {
    if (!isRecord(choice)) throw new AiCapabilityError(AI_ERROR_CODES.upstreamServerError, 'The upstream returned an invalid choice.');
    const message = isRecord(choice.message) ? choice.message : {};
    return {
      index: numberOr(index, choice.index),
      message: normalizeAssistantMessage(message, maxMediaBytes),
      finish_reason: typeof choice.finish_reason === 'string' || choice.finish_reason === null ? choice.finish_reason : null,
    };
  });
  return {
    id: typeof body.id === 'string' ? body.id : crypto.randomUUID(),
    object: 'chat.completion',
    created: numberOr(Math.floor(Date.now() / 1000), body.created),
    model: candidate.logicalModel,
    choices,
    usage: normalizeUsage(body.usage),
  };
}

function normalizeAssistantMessage(message: Record<string, unknown>, maxMediaBytes: number): AiNormalizedMessage {
  const toolCalls = normalizeToolCalls(message.tool_calls);
  let legacyFunctionCall: AiFunctionCall | undefined;
  if (toolCalls.length === 0 && isRecord(message.function_call)) {
    const call = message.function_call;
    if (typeof call.name === 'string') {
      legacyFunctionCall = {
        name: call.name,
        arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
      };
      toolCalls.push({
        id: 'call_legacy_0',
        type: 'function',
        function: legacyFunctionCall,
      });
    }
  }
  const normalized: AiNormalizedMessage = {
    role: 'assistant',
    content: typeof message.content === 'string' || message.content === null ? message.content : null,
  };
  if (toolCalls.length > 0) normalized.tool_calls = toolCalls;
  if (legacyFunctionCall) normalized.function_call = legacyFunctionCall;
  if (isRecord(message.audio) && typeof message.audio.data === 'string') {
    normalized.audio = normalizeAudio(message.audio, maxMediaBytes);
  }
  return normalized;
}

function normalizeToolCalls(value: unknown): AiToolCall[] {
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
function normalizeStreamToolCalls(value: unknown): AiToolCall[] {
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

function normalizeUsage(value: unknown): AiUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: AiUsage = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
    if (Number.isSafeInteger(value[key])) usage[key] = value[key] as number;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function normalizeAudio(value: Record<string, unknown>, maxMediaBytes: number): AiAudioOutput {
  const data = typeof value.data === 'string' ? decodeBase64(value.data, maxMediaBytes) : new Uint8Array();
  return {
    data,
    id: typeof value.id === 'string' ? value.id : undefined,
    format: typeof value.format === 'string' ? value.format : undefined,
    expires_at: Number.isSafeInteger(value.expires_at) ? value.expires_at as number : undefined,
    transcript: typeof value.transcript === 'string' ? value.transcript : undefined,
  };
}
function createChatStream(
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

function normalizeStreamChunk(body: unknown, candidate: AiModelCandidate, maxMediaBytes: number): AiChatStreamChunk {
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

function chunkOutputBytes(chunk: AiChatStreamChunk): number {
  let bytes = 0;
  for (const choice of chunk.choices) {
    if (choice.delta.content) bytes += new TextEncoder().encode(choice.delta.content).byteLength;
    if (choice.delta.audio?.data) bytes += choice.delta.audio.data.byteLength;
    for (const call of choice.delta.tool_calls ?? []) bytes += new TextEncoder().encode(call.function.arguments).byteLength;
  }
  return bytes;
}
function validateMessage(message: AiChatMessage, maxTextBytes: number): void {
  if (!isRecord(message) || !['developer', 'system', 'user', 'assistant', 'tool'].includes(String(message.role))) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Unsupported message role.');
  }
  if (message.name !== undefined && (typeof message.name !== 'string' || message.name.length > 256)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Message name is invalid.');
  }
  if (message.tool_call_id !== undefined && (typeof message.tool_call_id !== 'string' || message.tool_call_id.length > 256)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'tool_call_id is invalid.');
  }
  if (message.tool_calls !== undefined && (
    !Array.isArray(message.tool_calls)
    || message.tool_calls.length > 64
    || message.tool_calls.some(call => !isValidToolCall(call, maxTextBytes))
  )) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Invalid tool call.');
  }
  if (message.function_call !== undefined && !isValidFunctionCall(message.function_call, maxTextBytes)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Invalid function call.');
  }
  if (typeof message.content === 'string') {
    if (new TextEncoder().encode(message.content).byteLength > maxTextBytes) {
      throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Message content is too large.');
    }
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isRecord(part) || !['text', 'image_url', 'input_audio'].includes(String(part.type))) {
        throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Unsupported content part.');
      }
      if (part.type === 'text') {
        if (typeof part.text !== 'string' || new TextEncoder().encode(part.text).byteLength > maxTextBytes) {
          throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Message text part is invalid or too large.');
        }
      } else if (part.type === 'image_url') {
        if (!isRecord(part.image_url)) {
          throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'image_url must be an object.');
        }
        if (!isStringOrBinary(part.image_url.url) || (typeof part.image_url.url === 'string' && part.image_url.url.length > maxTextBytes)) {
          throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'image_url.url is invalid or too large.');
        }
        if (part.image_url.detail !== undefined && !['auto', 'low', 'high'].includes(String(part.image_url.detail))) {
          throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Unsupported image detail.');
        }
        if (part.image_url.mimeType !== undefined && (typeof part.image_url.mimeType !== 'string' || part.image_url.mimeType.length > 128)) {
          throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'image MIME type is invalid.');
        }
      } else if (part.type === 'input_audio') {
        if (!isRecord(part.input_audio)
          || !isStringOrBinary(part.input_audio.data)
          || typeof part.input_audio.format !== 'string'
          || !part.input_audio.format
          || part.input_audio.format.length > 32
        ) {
          throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'input_audio is invalid.');
        }
        if (typeof part.input_audio.data === 'string' && part.input_audio.data.length > maxTextBytes) {
          throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'input_audio data is too large.');
        }
      }
    }
  }
}

function isValidTool(value: unknown, maxTextBytes: number): value is AiTool {
  if (!isRecord(value) || value.type !== 'function' || !isRecord(value.function)) return false;
  const fn = value.function;
  if (typeof fn.name !== 'string' || !fn.name.trim() || fn.name.length > 256) return false;
  if (fn.description !== undefined && (typeof fn.description !== 'string' || fn.description.length > maxTextBytes)) return false;
  if (fn.strict !== undefined && typeof fn.strict !== 'boolean') return false;
  return fn.parameters === undefined || isRecord(fn.parameters);
}

function isValidFunction(value: unknown, maxTextBytes: number): value is NonNullable<AiChatRequest['functions']>[number] {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 256) return false;
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > maxTextBytes)) return false;
  return value.parameters === undefined || isRecord(value.parameters);
}

function isValidToolCall(value: unknown, maxTextBytes: number): value is AiToolCall {
  if (!isRecord(value) || (value.id !== undefined && (typeof value.id !== 'string' || value.id.length > 256))) return false;
  if (value.type !== undefined && value.type !== 'function') return false;
  if (!isRecord(value.function) || typeof value.function.name !== 'string' || !value.function.name.trim()) return false;
  return typeof value.function.arguments === 'string'
    && new TextEncoder().encode(value.function.arguments).byteLength <= maxTextBytes;
}

function isValidFunctionCall(value: unknown, maxTextBytes: number): value is AiFunctionCall {
  return isRecord(value)
    && typeof value.name === 'string'
    && !!value.name.trim()
    && value.name.length <= 256
    && typeof value.arguments === 'string'
    && new TextEncoder().encode(value.arguments).byteLength <= maxTextBytes;
}

function isValidToolChoice(value: unknown): value is AiChatRequest['tool_choice'] {
  if (value === 'none' || value === 'auto' || value === 'required') return true;
  return isRecord(value)
    && value.type === 'function'
    && isRecord(value.function)
    && typeof value.function.name === 'string'
    && !!value.function.name.trim()
    && value.function.name.length <= 256;
}

function isValidFunctionCallChoice(value: unknown): value is AiChatRequest['function_call'] {
  if (value === 'none' || value === 'auto') return true;
  return isRecord(value)
    && typeof value.name === 'string'
    && !!value.name.trim()
    && value.name.length <= 256;
}

async function binaryDataUrl(
  data: AiBinary,
  mimeType: string,
  maxBytes: number,
  signal: AbortSignal,
  deadline: number,
): Promise<string> {
  return `data:${mimeType};base64,${await binaryBase64(data, maxBytes, signal, deadline)}`;
}

export async function binaryBase64(
  data: AiBinary,
  maxBytes: number,
  signal: AbortSignal,
  deadline: number,
): Promise<string> {
  const bytes = await readBinary(data, maxBytes, signal, deadline);
  return encodeBase64(bytes);
}

export async function readBinary(
  data: AiBinary,
  maxBytes: number,
  signal: AbortSignal,
  deadline: number,
): Promise<Uint8Array> {
  if (data instanceof Uint8Array) {
    if (data.byteLength > maxBytes) throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Media input is too large.');
    return data;
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > maxBytes) throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Media input is too large.');
    return new Uint8Array(data);
  }
  const reader = data.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readWithDeadline(reader, deadline, signal, aiTimeoutError());
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Media input is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function readJsonBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  const bytes = await readBoundedBytes(response.body, {
    maxBytes,
    signal,
    deadline: Date.now() + timeoutMs,
    declaredLength: response.headers.get('content-length'),
    tooLarge: () => new AiCapabilityError(AI_ERROR_CODES.upstreamServerError, 'The upstream response is too large.'),
  });
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AiCapabilityError(AI_ERROR_CODES.upstreamServerError, 'The upstream returned malformed JSON.');
  }
}

function findSseEventEnd(value: string): number {
  const lf = value.indexOf('\n\n');
  return lf;
}

function sseData(event: string): string {
  return event.split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
    .trim();
}
function numberOr(fallback: number, value: unknown): number {
  return Number.isSafeInteger(value) ? value as number : fallback;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function isStringOrBinary(value: unknown): value is string | AiBinary {
  return typeof value === 'string'
    || value instanceof Uint8Array
    || value instanceof ArrayBuffer
    || (!!value && typeof value === 'object' && typeof (value as ReadableStream<Uint8Array>).getReader === 'function');
}
export function isStringOrStringArray(value: unknown): value is string | string[] {
  return typeof value === 'string' || (Array.isArray(value) && value.every(item => typeof item === 'string'));
}


function jsonByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Request contains a non-serializable value.');
  }
}
