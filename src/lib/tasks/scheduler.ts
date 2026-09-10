import {
  enqueueScheduledTaskMessage,
  type TaskQueueBinding,
  type TaskQueueSendOptions,
} from './enqueue';
import { parseTaskEnvelope } from './envelope';
import { ensureTablesReady, TablesMissingError } from '@/lib/isolate-boot';
import { defaultScheduledTaskKey } from './identity';
import { MAX_QUEUE_BATCH_BYTES } from './limits';
import { listScheduledTasks } from './registry';
import { createTaskRuntime } from './runtime';
import { toTaskLocalSlot } from './time';
import type { TaskEnvelope, TaskLocalSlot } from './types';

export const MAX_SCHEDULED_BATCH_SIZE = 100;
export const MAX_SCHEDULED_BATCH_BYTES = MAX_QUEUE_BATCH_BYTES;
const QUEUE_BATCH_OVERHEAD_BYTES = 1024;

interface ScheduledControllerLike {
  readonly scheduledTime: number;
}

interface TaskQueueBatchMessage {
  body: TaskEnvelope;
  contentType: 'json';
  delaySeconds?: number;
}

interface TaskQueueBatchBinding {
  sendBatch(messages: Iterable<TaskQueueBatchMessage>): Promise<unknown>;
}

function scheduledAtSeconds(scheduledTime: number): number {
  if (typeof scheduledTime !== 'number' || !Number.isFinite(scheduledTime)) {
    throw new TypeError('Scheduled controller time must be a finite number of milliseconds');
  }

  const seconds = Math.floor(scheduledTime / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new TypeError('Scheduled controller time must represent a non-negative Unix timestamp');
  }
  return seconds;
}

function getTaskKey(
  pluginId: string,
  taskId: string,
  localSlot: TaskLocalSlot,
  scheduledAt: number,
  customKey?: (context: { scheduledAt: number; localSlot: TaskLocalSlot }) => string,
): string {
  return customKey?.({ scheduledAt, localSlot })
    ?? defaultScheduledTaskKey(pluginId, taskId, localSlot, scheduledAt);
}

function scheduleFailureType(error: unknown): string {
  if (error instanceof Error && error.constructor.name) return error.constructor.name;
  return typeof error;
}

function matchingTaskEnvelopeCollector(
  env: Cloudflare.Env,
  messages: TaskQueueBatchMessage[],
): Cloudflare.Env {
  const collector: TaskQueueBinding = {
    send(body: unknown, options: TaskQueueSendOptions = {}) {
      if (options.contentType !== undefined && options.contentType !== 'json') {
        throw new TypeError('Scheduled task messages must use the JSON Queue content type');
      }
      if (body === null || typeof body !== 'object') {
        throw new TypeError('Scheduled task Queue body must be an envelope object');
      }
      const envelope = parseTaskEnvelope(body);
      if (
        envelope.kind !== 'scheduled'
        || envelope.source !== 'scheduled'
        || envelope.localSlot === null
      ) {
        throw new TypeError('Scheduled task Queue body must be a scheduled envelope');
      }

      messages.push({
        body: envelope,
        contentType: 'json',
        ...(options.delaySeconds === undefined ? {} : { delaySeconds: options.delaySeconds }),
      });
      return Promise.resolve();
    },
  };

  // Keep the real environment untouched. The enqueue helper only needs the
  // producer binding, so do not spread or enumerate the runtime bindings.
  return { QUEUE: collector } as unknown as Cloudflare.Env;
}

function taskQueue(env: Cloudflare.Env): TaskQueueBatchBinding {
  const queue = (env as Cloudflare.Env & { QUEUE?: unknown }).QUEUE;
  if (
    queue === null
    || typeof queue !== 'object'
    || typeof (queue as { sendBatch?: unknown }).sendBatch !== 'function'
  ) {
    throw new TypeError('QUEUE binding is not available');
  }
  return queue as TaskQueueBatchBinding;
}

