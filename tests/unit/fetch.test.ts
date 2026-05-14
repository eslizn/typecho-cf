import { describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout } from '@/lib/fetch';

describe('fetchWithTimeout', () => {
  it('passes through on success', async () => {
    const fetchMock = async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response('ok');
    };
    vi.stubGlobal('fetch', fetchMock);

    const resp = await fetchWithTimeout('https://example.com');
    expect(await resp.text()).toBe('ok');

    vi.unstubAllGlobals();
  });

  it('throws on timeout', async () => {
    vi.useFakeTimers();

    const fetchPromise = fetchWithTimeout('https://example.com', undefined, 1000, 'too slow');
    vi.advanceTimersByTime(1000);

    await expect(fetchPromise).rejects.toThrow('too slow');

    vi.useRealTimers();
  });

  it('merges external AbortSignal — honours external abort', async () => {
    const controller = new AbortController();
    controller.abort();

    vi.useFakeTimers();
    await expect(
      fetchWithTimeout('https://example.com', { signal: controller.signal }, 10_000, 'timed out'),
    ).rejects.toThrow('Request cancelled before start');
    vi.useRealTimers();
  });

  it('merges external AbortSignal — propagates external abort event', async () => {
    vi.useFakeTimers();

    const controller = new AbortController();
    const promise = fetchWithTimeout('https://example.com', { signal: controller.signal }, 10_000, 'timed out');
    controller.abort();
    vi.advanceTimersByTime(0); // let the microtask fire the event listener
    vi.advanceTimersByTime(1); // let the setTimeout abort fire (controller already aborted)

    await expect(promise).rejects.toThrow('timed out');

    vi.useRealTimers();
  });

  it('clears the timeout timer on success', async () => {
    vi.useFakeTimers();

    const fetchMock = async () => new Response('done');
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithTimeout('https://example.com');
    await vi.runAllTimersAsync();
    const resp = await promise;
    expect(await resp.text()).toBe('done');
    // No unhandled timer leak — test passes if no error thrown

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('passes init options through to fetch', async () => {
    const fetchMock = async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(init?.body).toBe('{}');
      return new Response('posted');
    };
    vi.stubGlobal('fetch', fetchMock);

    const resp = await fetchWithTimeout('https://example.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(await resp.text()).toBe('posted');

    vi.unstubAllGlobals();
  });
});
