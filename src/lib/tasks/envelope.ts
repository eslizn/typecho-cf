import type {
  TaskEnvelope,
  TaskKind,
  TaskLocalSlot,
  TaskSource,
} from './types';
import { isIanaTimezone } from '@/lib/timezone';

export const TASK_ENVELOPE_VERSION = 1 as const;
export const MAX_TASK_PAYLOAD_BYTES = 32 * 1024;
export const MAX_TASK_IDENTITY_LENGTH = 512;

export interface CreateTaskEnvelopeInput {
  pluginId: string;
  taskId: string;
  kind: TaskKind;
  source: TaskSource;
  idempotencyKey: string;
  payload: unknown;
  scheduledAt: number;
  enqueuedAt: number;
  jobId?: string;
  taskKey?: string;
  localSlot?: TaskLocalSlot | null;
  schemaVersion?: number;
}

export type TaskEnvelopeInput = CreateTaskEnvelopeInput;

const hasOwn = (value: object, key: string): boolean => (
  Object.prototype.hasOwnProperty.call(value, key)
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequired(record: Record<string, unknown>, key: string): unknown {
  if (!hasOwn(record, key)) {
    throw new TypeError(`Task envelope is missing ${key}`);
  }
  return record[key];
}

function readIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    throw new TypeError(`Task envelope ${field} must be a non-empty string`);
  }
  if (value.length > MAX_TASK_IDENTITY_LENGTH) {
    throw new RangeError(`Task envelope ${field} is too long`);
  }
  return value;
}

function readTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Task envelope ${field} must be a non-negative Unix timestamp in seconds`);
  }
  return value;
}

function readEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`Task envelope ${field} is invalid`);
  }
  return value as T;
}

function readInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`Task local slot ${field} is invalid`);
  }
  return value;
}

function daysInMonth(year: number, month: number): number {
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (month === 2) return leapYear ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function readLocalSlot(value: unknown): TaskLocalSlot | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new TypeError('Task envelope localSlot must be an object or null');
  }

  const year = readInteger(readRequired(value, 'year'), 'year', 1, 9999);
  const month = readInteger(readRequired(value, 'month'), 'month', 1, 12);
  const day = readInteger(readRequired(value, 'day'), 'day', 1, daysInMonth(year, month));
  const hour = readInteger(readRequired(value, 'hour'), 'hour', 0, 23);
  const minute = readInteger(readRequired(value, 'minute'), 'minute', 0, 59);
  const weekday = readInteger(readRequired(value, 'weekday'), 'weekday', 0, 6);
  const timezone = readIdentity(readRequired(value, 'timezone'), 'localSlot.timezone');
  if (!isIanaTimezone(timezone)) {
    throw new TypeError('Task local slot timezone must be a supported IANA timezone');
  }

  return { year, month, day, hour, minute, weekday, timezone };
}

function assertJsonValue(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Task payload contains a non-finite number');
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError('Task payload contains a value that is not JSON serializable');
  }

  if (ancestors.has(value)) {
    throw new TypeError('Task payload must not contain a circular reference');
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null && !Array.isArray(value)) {
    throw new TypeError('Task payload must contain only JSON values');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertJsonValue(item, ancestors);
      return;
    }

    for (const symbol of Object.getOwnPropertySymbols(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
        throw new TypeError('Task payload must not contain symbol properties');
      }
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      assertJsonValue(record[key], ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function normalizePayload(value: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError('Task payload must be JSON serializable');
  }
  if (typeof serialized !== 'string') {
    throw new TypeError('Task payload must be JSON serializable');
  }

  assertJsonValue(value, new Set<object>());

  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_TASK_PAYLOAD_BYTES) {
    throw new RangeError(`Task payload exceeds ${MAX_TASK_PAYLOAD_BYTES} UTF-8 bytes`);
  }

  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new TypeError('Task payload must be valid JSON');
  }
}

export function parseTaskEnvelope(input: unknown): TaskEnvelope {
  if (!isRecord(input)) {
    throw new TypeError('Task envelope must be an object');
  }

  const schemaVersion = readRequired(input, 'schemaVersion');
  if (schemaVersion !== TASK_ENVELOPE_VERSION) {
    throw new RangeError(`Unsupported task envelope schema version: ${String(schemaVersion)}`);
  }

  const jobId = readIdentity(readRequired(input, 'jobId'), 'jobId');
  const taskKey = readIdentity(readRequired(input, 'taskKey'), 'taskKey');
  const pluginId = readIdentity(readRequired(input, 'pluginId'), 'pluginId');
  const taskId = readIdentity(readRequired(input, 'taskId'), 'taskId');
  const kind = readEnum(readRequired(input, 'kind'), 'kind', ['scheduled', 'async'] as const);
  const source = readEnum(readRequired(input, 'source'), 'source', ['scheduled', 'request'] as const);
  const idempotencyKey = readIdentity(readRequired(input, 'idempotencyKey'), 'idempotencyKey');
  const payload = normalizePayload(readRequired(input, 'payload'));
  const scheduledAt = readTimestamp(readRequired(input, 'scheduledAt'), 'scheduledAt');
  const enqueuedAt = readTimestamp(readRequired(input, 'enqueuedAt'), 'enqueuedAt');
  const localSlot = readLocalSlot(readRequired(input, 'localSlot'));

  if (kind === 'scheduled' && source !== 'scheduled') {
    throw new TypeError('Scheduled task envelopes must use the scheduled source');
  }
  if (kind === 'async' && source !== 'request') {
    throw new TypeError('Async task envelopes must use the request source');
  }
  if (kind === 'scheduled' && localSlot === null) {
    throw new TypeError('Scheduled task envelopes must include a local slot');
  }
  if (kind === 'async' && localSlot !== null) {
    throw new TypeError('Async task envelopes must not include a local slot');
  }

  return {
    schemaVersion: TASK_ENVELOPE_VERSION,
    jobId,
    taskKey,
    pluginId,
    taskId,
    kind,
    source,
    idempotencyKey,
    payload,
    scheduledAt,
    enqueuedAt,
    localSlot,
  };
}

export function createTaskEnvelope(input: CreateTaskEnvelopeInput): TaskEnvelope {
  if (!isRecord(input)) {
    throw new TypeError('Task envelope input must be an object');
  }

  if (input.schemaVersion !== undefined && input.schemaVersion !== TASK_ENVELOPE_VERSION) {
    throw new RangeError(`Unsupported task envelope schema version: ${String(input.schemaVersion)}`);
  }

  const pluginId = readIdentity(input.pluginId, 'pluginId');
  const taskId = readIdentity(input.taskId, 'taskId');
  const jobId = input.jobId === undefined
    ? globalThis.crypto.randomUUID()
    : readIdentity(input.jobId, 'jobId');
  const taskKey = input.taskKey === undefined
    ? `${pluginId}:${taskId}`
    : readIdentity(input.taskKey, 'taskKey');
  const localSlot = input.localSlot === undefined ? null : input.localSlot;

  return parseTaskEnvelope({
    schemaVersion: TASK_ENVELOPE_VERSION,
    jobId,
    taskKey,
    pluginId,
    taskId,
    kind: input.kind,
    source: input.source,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    scheduledAt: input.scheduledAt,
    enqueuedAt: input.enqueuedAt,
    localSlot,
  });
}
