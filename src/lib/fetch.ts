export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 10_000,
  timeoutMessage = 'Request timed out',
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = init?.signal;
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      throw new Error('Request cancelled before start');
    }
    externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const { signal: _, ...rest } = init ?? {};
    return await fetch(url, { ...rest, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
