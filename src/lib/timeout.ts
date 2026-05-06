export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message = '操作超时，请稍后重试',
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return operation;
  }

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), timeoutMs);
  });

  return Promise.race([operation, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
