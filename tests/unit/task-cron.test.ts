import { describe, expect, it } from 'vitest';
import { parseCronExpression, type CronDateFields } from '@/lib/tasks/cron';

function dateFields(overrides: Partial<CronDateFields> = {}): CronDateFields {
  return {
    minute: 0,
    hour: 0,
    dayOfMonth: 1,
    month: 1,
    dayOfWeek: 0,
    ...overrides,
  };
}

describe('parseCronExpression', () => {
  it('supports wildcard, list, range, and step syntax', () => {
    const expression = parseCronExpression('*/15 9-17 1,15 1-12 1-5');

    expect(expression.source).toBe('*/15 9-17 1,15 1-12 1-5');
    expect(expression.matches(dateFields({
      minute: 30,
      hour: 10,
      dayOfMonth: 15,
      month: 6,
      dayOfWeek: 3,
    }))).toBe(true);
    expect(expression.matches(dateFields({
      minute: 31,
      hour: 10,
      dayOfMonth: 15,
      month: 6,
      dayOfWeek: 3,
    }))).toBe(false);
    expect(expression.matches(dateFields({
      minute: 30,
      hour: 8,
      dayOfMonth: 15,
      month: 6,
      dayOfWeek: 3,
    }))).toBe(false);
  });

  it('supports a stepped range and a list of numeric values', () => {
    const expression = parseCronExpression('5 1-3/2 10-12 2,4 0,7');

    expect(expression.matches(dateFields({
      minute: 5,
      hour: 1,
      dayOfMonth: 10,
      month: 2,
      dayOfWeek: 0,
    }))).toBe(true);
    expect(expression.matches(dateFields({
      minute: 5,
      hour: 3,
      dayOfMonth: 12,
      month: 4,
      dayOfWeek: 7,
    }))).toBe(true);
    expect(expression.matches(dateFields({
      minute: 5,
      hour: 2,
      dayOfMonth: 10,
      month: 2,
      dayOfWeek: 0,
    }))).toBe(false);
  });

  it('uses traditional OR semantics when day-of-month and day-of-week are restricted', () => {
    const expression = parseCronExpression('0 0 1 * 1');

    expect(expression.matches(dateFields({
      dayOfMonth: 1,
      month: 6,
      dayOfWeek: 2,
    }))).toBe(true);
    expect(expression.matches(dateFields({
      dayOfMonth: 2,
      month: 6,
      dayOfWeek: 1,
    }))).toBe(true);
    expect(expression.matches(dateFields({
      dayOfMonth: 2,
      month: 6,
      dayOfWeek: 2,
    }))).toBe(false);
  });

  it('treats a stepped day field as restricted for DOM/DOW semantics', () => {
    const expression = parseCronExpression('0 0 */2 * 1');

    expect(expression.matches(dateFields({ dayOfMonth: 3, month: 6, dayOfWeek: 2 }))).toBe(true);
    expect(expression.matches(dateFields({ dayOfMonth: 2, month: 6, dayOfWeek: 1 }))).toBe(true);
    expect(expression.matches(dateFields({ dayOfMonth: 2, month: 6, dayOfWeek: 2 }))).toBe(false);
  });

  it('lets the restricted day field decide when the other day field is wildcard', () => {
    const weekdayExpression = parseCronExpression('0 0 * * 1');
    const dayOfMonthExpression = parseCronExpression('0 0 1 * *');

    expect(weekdayExpression.matches(dateFields({ dayOfMonth: 2, dayOfWeek: 1 }))).toBe(true);
    expect(weekdayExpression.matches(dateFields({ dayOfMonth: 1, dayOfWeek: 2 }))).toBe(false);
    expect(dayOfMonthExpression.matches(dateFields({ dayOfMonth: 1, dayOfWeek: 2 }))).toBe(true);
    expect(dayOfMonthExpression.matches(dateFields({ dayOfMonth: 2, dayOfWeek: 1 }))).toBe(false);
  });

  it('treats both 0 and 7 as Sunday', () => {
    const zeroExpression = parseCronExpression('0 0 * * 0');
    const sevenExpression = parseCronExpression('0 0 * * 7');

    expect(zeroExpression.matches(dateFields({ dayOfWeek: 0 }))).toBe(true);
    expect(zeroExpression.matches(dateFields({ dayOfWeek: 7 }))).toBe(true);
    expect(sevenExpression.matches(dateFields({ dayOfWeek: 0 }))).toBe(true);
    expect(sevenExpression.matches(dateFields({ dayOfWeek: 7 }))).toBe(true);
  });

  it.each([
    '',
    '* * * *',
    '* * * * * *',
    '@hourly',
    '60 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * * 0 *',
    '* * * 13 *',
    '* * * * 8',
    '* * * * MON',
    '*/0 * * * *',
    '* */0 * * *',
    '* * 5-1 * *',
    '* * * * 1,,2',
    '* * * * ,1',
    '* * * * 1,',
  ])('rejects unsupported or out-of-range expression %s', (source) => {
    expect(() => parseCronExpression(source)).toThrow();
  });

  it('rejects invalid date fields before matching', () => {
    const expression = parseCronExpression('* * * * *');

    expect(() => expression.matches(dateFields({ minute: 60 }))).toThrow();
    expect(() => expression.matches(dateFields({ month: 0 }))).toThrow();
    expect(() => expression.matches(dateFields({ dayOfWeek: 8 }))).toThrow();
  });
});
