import {
  resolveCapability,
  type CapabilityInvocationContext,
  type CapabilityResolveFailureReason,
  type CapabilityResolveResult,
} from '@/lib/capability';
import type { QueueDashboardSnapshot } from './queue-dashboard';
import type { TaskEnvelope } from './types';

export const TASK_QUEUE_CAPABILITY = 'tasks.queue';
export const TASK_QUEUE_CAPABILITY_VERSION = 1;

/** Backend operations after the task core validates the owner and envelope. */
export interface TaskQueueProvider {
  readonly isAvailable: boolean;
  send(envelope: TaskEnvelope, delaySeconds?: number): Promise<void>;
  sendBatch(envelopes: readonly TaskEnvelope[]): Promise<void>;
  getDashboardSnapshot?(): Promise<QueueDashboardSnapshot>;
}

export function resolveTaskQueue(
  runtime: CapabilityInvocationContext,
): CapabilityResolveResult<TaskQueueProvider> {
  const result = resolveCapability<TaskQueueProvider>(runtime, {
    capability: TASK_QUEUE_CAPABILITY,
    minVersion: TASK_QUEUE_CAPABILITY_VERSION,
  });
  if (!result.ok) return result;
  if (result.value?.isAvailable === true
    && typeof result.value.send === 'function'
    && typeof result.value.sendBatch === 'function'
    && result.backgroundAvailable) return result;
  return {
    ok: false,
    capability: TASK_QUEUE_CAPABILITY,
    reason: 'unavailable',
    candidates: [{ ownerPluginId: result.ownerPluginId, version: result.version }],
  };
}

export class TaskQueueUnavailableError extends Error {
  readonly status = 503;

  constructor(readonly reason: CapabilityResolveFailureReason | 'activation-unavailable' | 'transport-failed') {
    super('Task queue is unavailable');
    this.name = 'TaskQueueUnavailableError';
  }
}
