import { parseTaskEnvelope } from './envelope';
import { MAX_QUEUE_DELAY_SECONDS } from './limits';
import { findTask, taskIdentity, type RegisteredTask } from './registry';
import type {
  TaskEnvelope,
  TaskExecutionContext,
  TaskResult,
  TaskHandler,
} from './types';
import type { TaskRuntime } from './runtime';

export const TASK_GLOBAL_MAX_IN_FLIGHT = 16;
export const TASK_LATE_HANDLER_GRACE_MS = 1_000;
const DEFAULT_RETRY_DELAY_SECONDS = 5;
const MAX_RETRY_DELAY_SECONDS = 300;
const MAX_LOG_TEXT_LENGTH = 512;

export interface TaskMessageLike {
  body: unknown;
  attempts?: number;
  ack(): void | Promise<void>;
  retry(options?: { delaySeconds?: number }): void | Promise<void>;
}

export interface TaskMessageBatchLike {
  messages: readonly TaskMessageLike[];
}

class TaskTimeoutError extends Error {
  readonly handlerCompletion: Promise<void>;

  constructor(handlerCompletion: Promise<void>) {
    super('task execution timed out');
    this.name = 'TaskTimeoutError';
    this.handlerCompletion = handlerCompletion;
  }
}

interface MessageFinalizer {
  ack(): Promise<void>;
  retry(delaySeconds: number): Promise<void>;
}

function createMessageFinalizer(message: TaskMessageLike): MessageFinalizer {
  let actionTaken = false;
  let actionInFlight: Promise<void> | undefined;

  const once = (action: () => void | Promise<void>): Promise<void> => {
    if (actionTaken) return Promise.resolve();
    if (actionInFlight) return actionInFlight;

    const pending = Promise.resolve()
      .then(action)
      .then(
        () => {
          actionTaken = true;
          actionInFlight = undefined;
        },
        (error: unknown) => {
          // A failed delivery-control call did not complete the action. Keep
          // the finalizer usable so the caller can attempt a fallback retry.
          actionInFlight = undefined;
          throw error;
        },
      );
    actionInFlight = pending;
    return pending;
  };

  return {
    ack: () => once(() => message.ack()),
    retry: delaySeconds => once(() => message.retry({ delaySeconds })),
  };
}

function attemptNumber(message: TaskMessageLike): number {
  return typeof message.attempts === 'number'
    && Number.isSafeInteger(message.attempts)
    && message.attempts > 0
    ? message.attempts
    : 1;
}

function retryDelay(attempt: number, requested?: unknown): number {
  if (
    typeof requested === 'number'
    && Number.isSafeInteger(requested)
    && requested >= 0
    && requested <= MAX_QUEUE_DELAY_SECONDS
  ) {
    return requested;
  }
  const exponent = Math.min(Math.max(attempt - 1, 0), 6);
  return Math.min(MAX_RETRY_DELAY_SECONDS, DEFAULT_RETRY_DELAY_SECONDS * (2 ** exponent));
}

function safeText(value: string): string {
  return value
    .replace(/((?:password|passphrase|secret|token|cookie|authorization|csrf|payload|headers?|credential|bearer|auth[_-]?code|(?:api|access|private|signing|encryption|client)[_-]?key|(?<![a-z0-9])key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, MAX_LOG_TEXT_LENGTH);
}

function isSensitiveKey(key: string): boolean {
  return /password|passphrase|secret|token|cookie|authorization|csrf|payload|headers?|credential|bearer|auth[_-]?code|(?:api|access|private|signing|encryption|client)[_-]?key/i.test(key)
    || /^key$/i.test(key);
}

function safeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeLogValue(item, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (!isSensitiveKey(key)) result[key] = safeLogValue(item, depth + 1);
    }
    return result;
  }
  return `[${typeof value}]`;
}

