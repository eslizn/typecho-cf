/**
 * Binary input handling for the chat capability: data-URL/base64 conversion
 * and the bounded reader used for streamed image and audio parts.
 */
import { readWithDeadline, aiTimeoutError, encodeBase64 } from './io';
import { AiCapabilityError, AI_ERROR_CODES } from './errors';
import type { AiBinary } from './types';
export function isStringOrBinary(value: unknown): value is string | AiBinary {
  return typeof value === 'string'
    || value instanceof Uint8Array
    || value instanceof ArrayBuffer
    || (!!value && typeof value === 'object' && typeof (value as ReadableStream<Uint8Array>).getReader === 'function');
}
export async function binaryDataUrl(
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
