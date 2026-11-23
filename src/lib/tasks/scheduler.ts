import { createScheduledTaskMessage } from './enqueue';
import { resolveTaskQueue } from './queue';
import { listScheduledTasks } from './registry';
import type { TaskRuntime } from './runtime';
import { toTaskLocalSlot } from './time';
import type { TaskEnvelope } from './types';

function scheduledAtSeconds(scheduledTime: number): number {
  if (!Number.isFinite(scheduledTime)) throw new TypeError('Scheduled event time must be a finite number');
  const seconds = Math.floor(scheduledTime / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new TypeError('Scheduled event time must represent a non-negative Unix timestamp in milliseconds');
  }
  return seconds;
}

/** Publish the tasks due in the site-local slot through the active provider. */
export async function runScheduledTasks(scheduledTimeMs: number, runtime: TaskRuntime): Promise<void> {
  const scheduledAt = scheduledAtSeconds(scheduledTimeMs);
  const localSlot = toTaskLocalSlot(scheduledAt, runtime.options.timezone);
  const dateFields = {
    minute: localSlot.minute,
    hour: localSlot.hour,
    dayOfMonth: localSlot.day,
    month: localSlot.month,
    dayOfWeek: localSlot.weekday,
  };
  const dueTasks = listScheduledTasks(runtime.activatedPlugins)
    .filter(task => !Object.hasOwn(runtime.initFailures, task.pluginId)
      && task.compiledSchedule.matches(dateFields));
  if (dueTasks.length === 0) return;

  const queue = resolveTaskQueue(runtime.capabilityRuntime);
  if (!queue.ok) {
    // A deliberately disabled provider is a valid state and stays quiet, but
    // an active provider that cannot be resolved must be visible in logs.
    if (queue.reason !== 'unavailable' || (queue.candidates?.length ?? 0) > 0) {
      console.error({
        event: 'task.queue_unavailable',
        source: 'scheduler',
        reason: queue.reason,
        dueTasks: dueTasks.length,
      });
    }
    return;
  }

  const enqueuedAt = Math.floor(Date.now() / 1000);
  const messages: TaskEnvelope[] = [];
  let failures = 0;
  for (const task of dueTasks) {
    try {
      messages.push(createScheduledTaskMessage(task, localSlot, scheduledAt, enqueuedAt));
    } catch (error) {
      failures += 1;
      console.error({
        event: 'task.schedule_failed',
        pluginId: task.pluginId,
        taskId: task.id,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  if (messages.length > 0) await queue.value.sendBatch(messages);
  if (failures > 0) throw new Error(`${failures} scheduled task(s) failed to enqueue`);
}
