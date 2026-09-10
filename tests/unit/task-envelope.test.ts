import { describe, expect, it } from 'vitest';
import {
  MAX_TASK_IDENTITY_LENGTH,
  MAX_TASK_PAYLOAD_BYTES,
  createTaskEnvelope,
  parseTaskEnvelope,
} from '@/lib/tasks/envelope';

const validEnvelope = {
  schemaVersion: 1 as const,
  jobId: 'job-1',
  taskKey: 'demo:publish',
  pluginId: 'demo',
  taskId: 'publish',
  kind: 'async' as const,
  source: 'request' as const,
  idempotencyKey: 'post:7:publish',
  payload: { postId: 7 },
  scheduledAt: 1_700_000_000,
  enqueuedAt: 1_700_000_001,
  localSlot: null,
};

describe('task envelope', () => {
  it('creates a versioned request envelope with stable business identity', () => {
    const envelope = createTaskEnvelope({
      pluginId: 'demo',
      taskId: 'publish',
      kind: 'async',
      source: 'request',
      payload: { postId: 7 },
      scheduledAt: 1_700_000_000,
      enqueuedAt: 1_700_000_001,
      idempotencyKey: 'post:7:publish',
    });

    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.jobId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(envelope.taskKey).toBe('demo:publish');
    expect(envelope.localSlot).toBeNull();
    expect(envelope.idempotencyKey).toBe('post:7:publish');
    expect(parseTaskEnvelope(envelope)).toEqual(envelope);
  });

  it('keeps caller-provided job and task identity while ignoring unknown fields', () => {
    const envelope = createTaskEnvelope({
      ...validEnvelope,
      extra: 'ignored',
    } as never);

    expect(envelope).toEqual(validEnvelope);
    expect('extra' in envelope).toBe(false);
  });

  it('accepts a payload exactly at the 32 KiB UTF-8 limit', () => {
    const prefix = JSON.stringify({ value: '' });
    const payload = { value: 'x'.repeat(MAX_TASK_PAYLOAD_BYTES - new TextEncoder().encode(prefix).byteLength) };

    const envelope = createTaskEnvelope({
      ...validEnvelope,
      payload,
    });

    expect(new TextEncoder().encode(JSON.stringify(envelope.payload)).byteLength).toBe(MAX_TASK_PAYLOAD_BYTES);
  });

  it.each([
    [{ pluginId: '', taskId: 'x' }],
    [{ pluginId: 'demo', taskId: '' }],
    [{ pluginId: 'demo', taskId: 'x', idempotencyKey: '' }],
    [{ pluginId: 'demo', taskId: 'x', jobId: '' }],
    [{ pluginId: 'demo', taskId: 'x', taskKey: '' }],
    [{ pluginId: 'p'.repeat(MAX_TASK_IDENTITY_LENGTH + 1), taskId: 'x' }],
  ])('rejects invalid identity fields at creation: %j', (input) => {
    expect(() => createTaskEnvelope({
      ...validEnvelope,
      ...input,
    } as never)).toThrow();
  });

  it('rejects identity fields above the hard length limit', () => {
    expect(() => parseTaskEnvelope({
      ...validEnvelope,
      pluginId: 'p'.repeat(MAX_TASK_IDENTITY_LENGTH + 1),
    })).toThrow();
  });

  it.each([
    { kind: 'cron', source: 'request' },
    { kind: 'async', source: 'http' },
    { kind: 'scheduled', source: 'queue' },
    { kind: 'scheduled', source: 'request' },
    { kind: 'async', source: 'scheduled' },
  ])('rejects invalid kind/source values: %j', (values) => {
    expect(() => parseTaskEnvelope({
      ...validEnvelope,
      ...values,
    })).toThrow();
  });

  it.each([
    { scheduledAt: -1 },
    { enqueuedAt: Number.NaN },
    { enqueuedAt: Number.POSITIVE_INFINITY },
    { scheduledAt: 1.5 },
    { scheduledAt: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid timestamps: %j', (timestamps) => {
    expect(() => parseTaskEnvelope({
      ...validEnvelope,
      ...timestamps,
    })).toThrow();
  });

  it('rejects unsupported schema versions and missing required fields', () => {
    expect(() => parseTaskEnvelope({ ...validEnvelope, schemaVersion: 99 })).toThrow();
    expect(() => parseTaskEnvelope({ ...validEnvelope, payload: undefined })).toThrow();
    expect(() => parseTaskEnvelope({ ...validEnvelope, localSlot: undefined })).toThrow();
    expect(() => parseTaskEnvelope({ ...validEnvelope, taskId: undefined })).toThrow();
  });

  it('rejects payloads above 32 KiB after UTF-8 encoding', () => {
    const payload = { value: 'x'.repeat(33 * 1024) };

    expect(() => createTaskEnvelope({
      ...validEnvelope,
      payload,
    })).toThrow();
  });

  it('rejects cyclic and otherwise non-JSON-serializable payloads', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => createTaskEnvelope({ ...validEnvelope, payload: cyclic })).toThrow();
    expect(() => createTaskEnvelope({ ...validEnvelope, payload: BigInt(1) })).toThrow();
    expect(() => createTaskEnvelope({ ...validEnvelope, payload: undefined })).toThrow();
  });

  it('validates and sanitizes a local slot', () => {
    const localSlot = {
      year: 2026,
      month: 9,
      day: 10,
      hour: 8,
      minute: 30,
      weekday: 4,
      timezone: 'Asia/Shanghai',
    };
    const parsed = parseTaskEnvelope({
      ...validEnvelope,
      kind: 'scheduled',
      source: 'scheduled',
      localSlot,
      untrusted: { shouldNotEscape: true },
    });

    expect(parsed.localSlot).toEqual(localSlot);
    expect('untrusted' in parsed).toBe(false);
  });

  it('requires local slots only for scheduled envelopes', () => {
    expect(() => parseTaskEnvelope({
      ...validEnvelope,
      kind: 'scheduled',
      source: 'scheduled',
      localSlot: null,
    })).toThrow();
    expect(() => parseTaskEnvelope({
      ...validEnvelope,
      kind: 'async',
      source: 'request',
      localSlot: {
        year: 2026,
        month: 9,
        day: 10,
        hour: 8,
        minute: 30,
        weekday: 4,
        timezone: 'Asia/Shanghai',
      },
    })).toThrow();
  });

  it.each([
    null,
    [],
    { ...validEnvelope, localSlot: { year: 0, month: 1, day: 1, hour: 0, minute: 0, weekday: 4, timezone: 'UTC' } },
    { ...validEnvelope, localSlot: { year: 2026 } },
    { ...validEnvelope, localSlot: { year: 2026, month: 2, day: 30, hour: 0, minute: 0, weekday: 1, timezone: 'UTC' } },
    { ...validEnvelope, localSlot: { year: 2026, month: 9, day: 10, hour: 0, minute: 0, weekday: 4, timezone: 'Not/An-Iana-Zone' } },
  ])('rejects invalid local slots: %j', (input) => {
    expect(() => parseTaskEnvelope(input)).toThrow();
  });
});
