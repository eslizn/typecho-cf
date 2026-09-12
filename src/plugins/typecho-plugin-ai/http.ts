import { getClientIp, timeSafeEqual } from 'typecho/plugin-sdk';
import { AI_ERROR_CODES, AiCapabilityError, isAiCapabilityError } from './errors';
import { encodeBase64, isRecord, readBoundedBytes } from './io';
import {
  AI_REQUEST_LIMITS,
  listChatModels,
} from './provider';
import type {
  AiChatGenerationService,
  AiChatMessage,
  AiChatRequest,
  AiChatResponse,
  AiChatResult,
  AiChatStreamChunk,
  AiContentPart,
  AiFunctionCall,
  AiTool,
  AiToolCall,
  AiAudioOutput,
  AiConfig,
} from './types';

// Failure limiting and the concurrency cap below are intentionally
    // isolate-local and never shared across PoPs: bearer tokens carry 16-128
    // random characters, so these counters only raise the cost of abuse and
    // protect this isolate's upstream budget. Shared limits (login) live in D1.
const AUTH_FAILURE_WINDOW_MS = 60_000;
const AUTH_FAILURE_LIMIT = 20;
const AUTH_FAILURE_MAX_KEYS = 1_024;
const HTTP_MAX_CONCURRENT_GENERATIONS = 4;
const failedAuth = new Map<string, { count: number; resetAt: number }>();
let activeGenerations = 0;

export interface AiHttpHandlerOptions {
  request: Request;
  path: string;
  config: AiConfig;
  service: AiChatGenerationService;
}

/**
 * Serve the optional OpenAI-compatible HTTP surface.
 *
 * Returning null means the request is outside the configured endpoint. The
 * caller can then leave it to the normal plugin route chain. Once a request
 * is inside the endpoint, authentication happens before method handling.
 */
/**
 * True when the path is one of the two OpenAI-compatible endpoints.
 *
 * Callers check this before resolving the capability, so paths that merely sit
 * under the configured base path prefix still fall through to the normal plugin
 * route chain instead of answering with an AI-specific error.
 */
export function isAiHttpEndpointPath(config: AiConfig, path: string): boolean {
  if (!config.http.enabled) return false;
  return path === `${config.http.basePath}/v1/models`
    || path === `${config.http.basePath}/v1/chat/completions`;
}

export async function handleAiHttpRequest(
  options: AiHttpHandlerOptions,
): Promise<Response | null> {
  const { request, path, config, service } = options;
  if (!isAiHttpEndpointPath(config, path)) return null;

  const modelsPath = `${config.http.basePath}/v1/models`;
  const completionsPath = `${config.http.basePath}/v1/chat/completions`;

  const authError = authenticateBearer(request, config.http.tokens.map(entry => entry.token));
  if (authError) return authError;

  if (path === modelsPath) {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return jsonResponse({
      object: 'list',
      data: listChatModels(config).map(id => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'typecho-plugin-ai',
      })),
    });
  }

  if (request.method !== 'POST') return methodNotAllowed('POST');

  if (activeGenerations >= HTTP_MAX_CONCURRENT_GENERATIONS) {
    return jsonResponse({
      error: {
        message: 'Too many AI requests are in progress. Try again later.',
        type: 'server_error',
        code: 'rate_limited',
      },
    }, 429, { 'Retry-After': '1' });
  }

  activeGenerations += 1;
  let handedOffStream = false;
  try {
    const bodyDeadline = Date.now() + AI_REQUEST_LIMITS.timeoutMs;
    const body = await readBoundedJson(request, AI_REQUEST_LIMITS.requestBodyBytes, request.signal, bodyDeadline);
    const chatRequest = parseChatRequest(body);
    const result = await service.generate(chatRequest);
    if (isReadableStream(result)) {
      const response = streamResponse(result, () => releaseGeneration());
      handedOffStream = true;
      return response;
    }
    return jsonResponse(toPublicChatResponse(result));
  } catch (error) {
    return aiErrorResponse(error);
  } finally {
    if (!handedOffStream) releaseGeneration();
  }
}

