import type { CapabilityRuntimeContext } from '@/lib/capability';
import { resolveTaskQueue } from './queue';

export interface QueueMetricsSnapshot {
  backlogCount: number | null;
  backlogBytes: number | null;
  oldestMessageTimestampMs: number | null;
}

export interface QueueSettingsSnapshot {
  deliveryDelaySeconds: number | null;
  deliveryPaused: boolean | null;
  retentionPeriodSeconds: number | null;
}

export interface QueueConsumerSnapshot {
  consumerId: string | null;
  type: 'worker' | 'http_pull' | 'unknown';
  queueName: string | null;
  scriptName: string | null;
  batchSize: number | null;
  maxConcurrency: number | 'automatic' | null;
  maxRetries: number | null;
  maxWaitTimeMs: number | null;
  retryDelaySeconds: number | null;
  visibilityTimeoutMs: number | null;
}

export interface QueueResourceSnapshot {
  key: string;
  name: string;
  queueId: string | null;
  metrics: QueueMetricsSnapshot | null;
  metricsSource: 'binding' | 'api' | 'unavailable';
  settings: QueueSettingsSnapshot | null;
  consumers: readonly QueueConsumerSnapshot[];
  apiResourceFound: boolean;
}

export interface QueueDashboardSnapshot {
  queues: readonly QueueResourceSnapshot[];
  api: {
    configured: boolean;
    available: boolean;
  };
  refreshedAt: number;
}


export type TaskQueueDashboardState =
  | { state: 'available'; snapshot: QueueDashboardSnapshot | null }
  | {
    state: 'disabled' | 'unavailable' | 'initialization-failed' | 'ambiguous' | 'version-mismatch';
    snapshot: null;
  };

function isQueueDashboardSnapshot(value: unknown): value is QueueDashboardSnapshot {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { queues?: unknown; api?: unknown; refreshedAt?: unknown };
  const api = candidate.api as { configured?: unknown; available?: unknown } | null;
  return Array.isArray(candidate.queues)
    && typeof candidate.refreshedAt === 'number'
    && api !== null
    && typeof api === 'object'
    && typeof api.configured === 'boolean'
    && typeof api.available === 'boolean';
}

/**
 * Whether the admin Queue page should be exposed. A requested default provider
 * keeps the page available for diagnostics even when it is currently
 * unusable; otherwise any registered queue provider enables it.
 */
export function isTaskQueueDashboardEnabled(
  runtime: CapabilityRuntimeContext | undefined,
  defaultProvider: { requested: boolean },
): boolean {
  if (defaultProvider.requested) return true;
  if (!runtime) return false;
  const resolved = resolveTaskQueue(runtime);
  return resolved.ok || (resolved.candidates?.length ?? 0) > 0;
}

export async function readTaskQueueDashboard(
  runtime: CapabilityRuntimeContext | undefined,
  defaultProvider: { requested: boolean; initializationFailed: boolean },
): Promise<TaskQueueDashboardState> {
  if (!runtime) return { state: 'unavailable', snapshot: null };

  const resolved = resolveTaskQueue(runtime);
  if (resolved.ok) {
    try {
      const snapshot = await resolved.value.getDashboardSnapshot?.() ?? null;
      if (snapshot !== null && !isQueueDashboardSnapshot(snapshot)) {
        console.warn({ event: 'task.queue_dashboard_invalid', providerId: resolved.ownerPluginId });
        return { state: 'available', snapshot: null };
      }
      return { state: 'available', snapshot };
    } catch (error) {
      console.warn({
        event: 'task.queue_dashboard_failed',
        providerId: resolved.ownerPluginId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return { state: 'available', snapshot: null };
    }
  }

  if (resolved.reason === 'ambiguous' || resolved.reason === 'version-mismatch') {
    return { state: resolved.reason, snapshot: null };
  }
  if (resolved.reason === 'factory-failed' || defaultProvider.initializationFailed) {
    return { state: 'initialization-failed', snapshot: null };
  }
  if (defaultProvider.requested || resolved.candidates?.length) {
    return { state: 'unavailable', snapshot: null };
  }
  return { state: 'disabled', snapshot: null };
}
