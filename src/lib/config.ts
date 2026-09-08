/**
 * Generic configuration-field machinery shared by plugins and themes.
 *
 * Both plugin config (package.json `typecho.plugin.config`) and theme config
 * (theme.json `config`) use the same field schema, form parsing, default
 * resolution, secret masking and sanitization rules. Keeping them in one
 * module guarantees the two systems cannot drift apart.
 */

/** Internal form metadata used to preserve repeatable rows across reordering. */
export const CONFIG_ROW_ID = '__typechoConfigRowId';

/** Placeholder used to mask secret (password/hidden) values in admin views. */
export const CONFIG_SECRET_PLACEHOLDER = '__PLUGIN_CONFIG_SECRET__';

/**
 * Configuration field definition.
 * Mirrors PHP Typecho's Form Element types (Text, Textarea, Select, Radio, Checkbox, Password, Hidden).
 */
export interface ConfigField {
  /** Field type */
  type: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'password' | 'hidden' | 'repeatable';
  /** Display label */
  label: string;
  /** Optional explicit translation key; convention-based keys are used otherwise. */
  labelKey?: string;
  /** Help text / description shown below the field */
  description?: string;
  /** Optional explicit translation key; convention-based keys are used otherwise. */
  descriptionKey?: string;
  /** Default value */
  default?: unknown;
  /** Options for select / radio / checkbox: { value: label } */
  options?: Record<string, string>;
  /** Optional explicit translation keys for option labels, keyed by option value. */
  optionKeys?: Record<string, string>;
  /** Dynamic option source for select fields */
  optionsSource?: 'r2Bindings';
  /** Conditional visibility inside repeatable config groups */
  showWhen?: {
    field: string;
    value: string | string[];
  };
  /** Nested fields for repeatable config groups */
  itemFields?: Record<string, ConfigField>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolve default values from a config definition.
 * Returns a flat object { fieldName: defaultValue }.
 */
export function getConfigDefaults(
  config: Record<string, ConfigField> | undefined,
): Record<string, any> {
  if (!config) return {};

  const defaults: Record<string, any> = {};
  for (const [key, field] of Object.entries(config)) {
    if (field.default !== undefined) {
      defaults[key] = field.default;
    } else if (field.type === 'checkbox') {
      defaults[key] = [];
    } else if (field.type === 'repeatable') {
      defaults[key] = [];
    } else {
      defaults[key] = '';
    }
  }
  return defaults;
}

/**
 * Parse a configuration form according to a config definition.
 * Used for both plugin and theme config forms.
 */
export function parseConfigFormData(
  configDef: Record<string, ConfigField>,
  formData: FormData,
): Record<string, any> {
  const settings: Record<string, any> = {};
  for (const [key, field] of Object.entries(configDef)) {
    if (field.type === 'checkbox') {
      if (field.options) {
        settings[key] = formData.getAll(key).map(v => v.toString());
      } else {
        // Boolean toggle: "1" when checked, "0" when unchecked
        settings[key] = formData.has(key) ? '1' : '0';
      }
    } else if (field.type === 'repeatable') {
      settings[key] = parseRepeatableField(key, field, formData);
    } else {
      settings[key] = formData.get(key)?.toString() ?? '';
    }
  }
  return settings;
}

function parseRepeatableField(
  key: string,
  field: ConfigField,
  formData: FormData,
): Record<string, any>[] {
  const itemFields = field.itemFields || {};
  const rows = new Map<number, Record<string, any>>();
  const pattern = new RegExp(`^${escapeRegExp(key)}\\[(\\d+)\\]\\[([^\\]]+)\\]$`);

  for (const [name, value] of formData.entries()) {
    const match = name.match(pattern);
    if (!match) continue;

    const index = Number(match[1]);
    const itemKey = match[2];
    if (!Number.isInteger(index) || (itemKey !== CONFIG_ROW_ID && !itemFields[itemKey])) continue;

    const row = rows.get(index) || {};
    if (itemKey === CONFIG_ROW_ID) {
      row[itemKey] = value.toString();
      rows.set(index, row);
      continue;
    }
    const itemField = itemFields[itemKey];
    if (itemField.type === 'checkbox') {
      row[itemKey] = formData.getAll(name).map(v => v.toString());
    } else {
      row[itemKey] = value.toString();
    }
    rows.set(index, row);
  }

  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => applyRepeatableDefaults(row, itemFields))
    .filter(row => Object.entries(row).some(([itemKey, value]) => {
      if (itemKey === CONFIG_ROW_ID) return false;
      if (Array.isArray(value)) return value.length > 0;
      return String(value ?? '').trim() !== '';
    }));
}

