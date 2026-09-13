import { describe, expect, it } from 'vitest';
import {
  createScribeEventStream,
  createScribeLocalProgressReporter,
  sanitizeProgressEvent,
} from './scribe-stream';

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe('Scribe progress stream', () => {
  it('encodes task, text, progress, and done events as SSE', async () => {
    const stream = createScribeEventStream(async writer => {
      writer.task({ mode: 'polish', activity: 'preparing' });
      writer.text('<script>alert(1)</script>');
      writer.progress({
        phase: 'streaming',
        activity: 'streaming',
        elapsedMs: 120,
        usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24, outputTokensEstimated: true },
        outputTokensPerSecond: 33.33,
      });
      writer.done({
        phase: 'completed',
        activity: 'finalizing',
        elapsedMs: 140,
        usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24, outputTokensEstimated: true },
      });
    });

    const body = await readStream(stream);
    expect(body).toContain('event: task\ndata: {"mode":"polish","activity":"preparing"}');
    expect(body).toContain('event: text\ndata: {"delta":"<script>alert(1)</script>"}');
    expect(body).toContain('event: progress');
    expect(body).toContain('event: done');
  });

  it('keeps only the safe progress and usage fields for the browser', () => {
    const event = sanitizeProgressEvent({
      phase: 'streaming',
      elapsedMs: 123.456,
      usage: {
        inputTokens: 10,
        outputTokens: 3,
        inputTokensEstimated: true,
        prompt: 'secret prompt that must not cross the boundary',
      },
      prompt: 'secret prompt that must not cross the boundary',
      outputTokensPerSecond: 4.567,
    });

    expect(event).toEqual({
      phase: 'streaming',
      elapsedMs: 123.46,
      usage: { inputTokens: 10, outputTokens: 3, inputTokensEstimated: true },
      outputTokensPerSecond: 4.57,
    });
    expect(event).not.toHaveProperty('prompt');
  });

  it('provides estimated usage when an older capability has no observer', () => {
    const events: Array<{ phase: string; usage: unknown }> = [];
    let timestamp = 1000;
    const reporter = createScribeLocalProgressReporter(
      '标题和正文以及写作要求',
      event => events.push({ phase: event.phase, usage: event.usage }),
      () => timestamp,
    );

    reporter.reportPhase('requesting');
    timestamp = 2000;
    reporter.reportChunk({ choices: [{ delta: { content: '生成内容' } }] });
    timestamp = 3000;
    reporter.complete();

    expect(events[0]).toMatchObject({ phase: 'requesting', usage: { inputTokensEstimated: true } });
    expect(events.at(-1)).toMatchObject({
      phase: 'completed',
      usage: { inputTokensEstimated: true, outputTokensEstimated: true },
    });
  });
});
