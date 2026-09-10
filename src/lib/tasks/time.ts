import { getTimezoneDateParts, type TimezoneSetting } from '@/lib/timezone';
import type { TaskLocalSlot } from './types';

function weekdayForCalendarDate(year: number, month: number, day: number): number {
  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  calendarDate.setUTCHours(0, 0, 0, 0);
  return calendarDate.getUTCDay();
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

export function toTaskLocalSlot(
  timestampSeconds: number,
  timezone: TimezoneSetting,
): TaskLocalSlot {
  if (typeof timestampSeconds !== 'number' || !Number.isFinite(timestampSeconds)) {
    throw new TypeError('Task timestamp must be a finite number of Unix seconds');
  }

  const { parts, formatTimezone } = getTimezoneDateParts(Math.trunc(timestampSeconds), timezone);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    weekday: weekdayForCalendarDate(parts.year, parts.month, parts.day),
    timezone: formatTimezone,
  };
}

export function formatTaskLocalSlot(slot: TaskLocalSlot): string {
  return [
    `${pad(slot.year, 4)}-${pad(slot.month, 2)}-${pad(slot.day, 2)}`,
    `${pad(slot.hour, 2)}:${pad(slot.minute, 2)}`,
  ].join('T');
}