function applyRepeatableDefaults(
  row: Record<string, any>,
  itemFields: Record<string, ConfigField>,
): Record<string, any> {
  const result: Record<string, any> = {};
  if (typeof row[CONFIG_ROW_ID] === 'string' && /^\d+$/.test(row[CONFIG_ROW_ID])) {
    result[CONFIG_ROW_ID] = row[CONFIG_ROW_ID];
  }
  for (const [key, field] of Object.entries(itemFields)) {
    if (row[key] !== undefined) {
      result[key] = row[key];
    } else if (field.default !== undefined) {
      result[key] = field.default;
    } else if (field.type === 'checkbox') {
      result[key] = [];
    } else {
      result[key] = '';
    }
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Admin view masking / sanitization ──────────────────────────────────

function isSecretField(field: ConfigField): boolean {
  return field.type === 'password' || field.type === 'hidden';
}

export function maskConfigValue(field: ConfigField, value: unknown): unknown {
  if (isSecretField(field)) {
    return value === null || value === undefined || String(value).length === 0
      ? ''
      : CONFIG_SECRET_PLACEHOLDER;
  }
  if (field.type !== 'repeatable' || !Array.isArray(value)) return value;
  const itemFields = field.itemFields || {};
  return value.map((row, index) => {
    if (!isRecord(row)) return {};
    const masked: Record<string, unknown> = { [CONFIG_ROW_ID]: String(index) };
    for (const [key, itemField] of Object.entries(itemFields)) {
      masked[key] = maskConfigValue(itemField, row[key]);
    }
    return masked;
  });
}

export function maskConfigValues(
  fields: Record<string, ConfigField>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    masked[key] = maskConfigValue(field, values[key]);
  }
  return masked;
}

export function maskConfigDefinition(field: ConfigField): ConfigField {
  const masked: ConfigField = { ...field };
  if (isSecretField(field) && field.default !== undefined) {
    masked.default = field.default === '' ? '' : CONFIG_SECRET_PLACEHOLDER;
  }
  if (field.itemFields) {
    masked.itemFields = Object.fromEntries(
      Object.entries(field.itemFields).map(([key, item]) => [key, maskConfigDefinition(item)]),
    );
  }
  return masked;
}

export function maskConfigDefinitions(
  fields: Record<string, ConfigField>,
): Record<string, ConfigField> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, maskConfigDefinition(field)]),
  );
}

export function sanitizeConfigValue(field: ConfigField, value: unknown): unknown {
  if (field.type !== 'repeatable') return value;
  if (!Array.isArray(value)) return [];
  const itemFields = field.itemFields || {};
  return value.filter(isRecord).map((row) => {
    const clean: Record<string, unknown> = {};
    if (typeof row[CONFIG_ROW_ID] === 'string' && /^\d+$/.test(row[CONFIG_ROW_ID])) {
      clean[CONFIG_ROW_ID] = row[CONFIG_ROW_ID];
    }
    for (const [key, itemField] of Object.entries(itemFields)) {
      if (Object.hasOwn(row, key)) clean[key] = sanitizeConfigValue(itemField, row[key]);
      else if (itemField.default !== undefined) clean[key] = itemField.default;
      else clean[key] = itemField.type === 'checkbox' || itemField.type === 'repeatable' ? [] : '';
    }
    return clean;
  });
}

/**
 * Keep only keys declared in the config definition, applying defaults for
 * missing keys. Prevents arbitrary key injection into stored JSON.
 */
export function allowlistConfigSettings(
  fields: Record<string, ConfigField>,
  incoming: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    clean[key] = sanitizeConfigValue(field, Object.hasOwn(incoming, key) ? incoming[key] : defaults[key]);
  }
  return clean;
}

export function restoreConfigValue(field: ConfigField, incoming: unknown, previous: unknown): unknown {
  if (isSecretField(field) && incoming === CONFIG_SECRET_PLACEHOLDER) return previous ?? '';
  if (field.type !== 'repeatable' || !Array.isArray(incoming)) return incoming;
  const previousRows = Array.isArray(previous) ? previous : [];
  const itemFields = field.itemFields || {};
  return incoming.map((row, index) => {
    if (!isRecord(row)) return {};
    const submittedRowId = row[CONFIG_ROW_ID];
    const previousIndex = typeof submittedRowId === 'string' && /^\d+$/.test(submittedRowId)
      ? Number(submittedRowId)
      : index;
    const previousRow = Number.isSafeInteger(previousIndex) && isRecord(previousRows[previousIndex])
      ? previousRows[previousIndex]
      : {};
    const restored: Record<string, unknown> = {};
    for (const [key, itemField] of Object.entries(itemFields)) {
      restored[key] = restoreConfigValue(itemField, row[key], previousRow[key]);
    }
    return restored;
  });
}

export function restoreConfigSecrets(
  fields: Record<string, ConfigField>,
  incoming: Record<string, unknown>,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  const restored: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    restored[key] = restoreConfigValue(field, incoming[key], previous[key]);
  }
  return restored;
}

/**
 * Load a config from the options table.
 * Key format is caller-provided (e.g. "plugin:<id>" or "theme:<id>"),
 * value is a JSON string. Falls back to defaults when not saved yet.
 *
 * @param options - Site options object from loadOptions() (contains all option rows)
 * @param optionKey - Option row name holding the JSON config
 * @param config - Config definition used to resolve defaults
 * @returns Merged config object (saved values + defaults for missing keys)
 */
export function loadConfig(
  options: Record<string, any>,
  optionKey: string,
  config?: Record<string, ConfigField>,
): Record<string, any> {
  const defaults = getConfigDefaults(config);
  const raw = options?.[optionKey];

  if (!raw) return { ...defaults };

  try {
    const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { ...defaults, ...saved };
  } catch {
    return { ...defaults };
  }
}
