import { describe, expect, it } from 'vitest';
import { formatTaskLocalSlot, toTaskLocalSlot } from '@/lib/tasks/time';

function timestamp(value: string): number {
  return Date.parse(value) / 1000;
}

describe('task local time slots', () => {
  it('converts a UTC instant to UTC without applying a fixed offset', () => {
    const slot = toTaskLocalSlot(timestamp('2026-01-15T00:30:45Z'), 'UTC');

    expect(slot).toEqual({
      year: 2026,
      month: 1,
      day: 15,
      hour: 0,
      minute: 30,
      weekday: 4,
      timezone: 'UTC',
    });
    expect(formatTaskLocalSlot(slot)).toBe('2026-01-15T00:30');
  });

  it('uses the configured IANA timezone and handles a cross-day conversion', () => {
    const slot = toTaskLocalSlot(timestamp('2026-01-14T16:30:45Z'), 'Asia/Shanghai');

    expect(slot).toMatchObject({
      year: 2026,
      month: 1,
      day: 15,
      hour: 0,
      minute: 30,
      weekday: 4,
      timezone: 'Asia/Shanghai',
    });
    expect(formatTaskLocalSlot(slot)).toBe('2026-01-15T00:30');
  });

  it('uses the winter offset for America/New_York', () => {
    const slot = toTaskLocalSlot(timestamp('2026-01-15T14:00:00Z'), 'America/New_York');

    expect(slot).toMatchObject({
      year: 2026,
      month: 1,
      day: 15,
      hour: 9,
      minute: 0,
      weekday: 4,
      timezone: 'America/New_York',
    });
  });

  it('uses the summer daylight-saving offset for America/New_York', () => {
    const slot = toTaskLocalSlot(timestamp('2026-07-15T14:00:00Z'), 'America/New_York');

    expect(slot).toMatchObject({
      year: 2026,
      month: 7,
      day: 15,
      hour: 10,
      minute: 0,
      weekday: 3,
      timezone: 'America/New_York',
    });
  });
});
