export interface CronDateFields {
  readonly minute: number;
  readonly hour: number;
  readonly dayOfMonth: number;
  readonly month: number;
  readonly dayOfWeek: number;
}

export interface CompiledCronExpression {
  readonly source: string;
  matches(fields: CronDateFields): boolean;
}

interface CronFieldDefinition {
  readonly name: keyof CronDateFields;
  readonly minimum: number;
  readonly maximum: number;
}

interface ParsedCronField {
  readonly values: ReadonlySet<number>;
  readonly wildcard: boolean;
}

const CRON_FIELDS: readonly CronFieldDefinition[] = [
  { name: 'minute', minimum: 0, maximum: 59 },
  { name: 'hour', minimum: 0, maximum: 23 },
  { name: 'dayOfMonth', minimum: 1, maximum: 31 },
  { name: 'month', minimum: 1, maximum: 12 },
  { name: 'dayOfWeek', minimum: 0, maximum: 7 },
];

const INTEGER_PATTERN = /^\d+$/;

function invalidCronField(field: string, fieldName: string): RangeError {
  return new RangeError(`Invalid ${fieldName} Cron field: ${field}`);
}

function parseInteger(value: string, field: string, fieldName: string): number {
  if (!INTEGER_PATTERN.test(value)) throw invalidCronField(field, fieldName);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalidCronField(field, fieldName);
  return parsed;
}

function ensureInRange(value: number, minimum: number, maximum: number, field: string, fieldName: string): void {
  if (value < minimum || value > maximum) throw invalidCronField(field, fieldName);
}

function parseCronField(
  field: string,
  definition: CronFieldDefinition,
): ParsedCronField {
  if (field.length === 0) throw invalidCronField(field, definition.name);

  const values = new Set<number>();

  for (const term of field.split(',')) {
    if (term.length === 0) throw invalidCronField(field, definition.name);

    const slashIndex = term.indexOf('/');
    if (slashIndex !== -1 && term.indexOf('/', slashIndex + 1) !== -1) {
      throw invalidCronField(field, definition.name);
    }

    const base = slashIndex === -1 ? term : term.slice(0, slashIndex);
    const stepText = slashIndex === -1 ? undefined : term.slice(slashIndex + 1);
    let step = 1;

    if (stepText !== undefined) {
      step = parseInteger(stepText, field, definition.name);
      if (step === 0) throw invalidCronField(field, definition.name);
    }

    let start: number;
    let end: number;
    if (base === '*') {
      start = definition.minimum;
      end = definition.maximum;
    } else if (base.includes('*')) {
      throw invalidCronField(field, definition.name);
    } else if (base.includes('-')) {
      const range = base.split('-');
      if (range.length !== 2 || range.some((value) => value.length === 0)) {
        throw invalidCronField(field, definition.name);
      }
      start = parseInteger(range[0], field, definition.name);
      end = parseInteger(range[1], field, definition.name);
      if (start > end) throw invalidCronField(field, definition.name);
      ensureInRange(start, definition.minimum, definition.maximum, field, definition.name);
      ensureInRange(end, definition.minimum, definition.maximum, field, definition.name);
    } else {
      start = parseInteger(base, field, definition.name);
      ensureInRange(start, definition.minimum, definition.maximum, field, definition.name);
      end = slashIndex === -1 ? start : definition.maximum;
    }

    for (let value = start; value <= end; value += step) {
      values.add(definition.name === 'dayOfWeek' && value === 7 ? 0 : value);
    }
  }

  if (values.size === 0) throw invalidCronField(field, definition.name);
  let wildcard = true;
  for (let value = definition.minimum; value <= definition.maximum; value += 1) {
    const normalized = definition.name === 'dayOfWeek' && value === 7 ? 0 : value;
    if (!values.has(normalized)) {
      wildcard = false;
      break;
    }
  }
  return { values, wildcard };
}

function validateDateField(
  value: number,
  definition: CronFieldDefinition,
): number {
  if (!Number.isInteger(value)) {
    throw new RangeError(`Invalid ${definition.name} date value: ${String(value)}`);
  }
  ensureInRange(value, definition.minimum, definition.maximum, String(value), definition.name);
  return definition.name === 'dayOfWeek' && value === 7 ? 0 : value;
}

function validateDateFields(fields: CronDateFields): CronDateFields {
  if (fields === null || typeof fields !== 'object') {
    throw new TypeError('Cron date fields must be an object');
  }

  const values = CRON_FIELDS.map((definition) => (
    validateDateField(fields[definition.name], definition)
  ));

  return {
    minute: values[0],
    hour: values[1],
    dayOfMonth: values[2],
    month: values[3],
    dayOfWeek: values[4],
  };
}

function matchesParsedFields(
  parsedFields: readonly ParsedCronField[],
  fields: CronDateFields,
): boolean {
  const date = validateDateFields(fields);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsedFields;

  if (!minute.values.has(date.minute) || !hour.values.has(date.hour)) return false;
  if (!month.values.has(date.month)) return false;

  const dayOfMonthMatches = dayOfMonth.values.has(date.dayOfMonth);
  const dayOfWeekMatches = dayOfWeek.values.has(date.dayOfWeek);
  const dayMatches = dayOfMonth.wildcard && dayOfWeek.wildcard
    ? true
    : dayOfMonth.wildcard
      ? dayOfWeekMatches
      : dayOfWeek.wildcard
        ? dayOfMonthMatches
        : dayOfMonthMatches || dayOfWeekMatches;

  return dayMatches;
}

export function parseCronExpression(source: string): CompiledCronExpression {
  if (typeof source !== 'string') throw new TypeError('Cron expression must be a string');

  const normalizedSource = source.trim();
  const fields = normalizedSource.length === 0 ? [] : normalizedSource.split(/\s+/);
  if (fields.length !== CRON_FIELDS.length) {
    throw new RangeError('Cron expression must have exactly five fields');
  }

  const parsedFields = CRON_FIELDS.map((definition, index) => (
    parseCronField(fields[index], definition)
  ));

  return {
    source: normalizedSource,
    matches: (dateFields) => matchesParsedFields(parsedFields, dateFields),
  };
}
