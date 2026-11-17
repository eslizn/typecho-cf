import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEZONE,
  formatDateTimeLocal,
  formatTimezoneLabel,
  getTimezoneOffsetSeconds,
  getTimezoneRegion,
  isIanaTimezone,
  parseDateTimeLocalToTimestamp,
  STANDARD_TIMEZONES,
} from '@/lib/timezone';

describe('curated IANA time zones', () => {
  it('contains representative city identifiers', () => {
    expect(DEFAULT_TIMEZONE).toBe('Asia/Shanghai');
    expect(STANDARD_TIMEZONES[0]).toBe('UTC');
    expect(STANDARD_TIMEZONES).toHaveLength(45);
    expect(STANDARD_TIMEZONES).toContain('America/New_York');
    expect(STANDARD_TIMEZONES).toContain('Europe/London');
    expect(STANDARD_TIMEZONES).toContain('Asia/Shanghai');
    expect(STANDARD_TIMEZONES).not.toContain('America/Argentina/La_Rioja');
    expect(STANDARD_TIMEZONES.every((timezone) => timezone === 'UTC' || timezone.includes('/'))).toBe(true);
  });

  it('validates only supported IANA identifiers', () => {
    expect(isIanaTimezone('Asia/Shanghai')).toBe(true);
    expect(isIanaTimezone('UTC')).toBe(true);
    expect(isIanaTimezone('Etc/GMT-8')).toBe(false);
    expect(isIanaTimezone('Not/A_Timezone')).toBe(false);
  });

  it('groups identifiers by their IANA region', () => {
    expect(getTimezoneRegion('Asia/Shanghai')).toBe('Asia');
    expect(getTimezoneRegion('America/Argentina/La_Rioja')).toBe('America');
    expect(getTimezoneRegion('UTC')).toBe('UTC');
  });

  it('calculates DST-aware offsets for IANA zones', () => {
    const winter = Math.floor(new Date('2026-01-15T12:00:00Z').getTime() / 1000);
    const summer = Math.floor(new Date('2026-07-15T12:00:00Z').getTime() / 1000);
    expect(getTimezoneOffsetSeconds('America/New_York', winter)).toBe(-18_000);
    expect(getTimezoneOffsetSeconds('America/New_York', summer)).toBe(-14_400);
  });

  it('formats labels as region-bearing IDs without per-option ICU work', () => {
    expect(formatTimezoneLabel('Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(formatTimezoneLabel('America/New_York')).toBe('America/New_York');
  });

  it('formats and parses datetime-local values in the site timezone', () => {
    // 2026-01-15 00:30 Asia/Shanghai == 2026-01-14 16:30 UTC.
    const timestamp = Math.floor(Date.UTC(2026, 0, 14, 16, 30) / 1000);
    expect(formatDateTimeLocal(timestamp, 'Asia/Shanghai')).toBe('2026-01-15T00:30');
    expect(parseDateTimeLocalToTimestamp('2026-01-15T00:30', 'Asia/Shanghai')).toBe(timestamp);
  });

  it('resolves DST-aware offsets when parsing wall-clock times', () => {
    const summer = Math.floor(Date.UTC(2026, 6, 15, 16, 0) / 1000);
    const winter = Math.floor(Date.UTC(2026, 0, 15, 17, 0) / 1000);
    expect(parseDateTimeLocalToTimestamp('2026-07-15T12:00', 'America/New_York')).toBe(summer);
    expect(parseDateTimeLocalToTimestamp('2026-01-15T12:00', 'America/New_York')).toBe(winter);
  });

  it('normalizes nonexistent spring-forward times forward', () => {
    // 02:30 does not exist on 2026-03-08 in New York; it becomes 03:30 EDT.
    const parsed = parseDateTimeLocalToTimestamp('2026-03-08T02:30', 'America/New_York');
    expect(parsed).toBe(Math.floor(Date.UTC(2026, 2, 8, 7, 30) / 1000));
    expect(formatDateTimeLocal(parsed!, 'America/New_York')).toBe('2026-03-08T03:30');
  });

  it('chooses the first occurrence of an ambiguous fall-back time', () => {
    const parsed = parseDateTimeLocalToTimestamp('2026-11-01T01:30', 'America/New_York');
    expect(parsed).toBe(Math.floor(Date.UTC(2026, 10, 1, 5, 30) / 1000));
  });

  it('rejects malformed or impossible datetime-local values', () => {
    expect(parseDateTimeLocalToTimestamp('', 'Asia/Shanghai')).toBeNull();
    expect(parseDateTimeLocalToTimestamp('2026-02-30T10:00', 'Asia/Shanghai')).toBeNull();
    expect(parseDateTimeLocalToTimestamp('2026-01-15 10:00', 'Asia/Shanghai')).toBeNull();
    expect(parseDateTimeLocalToTimestamp('not-a-date', 'Asia/Shanghai')).toBeNull();
  });
});
