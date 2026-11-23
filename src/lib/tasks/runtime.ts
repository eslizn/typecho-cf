import type { Database } from '@/db';
import {
  createCapabilityRuntimeContext,
  getCapabilityActivationGeneration,
  getCapabilityPrimaryDb,
  type CapabilityInvocationContext,
  type CapabilityRuntimeContext,
} from '@/lib/capability';
import { loadOptions, type SiteOptions } from '@/lib/options';
import type { PluginDependencyIssue } from '@/lib/plugin-dependencies';
import { loadPluginSecurityOptions } from '@/lib/security-options';
import {
  getPluginInitFailures,
  loadPluginConfig,
  parseActivatedPlugins,
  setActivatedPlugins,
  type HookContext,
} from '@/lib/plugin';
import { dispatchTaskMessages, retryTaskMessages, type TaskMessageLike } from './dispatcher';
import { enqueueAsyncTaskMessage, type EnqueueAsyncTaskOptions } from './enqueue';
import { resolveTaskQueue, TaskQueueUnavailableError } from './queue';
import { CORE_TASK_OWNER_ID } from './registry';
import type { TaskEnvelope } from './types';

interface PluginTaskInitFailure {
  error: string;
  attempts: number;
  failedAt: number;
}

export interface TaskDispatchRuntime {
  db: Database;
  options: SiteOptions;
  activatedPlugins: ReadonlySet<string>;
  initFailures: Readonly<Record<string, PluginTaskInitFailure>>;
  activationDiagnostics: ReadonlyArray<PluginDependencyIssue>;
}

export interface TaskRuntime extends TaskDispatchRuntime {
  capabilityRuntime: CapabilityInvocationContext;
}

interface TaskRuntimeInput {
  db: Database;
  primaryDb: Database;
  env?: Readonly<Record<string, unknown>>;
  request?: Request;
}

/** Create an authoritative activation snapshot for a task operation. */
export async function createTaskRuntime(input: TaskRuntimeInput): Promise<TaskRuntime> {
  const { db, primaryDb } = input;
  const cachedOptions = await loadOptions(db);
  const options = await loadPluginSecurityOptions(primaryDb, cachedOptions);
  const activePluginIds = parseActivatedPlugins(options.activatedPlugins);
  const pluginContext: HookContext = { activatedPlugins: new Set() };

  await setActivatedPlugins(pluginContext, activePluginIds);

  const snapshot = {
    db,
    options,
    env: input.env,
    activatedPlugins: pluginContext.activatedPlugins,
    activationGeneration: pluginContext.activationGeneration,
    getPluginConfig: (pluginId: string) => loadPluginConfig(options, pluginId),
  };
  const capabilityRuntime = input.request
    ? createCapabilityRuntimeContext({ ...snapshot, request: input.request })
    : createCapabilityRuntimeContext(snapshot);

  return {
    db,
    options,
    activatedPlugins: capabilityRuntime.activatedPlugins,
    capabilityRuntime,
    initFailures: getPluginInitFailures(),
    activationDiagnostics: pluginContext.activationDiagnostics ?? [],
  };
}

/**
 * Build a submission-only runtime from the authoritative activation set.
 *
 * Unlike createTaskRuntime(), this never mutates isolate plugin state: the
 * calling request keeps its capability runtime and no plugin init/deactivate
 * runs from inside an HTTP hook. Callers that need the full activation plan
 * (Cron and Queue consumers) use createTaskRuntime() instead.
 */
export async function refreshTaskRuntime(context: CapabilityRuntimeContext): Promise<TaskRuntime> {
  try {
    const primaryDb = getCapabilityPrimaryDb(context);
    if (!primaryDb) throw new TypeError('Authoritative activation is unavailable');
    const cachedOptions = await loadOptions(context.db);
    const options = await loadPluginSecurityOptions(primaryDb, cachedOptions);
    const activatedPlugins = new Set(parseActivatedPlugins(options.activatedPlugins));
    const capabilityRuntime = createCapabilityRuntimeContext({
      db: context.db,
      options,
      env: context.env,
      activatedPlugins,
      activationGeneration: getCapabilityActivationGeneration(),
      getPrimaryDb: () => primaryDb,
      getPluginConfig: pluginId => loadPluginConfig(options, pluginId),
    });
    return {
      db: context.db,
      options,
      activatedPlugins: capabilityRuntime.activatedPlugins,
      capabilityRuntime,
      initFailures: getPluginInitFailures(),
      activationDiagnostics: [],
    };
  } catch (error) {
    console.error({
      event: 'task.runtime_unavailable',
      source: 'submission',
      errorType: error instanceof Error ? error.name : typeof error,
      error: error instanceof Error ? error.message.slice(0, 200) : undefined,
    });
    throw new TaskQueueUnavailableError('activation-unavailable');
  }
}

/** Host-only submission for tasks registered under the fixed core owner. */
export async function enqueueCoreAsyncTask(
  context: CapabilityRuntimeContext,
  taskId: string,
  payload: unknown,
  options: EnqueueAsyncTaskOptions,
): Promise<TaskEnvelope> {
  return enqueueAsyncTaskMessage(
    await refreshTaskRuntime(context), CORE_TASK_OWNER_ID, taskId, payload, options,
  );
}

/** Refuse delivery from a different or inactive provider before invoking handlers. */
export async function consumeTaskBatch(
  messages: readonly TaskMessageLike[],
  providerId: string,
  runtime: TaskRuntime,
): Promise<void> {
  if (messages.length === 0) return;
  const queue = resolveTaskQueue(runtime.capabilityRuntime);
  if (!queue.ok || queue.ownerPluginId !== providerId) {
    console.warn({
      event: 'task.queue_unavailable',
      source: 'consumer',
      reason: queue.ok ? 'provider-mismatch' : queue.reason,
      messageCount: messages.length,
    });
    await retryTaskMessages(messages);
    return;
  }
  await dispatchTaskMessages(messages, runtime);
}