function releaseGeneration(): void {
  activeGenerations = Math.max(0, activeGenerations - 1);
}

export function parseChatRequest(value: unknown): AiChatRequest {
  if (!isRecord(value)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'The request body must be a JSON object.');
  }
  const rawMessages = value.messages;
  if (!Array.isArray(rawMessages)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'messages must be an array.');
  }

  const request: AiChatRequest = {
    messages: rawMessages.map(parseMessage),
  };
  copyKnownRequestFields(value, request);

  const rawTools = value.tools;
  if (rawTools !== undefined) {
    if (!Array.isArray(rawTools)) {
      throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'tools must be an array.');
    }
    request.tools = rawTools as AiTool[];
  }

  // Keep the deprecated OpenAI shape usable while normalizing it to the
  // internal modern tools contract. Direct SDK callers may still use the
  // legacy fields when they explicitly need a legacy upstream request.
  if (value.functions !== undefined) {
    if (!Array.isArray(value.functions)) {
      throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'functions must be an array.');
    }
    if (request.tools === undefined) {
      request.tools = value.functions.map((fn) => ({
        type: 'function' as const,
        function: fn,
      })) as AiTool[];
    }
  }
  if (value.function_call !== undefined) {
    const functionCall = parseFunctionCallChoice(value.function_call);
    if (request.tool_choice === undefined) {
      if (functionCall === 'none' || functionCall === 'auto') {
        request.tool_choice = functionCall;
      } else {
        request.tool_choice = { type: 'function', function: { name: functionCall.name } };
      }
    }
  }

  return request;
}

function copyKnownRequestFields(value: Record<string, unknown>, request: AiChatRequest): void {
  const scalarKeys = [
    'model', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens',
    'stream', 'tool_choice', 'parallel_tool_calls', 'modalities', 'audio', 'user',
    'n', 'stop', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'logprobs',
    'top_logprobs', 'response_format', 'stream_options', 'seed', 'reasoning_effort',
    'metadata', 'prediction', 'store', 'service_tier',
  ] as const;
  for (const key of scalarKeys) {
    if (Object.hasOwn(value, key)) (request as unknown as Record<string, unknown>)[key] = value[key];
  }
}

function parseMessage(value: unknown): AiChatMessage {
  if (!isRecord(value)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Each message must be an object.');
  }
  const role = value.role;
  if (!['developer', 'system', 'user', 'assistant', 'tool'].includes(String(role))) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Unsupported message role.');
  }
  const message: AiChatMessage = {
    role: role as AiChatMessage['role'],
  };
  if (Object.hasOwn(value, 'content')) {
    message.content = parseMessageContent(value.content);
  }
  if (typeof value.name === 'string') message.name = value.name;
  if (typeof value.tool_call_id === 'string') message.tool_call_id = value.tool_call_id;
  if (value.tool_calls !== undefined) message.tool_calls = parseToolCalls(value.tool_calls);
  if (value.function_call !== undefined) message.function_call = parseFunctionCall(value.function_call);
  return message;
}

function parseMessageContent(value: unknown): AiChatMessage['content'] {
  if (value === null || typeof value === 'string') return value;
  if (!Array.isArray(value)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'message.content must be a string or array.');
  }
  return value.map(parseContentPart);
}

function parseContentPart(value: unknown): AiContentPart {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Invalid message content part.');
  }
  if (value.type === 'text') {
    if (typeof value.text !== 'string') {
      throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Text content must contain text.');
    }
    return { type: 'text', text: value.text };
  }
  if (value.type === 'image_url') {
    if (!isRecord(value.image_url) || typeof value.image_url.url !== 'string') {
      throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'image_url must contain a URL or data URL.');
    }
    const detail = value.image_url.detail;
    if (detail !== undefined && detail !== 'auto' && detail !== 'low' && detail !== 'high') {
      throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'Unsupported image detail.');
    }
    return {
      type: 'image_url',
      image_url: {
        url: value.image_url.url,
        detail,
      },
    };
  }
  if (value.type === 'input_audio') {
    if (!isRecord(value.input_audio) || typeof value.input_audio.data !== 'string' || typeof value.input_audio.format !== 'string') {
      throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'input_audio must contain base64 data and format.');
    }
    return {
      type: 'input_audio',
      input_audio: {
        data: value.input_audio.data,
        format: value.input_audio.format,
      },
    };
  }
  throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, `Unsupported content part type: ${value.type}.`);
}

