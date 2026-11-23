import { vi } from 'vitest';
import { createCapabilityRuntimeContext, registerCapability, setCapabilityActivation } from '@/lib/capability';
import { TASK_QUEUE_CAPABILITY, TASK_QUEUE_CAPABILITY_VERSION, type TaskQueueProvider } from '@/lib/tasks/queue';
import type { TaskRuntime } from '@/lib/tasks/runtime';
import type { TaskEnvelope } from '@/lib/tasks/types';

export const TEST_TASK_PROVIDER_ID = 'test-task-provider';

export function testQueueProvider(isAvailable = true) {
  return {
    isAvailable,
    send: vi.fn(async (_envelope: TaskEnvelope, _delaySeconds?: number) => {}),
    sendBatch: vi.fn(async (_envelopes: readonly TaskEnvelope[]) => {}),
  } satisfies TaskQueueProvider;
}

export function registerTestTaskProvider(
  provider: TaskQueueProvider,
  owner = TEST_TASK_PROVIDER_ID,
): void {
  registerCapability(owner, {
    capability: TASK_QUEUE_CAPABILITY,
    version: TASK_QUEUE_CAPABILITY_VERSION,
    scope: 'any',
    factory: () => provider,
  });
}

export function testTaskRuntime(
  owners: string[],
  options: { timezone?: string; initFailures?: TaskRuntime['initFailures'] } = {},
): TaskRuntime {
  const activatedPlugins = new Set(owners);
  const db = {} as TaskRuntime['db'];
  const siteOptions = { timezone: options.timezone ?? 'UTC' } as TaskRuntime['options'];
  setCapabilityActivation(activatedPlugins, 1);
  return {
    db,
    options: siteOptions,
    activatedPlugins,
    capabilityRuntime: createCapabilityRuntimeContext({
      db,
      options: siteOptions,
      activatedPlugins,
      activationGeneration: 1,
    }),
    initFailures: options.initFailures ?? {},
    activationDiagnostics: [],
  };
}
