/**
 * Shared byte and JSON helpers for the AI plugin.
 *
 * The chat capability, the HTTP surface and provider validation all read
 * bounded streams against a deadline, so the mechanics (deadline race,
 * overflow abort, base64 handling) live here once instead of drifting apart in
 * three files.
 */
import { AI_ERROR_CODES, AiCapabilityError } from './errors';

/**
 * Default timeout error for a bounded read.
 *
 * The timeout is reported before the pending read is cancelled: cancelling
 * resolves `reader.read()` with `{ done: true }`, and letting that win the race
 * would silently turn a timeout into a truncated success.
 */
export function aiTimeoutError(
  message = 'The upstream request timed out.',
  retryable = true,
): () => Error {
  return () => new AiCapabilityError(AI_ERROR_CODES.upstreamTimeout, message, 504, retryable);
}

/** Race one stream read against the deadline, reporting `onTimeout` first. */
export async function readWithDeadline<T>(
  reader: ReadableStreamDefaultReader<T>,
  deadline: number,
  signal: AbortSignal,
  onTimeout: () => Error,
): Promise<ReadableStreamReadResult<T>> {
  const remaining = deadline - Date.now();
  if (remaining <= 0 || signal.aborted) {
    try { await reader.cancel(); } catch { /* preserve the timeout error */ }
    throw onTimeout();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fail: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    fail = () => {
      reject(onTimeout());
      void reader.cancel().catch(() => {});
    };
    timer = setTimeout(fail, remaining);
    signal.addEventListener('abort', fail, { once: true });
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (fail) signal.removeEventListener('abort', fail);
  }
}

export interface ReadBoundedBytesOptions {
  maxBytes: number;
  signal: AbortSignal;
  deadline: number;
  /** Declared Content-Length, when the caller already has it. */
  declaredLength?: string | null;
  /** Error thrown when the declared or observed size exceeds `maxBytes`. */
  tooLarge: () => Error;
  /** Error thrown when the deadline elapses. Defaults to an AI timeout. */
  onTimeout?: () => Error;
}

/** Read a stream to completion, aborting as soon as it passes the budget. */
export async function readBoundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  options: ReadBoundedBytesOptions,
): Promise<Uint8Array | null> {
  const { maxBytes, signal, deadline, tooLarge } = options;
  const onTimeout = options.onTimeout ?? aiTimeoutError();
  const declared = options.declaredLength;
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) throw tooLarge();
  if (!stream) return null;

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readWithDeadline(reader, deadline, signal, onTimeout);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

export function decodeBase64(value: string, maxBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new AiCapabilityError(AI_ERROR_CODES.upstreamServerError, 'The upstream returned invalid audio data.');
  }
  try {
    const binary = atob(value);
    if (binary.length > maxBytes) throw new AiCapabilityError(AI_ERROR_CODES.upstreamServerError, 'The upstream audio output is too large.');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch (error) {
    if (error instanceof AiCapabilityError) throw error;
    throw new AiCapabilityError(AI_ERROR_CODES.upstreamServerError, 'The upstream returned invalid audio data.');
  }
}

export function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
