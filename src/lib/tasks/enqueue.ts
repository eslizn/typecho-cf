import { createTaskEnvelope } from './envelope';
import { defaultScheduledTaskKey } from './identity';
import { resolveTaskQueue, TaskQueueUnavailableError } from './queue';
import {
  CORE_TASK_OWNER_ID,
  findTask,
  type RegisteredScheduledTaskRecord,
} from './registry';
import type { TaskRuntime } from './runtime';
import type { TaskEnvelope, TaskLocalSlot } from './types';

export interface EnqueueAsyncTaskOptions {
  /** Stable business idempotency key. */
  idempotencyKey: string;
  /** Optional delivery delay in seconds. The provider applies its transport limits. */
  delaySeconds?: number;
}

function requireDeliveryDelay(delaySeconds: number | undefined): void {
  if (delaySeconds !== undefined && (!Number.isSafeInteger(delaySeconds) || delaySeconds < 0)) {
    throw new RangeError('delaySeconds must be a non-negative safe integer');
  }
}

/** Enqueue a request-originated async task owned by the caller. */
export async function enqueueAsyncTaskMessage(
  runtime: TaskRuntime,
  ownerId: string,
  taskId: string,
  payload: unknown,
  options: EnqueueAsyncTaskOptions,
): Promise<TaskEnvelope> {
  if (ownerId !== CORE_TASK_OWNER_ID && !runtime.activatedPlugins.has(ownerId)) {
    throw new TaskQueueUnavailableError('activation-unavailable');
  }
  const task = findTask(ownerId, taskId, 'async');
  if (!task) throw new Error(`Async task ${ownerId}:${taskId} is not registered`);
  requireDeliveryDelay(options.delaySeconds);

  const queue = resolveTaskQueue(runtime.capabilityRuntime);
  if (!queue.ok) throw new TaskQueueUnavailableError(queue.reason);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const envelope = createTaskEnvelope({
    pluginId: task.pluginId,
    taskId: task.id,
    kind: 'async',
    source: 'request',
    idempotencyKey: options.idempotencyKey,
    payload,
    scheduledAt: nowSeconds,
    enqueuedAt: nowSeconds,
    localSlot: null,
  });
  try {
    await queue.value.send(envelope, options.delaySeconds);
  } catch (error) {
    console.error({
      event: 'task.enqueue_failed',
      ownerId,
      taskId,
      errorType: error instanceof Error ? error.name : typeof error,
      error: error instanceof Error ? error.message.slice(0, 200) : undefined,
    });
    if (error instanceof RangeError) throw error;
    throw new TaskQueueUnavailableError('transport-failed');
  }
  return envelope;
}

/** Build one scheduled message for a concrete local-time slot. */
export function createScheduledTaskMessage(
  task: RegisteredScheduledTaskRecord,
  localSlot: TaskLocalSlot,
  scheduledAt: number,
  enqueuedAt: number,
): TaskEnvelope {
  if (findTask(task.pluginId, task.id, 'scheduled') !== task) {
    throw new Error(`Scheduled task ${task.pluginId}:${task.id} is not registered`);
  }
  const taskKey = task.getTaskKey?.({ scheduledAt, localSlot: { ...localSlot } })
    ?? defaultScheduledTaskKey(task.pluginId, task.id, localSlot, scheduledAt);
  return createTaskEnvelope({
    pluginId: task.pluginId,
    taskId: task.id,
    kind: 'scheduled',
    source: 'scheduled',
    idempotencyKey: `schedule:${taskKey}`,
    payload: { localSlot, scheduledAt },
    scheduledAt,
    enqueuedAt,
    taskKey,
    localSlot,
  });
}