function structuredTaskLog(
  event: string,
  envelope: TaskEnvelope,
  attempt: number,
  fields: Record<string, unknown> = {},
): void {
  // Deliberately omit payload, idempotencyKey, options and error text. Those
  // values may contain credentials or user data; only task metadata is logged.
  const sanitizedFields = safeLogValue(fields);
  console.log(JSON.stringify({
    ...(sanitizedFields !== null
      && typeof sanitizedFields === 'object'
      && !Array.isArray(sanitizedFields)
      ? sanitizedFields as Record<string, unknown>
      : {}),
    // Keep core metadata last so plugin-provided fields cannot forge it.
    event,
    pluginId: envelope.pluginId,
    taskId: envelope.taskId,
    taskKey: envelope.taskKey,
    jobId: envelope.jobId,
    attempt,
  }));
}

function decodeEnvelope(body: unknown): TaskEnvelope {
  if (typeof body === 'string') {
    try {
      return parseTaskEnvelope(JSON.parse(body) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError) throw new TypeError('Task message body is not valid JSON');
      throw error;
    }
  }
  return parseTaskEnvelope(body);
}

function handlerFor(task: RegisteredTask): TaskHandler<unknown> {
  return task.handler as TaskHandler<unknown>;
}

async function invokeWithTimeout(
  task: RegisteredTask,
  runtime: TaskRuntime,
  envelope: TaskEnvelope,
  attempt: number,
): Promise<TaskResult> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const context: TaskExecutionContext = {
    env: runtime.env,
    db: runtime.db,
    options: runtime.options,
    pluginId: envelope.pluginId,
    taskId: envelope.taskId,
    taskKey: envelope.taskKey,
    kind: envelope.kind,
    source: envelope.source,
    jobId: envelope.jobId,
    idempotencyKey: envelope.idempotencyKey,
    attempt,
    scheduledAt: envelope.scheduledAt,
    localSlot: envelope.localSlot,
    signal: controller.signal,
    log: (message, fields = {}) => {
      structuredTaskLog('task.plugin_log', envelope, attempt, {
        message: safeText(message),
        fields,
      });
    },
  };

  const handlerPromise = Promise.resolve().then(() => (
    handlerFor(task)(context, envelope.payload)
  ));
  // The message can be retried as soon as the timeout fires, but the task
  // slot must remain occupied until the underlying handler settles. This
  // prevents a late handler from overlapping the same task's retry.
  const handlerCompletion = handlerPromise.then(
    () => undefined,
    () => undefined,
  );
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new TaskTimeoutError(handlerCompletion));
    }, task.timeoutSeconds * 1000);
  });

  try {
    return await Promise.race([handlerPromise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function isTaskResult(value: unknown): value is TaskResult {
  return value !== null
    && typeof value === 'object'
    && 'status' in value
    && ((value as { status?: unknown }).status === 'success'
      || (value as { status?: unknown }).status === 'retry'
      || (value as { status?: unknown }).status === 'discard');
}

async function executeMessage(
  message: TaskMessageLike,
  envelope: TaskEnvelope,
  task: RegisteredTask,
  runtime: TaskRuntime,
  holdTaskSlot: (completion: Promise<unknown>) => void,
): Promise<void> {
  const finalizer = createMessageFinalizer(message);
  const attempt = attemptNumber(message);
  try {
    const result = await invokeWithTimeout(task, runtime, envelope, attempt);
    if (!isTaskResult(result)) {
      structuredTaskLog('task.invalid_result', envelope, attempt);
      await finalizer.retry(retryDelay(attempt));
      return;
    }
    if (result.status === 'success' || result.status === 'discard') {
      await finalizer.ack();
      return;
    }
    await finalizer.retry(retryDelay(attempt, result.delaySeconds));
  } catch (error) {
    if (error instanceof TaskTimeoutError) {
      holdTaskSlot(error.handlerCompletion);
    }
    structuredTaskLog(
      error instanceof TaskTimeoutError ? 'task.timeout' : 'task.handler_error',
      envelope,
      attempt,
      { errorType: error instanceof Error ? error.name : typeof error },
    );
    await finalizer.retry(retryDelay(attempt));
  }
}

interface PendingExecution {
  taskIdentity: string;
  taskConcurrency: number;
  run: (holdTaskSlot: (completion: Promise<unknown>) => void) => Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

function boundedTaskSlotCompletion(completion: Promise<unknown>): Promise<void> {
  return new Promise(resolve => {
    let released = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const release = (): void => {
      if (released) return;
      released = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      resolve();
    };

    timeoutId = setTimeout(release, TASK_LATE_HANDLER_GRACE_MS);
    void Promise.resolve(completion).then(release, release);
  });
}

/** Small fair scheduler shared by all messages in one Queue batch. */
class InFlightScheduler {
  private running = 0;
  private readonly runningByTask = new Map<string, number>();
  private readonly pending: PendingExecution[] = [];

  run(
    taskIdentity: string,
    taskConcurrency: number,
    run: PendingExecution['run'],
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.push({
        taskIdentity,
        taskConcurrency,
        run,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  private releaseTask(taskIdentity: string): void {
    const current = (this.runningByTask.get(taskIdentity) ?? 1) - 1;
    if (current <= 0) this.runningByTask.delete(taskIdentity);
    else this.runningByTask.set(taskIdentity, current);
  }

  private pump(): void {
    while (this.running < TASK_GLOBAL_MAX_IN_FLIGHT) {
      const nextIndex = this.pending.findIndex(item => (
        (this.runningByTask.get(item.taskIdentity) ?? 0) < item.taskConcurrency
      ));
      if (nextIndex === -1) return;
      const [next] = this.pending.splice(nextIndex, 1);
      this.running += 1;
      this.runningByTask.set(
        next.taskIdentity,
        (this.runningByTask.get(next.taskIdentity) ?? 0) + 1,
      );
      let taskSlotCompletion: Promise<void> | undefined;
      const holdTaskSlot = (completion: Promise<unknown>): void => {
        if (taskSlotCompletion !== undefined) return;
        // Preserve the same-task guard while a timed-out handler gets a short
        // chance to honor AbortSignal, but never let a non-cooperative handler
        // block the rest of this Queue batch indefinitely.
        taskSlotCompletion = boundedTaskSlotCompletion(completion);
      };
      void Promise.resolve()
        .then(() => next.run(holdTaskSlot))
        .then(
          () => next.resolve(),
          error => next.reject(error),
        )
        .finally(() => {
          this.running -= 1;
          // A late handler keeps only its task identity occupied. Other task
          // identities can use the global dispatcher capacity immediately.
          this.pump();
          const releaseTaskSlot = (): void => {
            this.releaseTask(next.taskIdentity);
            this.pump();
          };
          if (taskSlotCompletion !== undefined) {
            void taskSlotCompletion.then(releaseTaskSlot, releaseTaskSlot);
          } else {
            releaseTaskSlot();
          }
        });
    }
  }
}

async function processMessage(
  message: TaskMessageLike,
  runtime: TaskRuntime,
  scheduler: InFlightScheduler,
): Promise<void> {
  let envelope: TaskEnvelope;
  try {
    envelope = decodeEnvelope(message.body);
  } catch {
    // A malformed envelope can never become valid through Queue retries.
    await createMessageFinalizer(message).ack();
    return;
  }

  const attempt = attemptNumber(message);
  const finalizer = createMessageFinalizer(message);
  if (!runtime.activatedPlugins.has(envelope.pluginId)) {
    structuredTaskLog('task.discard_inactive_plugin', envelope, attempt);
    await finalizer.ack();
    return;
  }

  if (Object.prototype.hasOwnProperty.call(runtime.initFailures, envelope.pluginId)) {
    structuredTaskLog('task.retry_plugin_init_failure', envelope, attempt);
    await finalizer.retry(retryDelay(attempt));
    return;
  }

  const task = findTask(envelope.pluginId, envelope.taskId, envelope.kind);
  if (!task) {
    structuredTaskLog('task.discard_unknown_task', envelope, attempt);
    await finalizer.ack();
    return;
  }

  return scheduler.run(
    taskIdentity(task.pluginId, task.id),
    task.concurrency,
    holdTaskSlot => executeMessage(message, envelope, task, runtime, holdTaskSlot),
  );
}

/** Dispatch a complete Queue batch with bounded task-level concurrency. */
export async function dispatchTaskMessages(
  messages: readonly TaskMessageLike[],
  runtime: TaskRuntime,
): Promise<void> {
  if (messages.length === 0) return;
  const scheduler = new InFlightScheduler();
  const results = await Promise.allSettled(
    messages.map(message => processMessage(message, runtime, scheduler)),
  );
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
}
