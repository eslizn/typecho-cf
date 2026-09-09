/**
 * Curated IANA time zone identifiers used by the site settings UI.
 *
 * The list keeps representative capitals and global cities instead of
 * exposing every runtime time-zone identifier or collapsing them into fixed
 * offsets. UTC is included as a neutral option.
 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

export const STANDARD_TIMEZONES = [
  'UTC',
  'Africa/Addis_Ababa',
  'Africa/Cairo',
  'Africa/Casablanca',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'Africa/Nairobi',
  'America/Bogota',
  'America/Buenos_Aires',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Santiago',
  'America/Sao_Paulo',
  'America/Toronto',
  'America/Vancouver',
  'Asia/Bangkok',
  'Asia/Calcutta',
  'Asia/Dubai',
  'Asia/Hong_Kong',
  'Asia/Jakarta',
  'Asia/Karachi',
  'Asia/Manila',
  'Asia/Riyadh',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Taipei',
  'Asia/Tehran',
  'Asia/Tokyo',
  'Australia/Melbourne',
  'Australia/Perth',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Europe/Istanbul',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Moscow',
  'Europe/Paris',
  'Europe/Rome',
  'Europe/Zurich',
  'Pacific/Auckland',
  'Pacific/Honolulu',
] as const;

export type IanaTimezone = typeof STANDARD_TIMEZONES[number];
export type TimezoneSetting = IanaTimezone;

export const TIMEZONE_REGIONS = [
  'Africa',
  'America',
  'Asia',
  'Australia',
  'Europe',
  'Pacific',
] as const;

export const TIMEZONE_REGION_LABEL_KEYS: Readonly<Record<string, string>> = {
  Africa: 'admin.timezone.region.africa',
  America: 'admin.timezone.region.america',
  Asia: 'admin.timezone.region.asia',
  Australia: 'admin.timezone.region.australia',
  Europe: 'admin.timezone.region.europe',
  Pacific: 'admin.timezone.region.pacific',
} as const;

const TIMEZONE_SET = new Set<string>(STANDARD_TIMEZONES);

/** Return true only for a supported, region-bearing IANA identifier. */
export function isIanaTimezone(value: string): value is IanaTimezone {
  return TIMEZONE_SET.has(value);
}

export function getTimezoneRegion(timezone: string): string {
  if (timezone === 'UTC') return 'UTC';
  return timezone.split('/', 1)[0] || 'Other';
}

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getIanaParts(timestamp: number, timezone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(Math.trunc(timestamp) * 1000))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  const result = {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
  if (Object.values(result).some((value) => !Number.isFinite(value))) {
    throw new RangeError(`Unable to format timestamp in timezone ${timezone}`);
  }
  return result;
}

export function getTimezoneDateParts(timestamp: number, timezone: TimezoneSetting): {
  parts: ZonedDateParts;
  formatTimezone: string;
} {
  const requestedTimezone = typeof timezone === 'string' && isIanaTimezone(timezone)
    ? timezone
    : DEFAULT_TIMEZONE;
  try {
    return { parts: getIanaParts(timestamp, requestedTimezone), formatTimezone: requestedTimezone };
  } catch {
    return { parts: getIanaParts(timestamp, DEFAULT_TIMEZONE), formatTimezone: DEFAULT_TIMEZONE };
  }
}

/** Return the current offset of an IANA zone for a given Unix timestamp. */
export function getTimezoneOffsetSeconds(timezone: string, timestamp = Math.floor(Date.now() / 1000)): number {
  const parts = getIanaParts(timestamp, timezone);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round(localAsUtc / 1000 - Math.trunc(timestamp));
}

/** Format a region-bearing IANA ID for the settings list without runtime ICU work. */
export function formatTimezoneLabel(timezone: string): string {
  return timezone;
}
