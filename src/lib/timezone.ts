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

/** Formatter construction is expensive; one formatter per configured zone. */
const IANA_FORMATTER_CACHE_LIMIT = 64;
const ianaFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getIanaFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = ianaFormatterCache.get(timezone);
  if (cached) return cached;

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
  if (ianaFormatterCache.size >= IANA_FORMATTER_CACHE_LIMIT) {
    const oldest = ianaFormatterCache.keys().next().value;
    if (oldest !== undefined) ianaFormatterCache.delete(oldest);
  }
  ianaFormatterCache.set(timezone, formatter);
  return formatter;
}

function getIanaParts(timestamp: number, timezone: string): ZonedDateParts {
  const formatter = getIanaFormatter(timezone);
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

function utcTimestamp(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime() / 1000;
}

/** Return the current offset of an IANA zone for a given Unix timestamp. */
export function getTimezoneOffsetSeconds(timezone: string, timestamp = Math.floor(Date.now() / 1000)): number {
  const parts = getIanaParts(timestamp, timezone);
  const localAsUtc = utcTimestamp(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round(localAsUtc - Math.trunc(timestamp));
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Format a Unix timestamp as a `datetime-local` value in the site timezone.
 */
export function formatDateTimeLocal(
  timestampSeconds: number,
  timezone: TimezoneSetting,
): string {
  const timestamp = Number.isFinite(timestampSeconds)
    ? Math.trunc(timestampSeconds)
    : Math.floor(Date.now() / 1000);
  const { parts } = getTimezoneDateParts(timestamp, timezone);
  return `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

const DATETIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Parse a `datetime-local` value as a wall-clock time in the site timezone and
 * return the corresponding Unix timestamp.
 *
 * The offset is resolved from the candidate instants around the requested
 * wall time. For ambiguous fall-back times the first occurrence is chosen;
 * for nonexistent spring-forward times the pre-transition offset is used, so
 * the instant normalizes forward (matching PHP's date handling).
 */
export function parseDateTimeLocalToTimestamp(
  value: string,
  timezone: TimezoneSetting,
): number | null {
  const match = DATETIME_LOCAL_PATTERN.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (
    year < 1 || year > 9999
    || month < 1 || month > 12
    || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59
  ) return null;

  const utcGuess = utcTimestamp(year, month, day, hour, minute, second);
  if (!Number.isFinite(utcGuess)) return null;

  const calendarCheck = new Date(utcGuess * 1000);
  if (
    calendarCheck.getUTCFullYear() !== year
    || calendarCheck.getUTCMonth() !== month - 1
    || calendarCheck.getUTCDate() !== day
  ) return null;

  const zone = isIanaTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
  const matchesWallClock = (candidate: number): boolean => {
    const parts = getIanaParts(candidate, zone);
    return parts.year === year
      && parts.month === month
      && parts.day === day
      && parts.hour === hour
      && parts.minute === minute
      && parts.second === second;
  };

  const offsets: number[] = [];
  for (const delta of [-86_400, 0, 86_400]) {
    const offset = getTimezoneOffsetSeconds(zone, utcGuess + delta);
    if (!offsets.includes(offset)) offsets.push(offset);
  }

  for (const offset of offsets) {
    const candidate = utcGuess - offset;
    if (matchesWallClock(candidate)) return candidate;
  }

  // Nonexistent local time (usually the spring-forward gap): keep the
  // pre-transition offset so the instant moves forward past the gap.
  return utcGuess - offsets[0];
}

/** UTC bounds of a calendar month in the site's timezone. */
export function getMonthBounds(year: number, month: number, timezone: TimezoneSetting) {
  const startOf = (y: number, m: number) => parseDateTimeLocalToTimestamp(
    `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01T00:00`, timezone,
  );
  return {
    start: startOf(year, month),
    end: month === 12 ? startOf(year + 1, 1) : startOf(year, month + 1),
  };
}

/** Format a region-bearing IANA ID for the settings list without runtime ICU work. */
export function formatTimezoneLabel(timezone: string): string {
  return timezone;
}