function parseToolCalls(value: unknown): AiToolCall[] {
  if (!Array.isArray(value)) {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'tool_calls must be an array.');
  }
  return value.map((item, index) => {
    if (!isRecord(item) || !isRecord(item.function)) {
      throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, `Invalid tool call at index ${index}.`);
    }
    return {
      id: typeof item.id === 'string' ? item.id : `call_${index}`,
      type: 'function',
      function: {
        name: typeof item.function.name === 'string' ? item.function.name : '',
        arguments: typeof item.function.arguments === 'string' ? item.function.arguments : JSON.stringify(item.function.arguments ?? {}),
      },
    };
  });
}

function parseFunctionCall(value: unknown): AiFunctionCall {
  if (!isRecord(value) || typeof value.name !== 'string') {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'function_call must contain a name.');
  }
  return {
    name: value.name,
    arguments: typeof value.arguments === 'string' ? value.arguments : JSON.stringify(value.arguments ?? {}),
  };
}

function parseFunctionCallChoice(value: unknown): NonNullable<AiChatRequest['function_call']> {
  if (value === 'none' || value === 'auto') return value;
  const call = parseFunctionCall(value);
  return { name: call.name };
}

function authenticateBearer(request: Request, tokens: ReadonlyArray<string>): Response | null {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer[ \t]+([^ \t\r\n]+)$/i.exec(header);
  const candidate = match && match[1].length <= 4096 ? match[1] : '';
  // Every configured token is compared before the result is used, so neither
  // the response time nor the order reveals which token matched. Zero tokens
  // means the endpoint is unreachable, never open.
  let valid = false;
  for (const token of tokens) {
    const matches = token.length > 0 ? timeSafeEqual(candidate, token) : false;
    if (matches) valid = true;
  }
  const key = getClientIp(request) || 'unknown';
  const now = Date.now();
  const current = failedAuth.get(key);
  if (current && current.resetAt <= now) failedAuth.delete(key);
  if (valid) {
    failedAuth.delete(key);
    return null;
  }
  const state = failedAuth.get(key);
  if (state && state.count >= AUTH_FAILURE_LIMIT) {
    return new Response(JSON.stringify({
      error: {
        message: 'Too many invalid bearer token attempts. Try again later.',
        type: 'authentication_error',
        code: 'rate_limited',
      },
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': String(Math.max(1, Math.ceil((state.resetAt - now) / 1000))),
      },
    });
  }
  failedAuth.set(key, {
    count: (state?.count ?? 0) + 1,
    resetAt: state?.resetAt ?? now + AUTH_FAILURE_WINDOW_MS,
  });
  if (failedAuth.size > AUTH_FAILURE_MAX_KEYS) {
    for (const [entryKey, entry] of failedAuth) {
      if (entry.resetAt <= now || failedAuth.size > AUTH_FAILURE_MAX_KEYS) failedAuth.delete(entryKey);
      if (failedAuth.size <= AUTH_FAILURE_MAX_KEYS) break;
    }
  }
  {
    return new Response(JSON.stringify({
      error: {
        message: 'Invalid or missing bearer token.',
        type: 'authentication_error',
        code: 'invalid_api_key',
      },
    }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'WWW-Authenticate': 'Bearer',
      },
    });
  }
}

