import type { TaskEnvelope } from 'typecho/plugin-sdk';

export const DEFAULT_TASK_QUEUE_NAME = 'typecho-cf-tasks';
export const MAX_QUEUE_DELAY_SECONDS = 86_400;
export const MAX_QUEUE_BATCH_BYTES = 256_000;
export const MAX_QUEUE_BATCH_SIZE = 100;

export type CloudflareTaskQueueBinding = Pick<Queue<TaskEnvelope>, 'send' | 'sendBatch'>
  & Partial<Pick<Queue<TaskEnvelope>, 'metrics'>>;

export function cloudflareTaskQueueName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_TASK_QUEUE_NAME;
  const name = value.trim();
  if (name.length === 0 || name.length > 255 || /[\s\p{Cc}]/u.test(name)) {
    return DEFAULT_TASK_QUEUE_NAME;
  }
  return name;
}

export function readCloudflareTaskQueueBinding(value: unknown): CloudflareTaskQueueBinding | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  if (!('send' in value) || typeof value.send !== 'function') return undefined;
  if (!('sendBatch' in value) || typeof value.sendBatch !== 'function') return undefined;
  return value as CloudflareTaskQueueBinding;
}
