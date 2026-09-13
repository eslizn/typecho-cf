import { describe, expect, it, vi } from 'vitest';
import type { AiChatStreamChunk, AiProgressEvent } from './types';
import { createAiProgressReporter } from './telemetry';

function chunk(content: string): AiChatStreamChunk {
  return {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'scribe',
    choices: [{ index: 0, delta: { content } }],
  };
}

describe('AI progress telemetry', () => {
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
    reporter.reportChunk(chunk('正文'));
    clock = 1500;
    reporter.complete({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });

    expect(events.at(-1)).toMatchObject({
      phase: 'completed',
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    });
    expect(events.at(-1)?.usage.inputTokensEstimated).toBeUndefined();
    expect(events.at(-1)?.usage.outputTokensEstimated).toBeUndefined();
  });

  it('reports TTFT and estimated output rate while streaming', () => {
    let clock = 0;
    const events: AiProgressEvent[] = [];
    const reporter = createAiProgressReporter(
      { messages: [{ role: 'user', content: 'x'.repeat(40) }] },
      event => events.push(event),
      () => clock,
    );

    reporter.reportPhase('queued');
    reporter.reportPhase('requesting');
    clock = 500;
    reporter.reportChunk(chunk('a'.repeat(8)));
    clock = 1500;
    reporter.reportChunk(chunk('b'.repeat(8)));
    reporter.complete();

    const streaming = events.find(event => event.phase === 'streaming');
    expect(streaming?.timeToFirstTokenMs).toBe(500);
    expect(streaming?.usage.outputTokensEstimated).toBe(true);
    expect(events.find(event => event.phase === 'streaming' && event.outputTokensPerSecond !== undefined)?.outputTokensPerSecond)
      .toBeGreaterThan(0);
    expect(events.at(-1)?.phase).toBe('completed');
  });

  it('swallows observer failures and limits intermediate events', () => {
    let clock = 1000;
    const observer = vi.fn(() => { throw new Error('observer failure'); });
    const reporter = createAiProgressReporter(
      { messages: [{ role: 'user', content: 'x' }] },
      observer,
      () => clock,
    );

    expect(() => reporter.reportPhase('queued')).not.toThrow();
    for (let i = 0; i < 20; i += 1) {
      clock += 10;
      reporter.reportChunk(chunk('x'));
    }
    reporter.complete();

    expect(observer).toHaveBeenCalled();
    expect(observer.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('emits a failed terminal event without exposing request content', () => {
    const events: AiProgressEvent[] = [];
    const reporter = createAiProgressReporter(
      { messages: [{ role: 'user', content: 'private prompt' }] },
      event => events.push(event),
      () => 1000,
    );

    reporter.fail();

    expect(events.at(-1)).toMatchObject({ phase: 'failed' });
    expect(JSON.stringify(events)).not.toContain('private prompt');
  });
});