function methodNotAllowed(method: string): Response {
  return new Response(JSON.stringify({
    error: { message: `Method not allowed. Use ${method}.`, type: 'invalid_request_error', code: 'method_not_allowed' },
  }), {
    status: 405,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Allow': method, 'Cache-Control': 'no-store' },
  });
}

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function aiErrorResponse(error: unknown): Response {
  const aiError = isAiCapabilityError(error)
    ? error
    : new AiCapabilityError(AI_ERROR_CODES.upstreamServerError, 'AI request failed.');
  const type = aiError.code === AI_ERROR_CODES.invalidRequest
    || aiError.code === AI_ERROR_CODES.modelNotFound
    || aiError.code === AI_ERROR_CODES.unsupportedModality
    || aiError.code === AI_ERROR_CODES.unsupportedFeature
    ? 'invalid_request_error'
    : aiError.code === AI_ERROR_CODES.upstreamClientError
      ? 'upstream_error'
      : 'server_error';
  return jsonResponse({
    error: {
      message: aiError.message,
      type,
      code: aiError.code,
    },
  }, aiError.status);
}

function toPublicChatResponse(response: AiChatResponse): Record<string, unknown> {
  return {
    ...response,
    choices: response.choices.map(choice => ({
      ...choice,
      message: {
        ...choice.message,
        ...(choice.message.audio ? { audio: toPublicAudio(choice.message.audio) } : {}),
      },
    })),
  };
}

function streamResponse(
  stream: ReadableStream<AiChatStreamChunk>,
  onComplete: () => void,
): Response {
  const reader = stream.getReader();
  const encoder = new TextEncoder();
  let sentDone = false;
  let released = false;
  const complete = () => {
    if (released) return;
    released = true;
    onComplete();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          if (!sentDone) {
            sentDone = true;
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          }
          controller.close();
          complete();
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(toPublicStreamChunk(next.value))}\n\n`));
      } catch (error) {
        if (!sentDone) {
          sentDone = true;
          const failure = isAiCapabilityError(error)
            ? error
            : new AiCapabilityError(AI_ERROR_CODES.upstreamServerError, 'AI stream failed.');
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              error: { message: failure.message, type: 'server_error', code: failure.code },
            })}\n\ndata: [DONE]\n\n`));
          } catch {
            // The client may have cancelled the response while the upstream
            // stream was failing; there is no open controller to report to.
          }
        }
        try { controller.close(); } catch { /* already cancelled or closed */ }
        complete();
      }
    },
    cancel() {
      void reader.cancel().catch(() => {}).finally(complete);
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}

function toPublicStreamChunk(chunk: AiChatStreamChunk): Record<string, unknown> {
  return {
    ...chunk,
    choices: chunk.choices.map(choice => ({
      ...choice,
      delta: {
        ...choice.delta,
        ...(choice.delta.audio ? { audio: toPublicAudio(choice.delta.audio) } : {}),
      },
    })),
  };
}

function toPublicAudio(audio: AiAudioOutput): Record<string, unknown> {
  return { ...audio, data: encodeBase64(audio.data) };
}

async function readBoundedJson(
  request: Request,
  maxBytes: number,
  signal: AbortSignal,
  deadline: number,
): Promise<unknown> {
  const timeout = {
    message: 'The AI request timed out.',
    retryable: false,
  };
  if (signal.aborted) {
    throw new AiCapabilityError(AI_ERROR_CODES.upstreamTimeout, timeout.message, 504, timeout.retryable);
  }
  const bytes = await readBoundedBytes(request.body, {
    maxBytes,
    signal,
    deadline,
    declaredLength: request.headers.get('content-length'),
    tooLarge: () => new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'The request body is too large.', 413, false),
    onTimeout: () => new AiCapabilityError(AI_ERROR_CODES.upstreamTimeout, timeout.message, 504, timeout.retryable),
  });
  if (!bytes) return {};
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AiCapabilityError(AI_ERROR_CODES.invalidRequest, 'The request body is not valid JSON.');
  }
}

function isReadableStream(value: AiChatResult): value is ReadableStream<AiChatStreamChunk> {
  return !!value && typeof (value as ReadableStream<AiChatStreamChunk>).getReader === 'function';
}
