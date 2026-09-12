import { describe, expect, it } from 'vitest';
import { AI_ERROR_CODES, AiCapabilityError } from './errors';
import { aiTimeoutError, readBoundedBytes, readWithDeadline } from './io';

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const tooLarge = () => new Error('too large');

describe('typecho-plugin-ai IO helpers', () => {
  it('reads a body within the byte budget', async () => {
    const bytes = await readBoundedBytes(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]), {
      maxBytes: 8,
      signal: new AbortController().signal,
      deadline: Date.now() + 1000,
      tooLarge,
    });

    expect([...(bytes ?? [])]).toEqual([1, 2, 3]);
  });

  it('rejects a declared length above the budget before reading', async () => {
    await expect(readBoundedBytes(streamOf([new Uint8Array([1])]), {
      maxBytes: 4,
      signal: new AbortController().signal,
      deadline: Date.now() + 1000,
      declaredLength: '99',
      tooLarge,
    })).rejects.toThrow('too large');
  });

  it('aborts a chunked body that outgrows the budget mid-stream', async () => {
    await expect(readBoundedBytes(streamOf([new Uint8Array(4), new Uint8Array(4)]), {
      maxBytes: 6,
      signal: new AbortController().signal,
      deadline: Date.now() + 1000,
      tooLarge,
    })).rejects.toThrow('too large');
  });

  it('reports the timeout instead of a truncated success', async () => {
    // The source delivers one chunk and then never settles. Cancelling the
    // pending read would resolve it with { done: true }; the deadline has to
    // win that race, otherwise a timeout silently becomes a short body.
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    });

    const failure = await readBoundedBytes(stalled, {
      maxBytes: 1024,
      signal: new AbortController().signal,
      deadline: Date.now() + 20,
      tooLarge,
      onTimeout: aiTimeoutError('The AI request timed out.', false),
    }).catch(error => error);

    expect(failure).toBeInstanceOf(AiCapabilityError);
    expect((failure as AiCapabilityError).code).toBe(AI_ERROR_CODES.upstreamTimeout);
    expect((failure as AiCapabilityError).retryable).toBe(false);
  });

  it('stops waiting for a chunk once the deadline passes', async () => {
    const reader = new ReadableStream<Uint8Array>({
      start() { /* never produces a value */ },
    }).getReader();

    await expect(readWithDeadline(reader, Date.now() + 10, new AbortController().signal, aiTimeoutError()))
      .rejects.toThrow('timed out');
  });
});
