import { formatTaskLocalSlot } from './time';
import type { TaskLocalSlot } from './types';

/**
 * Build the default identity for one real scheduled instant.
 *
 * Including scheduledAt keeps two occurrences of the same local minute during
 * a fall-back transition distinct. A repeated delivery of the same Cron
 * instant still receives the same key, so plugin idempotency remains useful.
 */
export function defaultScheduledTaskKey(
  pluginId: string,
  taskId: string,
  localSlot: TaskLocalSlot,
  scheduledAt: number,
): string {
  return `${pluginId}:${taskId}:${formatTaskLocalSlot(localSlot)}:${scheduledAt}`;
}
