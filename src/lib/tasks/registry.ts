import { parseCronExpression, type CompiledCronExpression } from './cron';
import type {
  AsyncTaskDefinition,
  RegisteredAsyncTask,
  RegisteredScheduledTask,
  ScheduledTaskDefinition,
} from './types';

/** Default and safety-bound values for plugin task definitions. */
export const DEFAULT_TASK_CONCURRENCY = 1;
export const MAX_TASK_CONCURRENCY = 1024;
export const DEFAULT_TASK_TIMEOUT_SECONDS = 30;
export const MAX_TASK_TIMEOUT_SECONDS = 300;
export const MAX_TASK_ID_LENGTH = 128;

/**
 * The compiled matcher is kept alongside the public task definition so the
 * scheduler never reparses plugin cron expressions on every Cron invocation.
 */
export type RegisteredScheduledTaskRecord =
  RegisteredScheduledTask & {
    compiledSchedule: CompiledCronExpression;
  };

export type RegisteredAsyncTaskRecord<TPayload = unknown> = RegisteredAsyncTask<TPayload>;
export type RegisteredTask =
  | RegisteredScheduledTaskRecord
  | RegisteredAsyncTaskRecord<unknown>;

const taskRegistry = new Map<string, RegisteredTask>();

function validateIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (value !== value.trim()) {
    throw new TypeError(`${field} must not contain leading or trailing whitespace`);
  }
  if (value.length > MAX_TASK_ID_LENGTH) {
    throw new RangeError(`${field} is too long`);
  }
  return value;
}

/** Collision-free internal key; the public task identity remains pluginId:taskId. */
export function taskIdentity(pluginId: string, taskId: string): string {
  return JSON.stringify([pluginId, taskId]);
}

function validateDefinition(definition: unknown, kind: 'scheduled' | 'async'): void {
  if (definition === null || typeof definition !== 'object') {
    throw new TypeError(`${kind} task definition must be an object`);
  }

  const value = definition as Record<string, unknown>;
  if (typeof value.handler !== 'function') {
    throw new TypeError(`${kind} task handler must be a function`);
  }
  if (kind === 'scheduled' && typeof value.schedule !== 'string') {
    throw new TypeError('scheduled task schedule must be a string');
  }
  if (value.getTaskKey !== undefined && typeof value.getTaskKey !== 'function') {
    throw new TypeError('scheduled task getTaskKey must be a function');
  }
}

function normalizeConcurrency(value: unknown): number {
  if (value === undefined) return DEFAULT_TASK_CONCURRENCY;
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_TASK_CONCURRENCY
  ) {
    throw new RangeError(
      `task concurrency must be a positive integer no greater than ${MAX_TASK_CONCURRENCY}`,
    );
  }
  return value;
}

function normalizeTimeoutSeconds(value: unknown): number {
  if (value === undefined) return DEFAULT_TASK_TIMEOUT_SECONDS;
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value <= 0
    || value > MAX_TASK_TIMEOUT_SECONDS
  ) {
    throw new RangeError(
      `task timeoutSeconds must be greater than 0 and no greater than ${MAX_TASK_TIMEOUT_SECONDS}`,
    );
  }
  return value;
}

function assertNotRegistered(identity: string): void {
  if (taskRegistry.has(identity)) {
    throw new Error(`Task ${identity} is already registered`);
  }
}

export function registerScheduledTask(
  pluginIdInput: string,
  definition: ScheduledTaskDefinition,
): RegisteredScheduledTaskRecord {
  const pluginId = validateIdentity(pluginIdInput, 'pluginId');
  validateDefinition(definition, 'scheduled');
  const taskId = validateIdentity(definition.id, 'task id');
  const identity = taskIdentity(pluginId, taskId);
  assertNotRegistered(identity);

  // Parse before mutating the registry, so an invalid expression cannot leave
  // a partially registered task behind.
  const compiledSchedule = parseCronExpression(definition.schedule);
  const registered: RegisteredScheduledTaskRecord = {
    pluginId,
    kind: 'scheduled',
    id: taskId,
    schedule: compiledSchedule.source,
    concurrency: normalizeConcurrency(definition.concurrency),
    timeoutSeconds: normalizeTimeoutSeconds(definition.timeoutSeconds),
    handler: definition.handler,
    ...(definition.getTaskKey ? { getTaskKey: definition.getTaskKey } : {}),
    compiledSchedule,
  };
  taskRegistry.set(identity, registered as RegisteredTask);
  return registered;
}

export function registerAsyncTask<TPayload = unknown>(
  pluginIdInput: string,
  definition: AsyncTaskDefinition<TPayload>,
): RegisteredAsyncTaskRecord<TPayload> {
  const pluginId = validateIdentity(pluginIdInput, 'pluginId');
  validateDefinition(definition, 'async');
  const taskId = validateIdentity(definition.id, 'task id');
  const identity = taskIdentity(pluginId, taskId);
  assertNotRegistered(identity);

  const registered: RegisteredAsyncTaskRecord<TPayload> = {
    pluginId,
    kind: 'async',
    id: taskId,
    concurrency: normalizeConcurrency(definition.concurrency),
    timeoutSeconds: normalizeTimeoutSeconds(definition.timeoutSeconds),
    handler: definition.handler,
  };
  taskRegistry.set(identity, registered as RegisteredTask);
  return registered;
}

export function findTask(
  pluginIdInput: string,
  taskIdInput: string,
  kind: 'scheduled',
): RegisteredScheduledTaskRecord | undefined;
export function findTask(
  pluginIdInput: string,
  taskIdInput: string,
  kind: 'async',
): RegisteredAsyncTaskRecord | undefined;
export function findTask(
  pluginIdInput: string,
  taskIdInput: string,
  kind?: 'scheduled' | 'async',
): RegisteredTask | undefined;
export function findTask(
  pluginIdInput: string,
  taskIdInput: string,
  kind?: 'scheduled' | 'async',
): RegisteredTask | undefined {
  if (typeof pluginIdInput !== 'string' || typeof taskIdInput !== 'string') return undefined;
  const task = taskRegistry.get(taskIdentity(pluginIdInput, taskIdInput));
  if (!task || (kind !== undefined && task.kind !== kind)) return undefined;
  return task;
}

export function listScheduledTasks(
  activePluginIds: ReadonlySet<string> | readonly string[],
): RegisteredScheduledTaskRecord[] {
  const active = activePluginIds instanceof Set
    ? activePluginIds
    : new Set(activePluginIds);
  const result: RegisteredScheduledTaskRecord[] = [];
  for (const task of taskRegistry.values()) {
    if (task.kind === 'scheduled' && active.has(task.pluginId)) {
      result.push(task);
    }
  }
  return result;
}

/** Test-only reset; production registration is intentionally module-scoped. */
export function resetTaskRegistry(): void {
  taskRegistry.clear();
}

/** Roll back registrations from a plugin init that did not complete. */
export function resetTaskRegistrations(pluginId: string): void {
  for (const [identity, task] of taskRegistry) {
    if (task.pluginId === pluginId) taskRegistry.delete(identity);
  }
}