async function sendScheduledBatches(
  env: Cloudflare.Env,
  messages: readonly TaskQueueBatchMessage[],
): Promise<void> {
  if (messages.length === 0) return;

  const queue = taskQueue(env);
  let batch: TaskQueueBatchMessage[] = [];
  let batchBytes = 0;
  for (const message of messages) {
    const messageBytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
    if (
      batch.length > 0
      && (batch.length >= MAX_SCHEDULED_BATCH_SIZE
        || batchBytes + messageBytes + QUEUE_BATCH_OVERHEAD_BYTES > MAX_SCHEDULED_BATCH_BYTES)
    ) {
      await queue.sendBatch(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(message);
    batchBytes += messageBytes;
  }
  if (batch.length > 0) {
    await queue.sendBatch(batch);
  }
}

async function scheduleDueTasks(
  controller: ScheduledControllerLike,
  env: Cloudflare.Env,
): Promise<void> {
  try {
    await ensureTablesReady(env.DB);
  } catch (error) {
    // Cron runs independently of the install flow. A fresh D1 has no
    // typecho_options table yet, so there is nothing to schedule.
    if (error instanceof TablesMissingError) return;
    throw error;
  }

  const runtime = await createTaskRuntime(env);
  const scheduledAt = scheduledAtSeconds(controller.scheduledTime);
  const localSlot = toTaskLocalSlot(scheduledAt, runtime.options.timezone);
  const dateFields = {
    minute: localSlot.minute,
    hour: localSlot.hour,
    dayOfMonth: localSlot.day,
    month: localSlot.month,
    dayOfWeek: localSlot.weekday,
  };
  const schedulablePlugins = new Set(
    [...runtime.activatedPlugins].filter(pluginId => (
      !Object.prototype.hasOwnProperty.call(runtime.initFailures, pluginId)
    )),
  );
  const dueTasks = listScheduledTasks(schedulablePlugins)
    .filter(task => task.compiledSchedule.matches(dateFields));

  if (dueTasks.length === 0) return;

  const messages: TaskQueueBatchMessage[] = [];
  const enqueueEnv = matchingTaskEnvelopeCollector(env, messages);
  const enqueuedAt = Math.floor(Date.now() / 1000);

  const results = await Promise.allSettled(dueTasks.map(async task => {
    const keyLocalSlot = { ...localSlot };
    const taskKey = getTaskKey(
      task.pluginId,
      task.id,
      keyLocalSlot,
      scheduledAt,
      task.getTaskKey,
    );
    await enqueueScheduledTaskMessage(enqueueEnv, task, { ...localSlot }, scheduledAt, {
      taskKey,
      idempotencyKey: `schedule:${taskKey}`,
      nowSeconds: enqueuedAt,
    });
  }));

  const failedTasks: Array<{ pluginId: string; taskId: string }> = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') return;

    const task = dueTasks[index];
    failedTasks.push({ pluginId: task.pluginId, taskId: task.id });
    console.error({
      event: 'task.schedule_failed',
      pluginId: task.pluginId,
      taskId: task.id,
      errorType: scheduleFailureType(result.reason),
    });
  });

  await sendScheduledBatches(env, messages);

  if (failedTasks.length > 0) {
    throw new Error(`${failedTasks.length} scheduled task(s) failed to enqueue`);
  }
}

/**
 * Find tasks due in the site-local minute represented by a Cron instant and
 * publish their validated envelopes in Queue batches.
 *
 * The returned promise is intentionally not swallowed. Cloudflare receives
 * the same promise through waitUntil, so a producer failure remains observable
 * and can be surfaced by the scheduled invocation.
 */
export function runScheduledTasks(
  controller: ScheduledControllerLike,
  env: Cloudflare.Env,
  executionContext: ExecutionContext,
): Promise<void> {
  const pending = scheduleDueTasks(controller, env);
  if (typeof executionContext?.waitUntil === 'function') {
    executionContext.waitUntil(pending);
  }
  return pending;
}
