import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEZONE,
  formatTimezoneLabel,
  getTimezoneOffsetSeconds,
  getTimezoneRegion,
  isIanaTimezone,
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
});
