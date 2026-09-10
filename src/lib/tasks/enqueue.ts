import { createTaskEnvelope } from './envelope';
import { defaultScheduledTaskKey } from './identity';
import { MAX_QUEUE_DELAY_SECONDS } from './limits';
import { findTask, type RegisteredScheduledTaskRecord } from './registry';
import type { TaskEnvelope, TaskLocalSlot } from './types';

export interface TaskQueueSendOptions {
  contentType?: 'json';
  delaySeconds?: number;
}

export interface TaskQueueBinding {
  send(body: unknown, options?: TaskQueueSendOptions): Promise<unknown> | unknown;
}

/** Options shared by request and scheduled task enqueue operations. */
export interface TaskEnqueueOptions {
  /** Stable business idempotency key. Async callers must provide it. */
  idempotencyKey?: string;
  /** Override the default task identity key (useful for scheduled fan-out). */
  taskKey?: string;
  /** Override the randomly generated envelope job id. */
  jobId?: string;
  /** Cloudflare Queue delivery delay. */
  delaySeconds?: number;
  /** Unix seconds used for deterministic tests and scheduler invocations. */
  nowSeconds?: number;
}

export interface AsyncTaskEnqueueOptions extends TaskEnqueueOptions {
  idempotencyKey: string;
}

/** Public SDK spelling retained as the canonical plugin-facing name. */
export type EnqueueAsyncTaskOptions = AsyncTaskEnqueueOptions;

export interface ScheduledTaskEnqueueOptions extends TaskEnqueueOptions {}

type TaskEnvironment = Cloudflare.Env & { QUEUE: TaskQueueBinding };

function getQueue(env: Cloudflare.Env): TaskQueueBinding {
  const queue = (env as TaskEnvironment).QUEUE;
  if (!queue || typeof queue.send !== 'function') {
    throw new TypeError('QUEUE binding is not available');
  }
  return queue;
}

function unixSeconds(value: number | undefined, field: string): number {
  const result = value === undefined ? Math.floor(Date.now() / 1000) : value;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError(`${field} must be a non-negative Unix timestamp in seconds`);
  }
  return result;
}

function delaySeconds(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_QUEUE_DELAY_SECONDS) {
    throw new RangeError(
      `delaySeconds must be an integer between 0 and ${MAX_QUEUE_DELAY_SECONDS}`,
    );
  }
  return value;
}

function requireRegisteredScheduledTask(
  task: RegisteredScheduledTaskRecord,
): RegisteredScheduledTaskRecord {
  const registered = findTask(task.pluginId, task.id, 'scheduled');
  if (!registered || registered !== task) {
    throw new Error(`Scheduled task ${task.pluginId}:${task.id} is not registered`);
  }
  return registered;
}

async function sendTaskEnvelope(
  env: Cloudflare.Env,
  envelope: TaskEnvelope,
  requestedDelaySeconds: number | undefined,
): Promise<TaskEnvelope> {
  const options: TaskQueueSendOptions = { contentType: 'json' };
  const delay = delaySeconds(requestedDelaySeconds);
  if (delay !== undefined) options.delaySeconds = delay;
  // Queue's JSON content type serializes the envelope for transport while
  // preserving an object body for the consumer. Do not double-encode it.
  await getQueue(env).send(envelope, options);
  return envelope;
}

/** Enqueue a request-originated async task. */
export async function enqueueAsyncTaskMessage(
  env: Cloudflare.Env,
  pluginId: string,
  taskId: string,
  payload: unknown,
  options: AsyncTaskEnqueueOptions,
): Promise<TaskEnvelope> {
  const task = findTask(pluginId, taskId, 'async');
  if (!task) {
    throw new Error(`Async task ${pluginId}:${taskId} is not registered`);
  }

  const nowSeconds = unixSeconds(options.nowSeconds, 'nowSeconds');
  const envelope = createTaskEnvelope({
    pluginId: task.pluginId,
    taskId: task.id,
    kind: 'async',
    source: 'request',
    idempotencyKey: options.idempotencyKey,
    payload,
    scheduledAt: nowSeconds,
    enqueuedAt: nowSeconds,
    jobId: options.jobId,
    taskKey: options.taskKey,
    localSlot: null,
  });
  return sendTaskEnvelope(env, envelope, options.delaySeconds);
}

/** Enqueue one scheduled task for a concrete local-time slot. */
export async function enqueueScheduledTaskMessage(
  env: Cloudflare.Env,
  taskInput: RegisteredScheduledTaskRecord,
  localSlot: TaskLocalSlot,
  scheduledAt: number,
  options: ScheduledTaskEnqueueOptions = {},
): Promise<TaskEnvelope> {
  const task = requireRegisteredScheduledTask(taskInput);
  const normalizedScheduledAt = unixSeconds(scheduledAt, 'scheduledAt');
  const taskKey = options.taskKey
    ?? task.getTaskKey?.({ scheduledAt: normalizedScheduledAt, localSlot })
    ?? defaultScheduledTaskKey(task.pluginId, task.id, localSlot, normalizedScheduledAt);
  const enqueuedAt = unixSeconds(options.nowSeconds, 'nowSeconds');
  const envelope = createTaskEnvelope({
    pluginId: task.pluginId,
    taskId: task.id,
    kind: 'scheduled',
    source: 'scheduled',
    idempotencyKey: options.idempotencyKey ?? `schedule:${taskKey}`,
    payload: {
      localSlot,
      scheduledAt: normalizedScheduledAt,
    },
    scheduledAt: normalizedScheduledAt,
    enqueuedAt,
    jobId: options.jobId,
    taskKey,
    localSlot,
  });
  return sendTaskEnvelope(env, envelope, options.delaySeconds);
}
