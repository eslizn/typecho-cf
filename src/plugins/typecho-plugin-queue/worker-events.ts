import { loadPluginConfig } from 'typecho/plugin-sdk';
import { getDb, getPrimaryDb } from '@/db';
import { DEFAULT_QUEUE_PROVIDER_ID } from '@/lib/default-queue-provider';
import { ensureTablesReady, TablesMissingError } from '@/lib/isolate-boot';
import { consumeTaskBatch, createTaskRuntime } from '@/lib/tasks/runtime';
import { runScheduledTasks } from '@/lib/tasks/scheduler';
import { MAX_QUEUE_DELAY_SECONDS } from './binding';
import { readQueueProviderConfig } from './config';

/** Bounded backoff for a batch whose task runtime could not be created. */
const QUEUE_RUNTIME_RETRY_DELAY_SECONDS = 60;

async function loadWorkerTaskRuntime(env: Env) {
  try {
    await ensureTablesReady(env.DB);
  } catch (error) {
    if (error instanceof TablesMissingError) return null;
    throw error;
  }
  return createTaskRuntime({
    db: getDb(env.DB),
    primaryDb: getPrimaryDb(env.DB),
    env: env as unknown as Readonly<Record<string, unknown>>,
  });
}

export const scheduled: ExportedHandlerScheduledHandler<Env> = async (controller, env) => {
  const runtime = await loadWorkerTaskRuntime(env);
  if (runtime) await runScheduledTasks(controller.scheduledTime, runtime);
};

export const queue: ExportedHandlerQueueHandler<Env> = async (batch, env) => {
  if (batch.messages.length === 0) return;

  const runtime = await loadWorkerTaskRuntime(env).catch(error => {
    console.warn({
      event: 'task.queue_runtime_unavailable',
      errorType: error instanceof Error ? error.name : typeof error,
      error: error instanceof Error ? error.message.slice(0, 200) : undefined,
    });
    return null;
  });
  if (!runtime) {
    // Back off instead of burning the retry budget immediately: the runtime
    // may be unavailable only for the duration of a cold start or D1 blip.
    batch.retryAll({ delaySeconds: QUEUE_RUNTIME_RETRY_DELAY_SECONDS });
    return;
  }

  const expectedQueue = readQueueProviderConfig(
    loadPluginConfig(runtime.options, DEFAULT_QUEUE_PROVIDER_ID),
  ).queueName;
  if (batch.queue !== expectedQueue) {
    // The display name lives in plugin settings and can drift from the actual
    // queue. Cloudflare only delivers batches from queues configured as this
    // Worker's consumers, so surface the drift but never drop valid tasks.
    console.warn({
      event: 'task.unexpected_queue',
      expected: expectedQueue,
      actual: batch.queue,
    });
  }

  await consumeTaskBatch(batch.messages.map(message => ({
    body: message.body,
    attempts: message.attempts,
    ack: () => message.ack(),
    retry: ({ delaySeconds } = {}) => {
      message.retry(delaySeconds === undefined ? undefined : {
        delaySeconds: Math.min(delaySeconds, MAX_QUEUE_DELAY_SECONDS),
      });
    },
  })), DEFAULT_QUEUE_PROVIDER_ID, runtime);
};
