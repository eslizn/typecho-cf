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

/** Maximum number of access tokens stored in one `tokens` field. */
export const CONFIG_TOKEN_MAX = 20;
/** Accepted access-token shape: generated values plus imported ones. */
export const CONFIG_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
/** Stable identifier for one token row. */
export const CONFIG_TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Maximum length accepted for a value coming from a dynamic option source. */
export const CONFIG_DYNAMIC_OPTION_MAX_LENGTH = 256;

/**
 * Select options resolved at render time from another plugin's capability.
 *
 * The capability has to resolve to a {@link ConfigOptionSourceService}; the
 * host renders whatever the owner reports and leaves value validation to the
 * field's owning plugin, which re-checks the value in plugin:config:beforeSave
 * through the same capability.
 */
export interface ConfigCapabilityOptionSource {
  /** Capability name, for example "ai.models.list". */
  capability: string;
  /** Owner plugin expected to provide the capability. */
  ownerPluginId?: string;
  /** Minimum accepted capability version. Defaults to 1. */
  minVersion?: number;
}

/** Dynamic option source of a select field. */
export type ConfigOptionSource = 'r2Bindings' | ConfigCapabilityOptionSource;

/** Service shape a capability exposes to act as a dynamic option source. */
export interface ConfigOptionSourceService {
  listOptions(): ReadonlyArray<{ value: string; label?: string }>;
}

/** True when a field resolves its options from another plugin's capability. */
export function isCapabilityOptionSource(
  source: ConfigOptionSource | undefined,
): source is ConfigCapabilityOptionSource {
  return !!source
    && typeof source === 'object'
    && typeof source.capability === 'string'
    && source.capability.length > 0;
}

/**
 * Configuration field definition.
 * Mirrors PHP Typecho's Form Element types (Text, Textarea, Select, Radio, Checkbox, Password, Hidden).
 */
export interface ConfigField {
  /** Field type */
  type: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'password' | 'hidden' | 'object' | 'repeatable' | 'tokens';
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
  /** Option values rendered as disabled and rejected on save. */
  optionDisabled?: string[];
  /** Dynamic option source for select fields */
  optionsSource?: ConfigOptionSource;
  /** Conditional visibility inside repeatable config groups */
  showWhen?: {
    field: string;
    value: string | string[];
  };
  /** Nested fields for repeatable config groups */
  itemFields?: Record<string, ConfigField>;
  /** Render a repeatable as collapsible cards with a summary header. */
  collapsible?: boolean;
  /** Item fields whose values form the collapsed summary; defaults to the first text field. */
  summaryFields?: string[];
  /** Item field rendered as a status badge in the card header (for example "enabled"). */
  statusField?: string;
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
    defaults[key] = getFieldDefault(field);
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
        settings[key] = [...new Set(formData.getAll(key).map(v => v.toString()))];
      } else {
        // Boolean toggle: "1" when checked, "0" when unchecked
        settings[key] = formData.has(key) ? '1' : '0';
      }
    } else if (field.type === 'object') {
      settings[key] = parseObjectField(key, field, formData);
    } else if (field.type === 'repeatable') {
      settings[key] = parseRepeatableField(key, field, formData);
    } else if (field.type === 'tokens') {
      settings[key] = parseTokensField(key, formData);
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
  const rows: Record<number, Record<string, any>> = {};
  const prefixPattern = new RegExp(`^${escapeRegExp(key)}\\[(\\d+)\\](?:\\[|$)`);

  for (const name of new Set([...formData.keys()])) {
    const match = name.match(prefixPattern);
    if (!match) continue;
    const index = Number(match[1]);
    if (Number.isSafeInteger(index)) rows[index] ||= {};
  }

  return Object.entries(rows)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([indexText, row]) => {
      const index = Number(indexText);
      const rowPrefix = `${key}[${index}]`;
      const rowId = formData.get(`${rowPrefix}[${CONFIG_ROW_ID}]`);
      if (typeof rowId === 'string' && /^\d+$/.test(rowId)) {
        row[CONFIG_ROW_ID] = rowId;
      }

      let hasDeclaredValue = false;
      for (const [itemKey, itemField] of Object.entries(itemFields)) {
        const inputName = `${rowPrefix}[${itemKey}]`;
        if (hasFormField(formData, inputName, itemField)) hasDeclaredValue = true;
        row[itemKey] = readConfigFieldValue(formData, inputName, itemField);
      }
      if (!hasDeclaredValue) return null;
      return applyRepeatableDefaults(row, itemFields);
    })
    .filter((row): row is Record<string, any> => row !== null)
    .filter(row => Object.entries(row).some(([itemKey, value]) => {
      if (itemKey === CONFIG_ROW_ID) return false;
      if (Array.isArray(value)) return value.length > 0;
      return String(value ?? '').trim() !== '';
    }));
}

/**
 * Parse a read-only access-token list. Each row carries a stable id and its
 * current value; an empty value marks a row that the save boundary fills with
 * a freshly generated token.
 */
function parseTokensField(key: string, formData: FormData): Array<{ id: string; token: string }> {
  const rows: Record<number, { id: string; token: string }> = {};
  const pattern = new RegExp(`^${escapeRegExp(key)}\\[(\\d+)\\]\\[(id|token)\\]$`);
  for (const name of new Set([...formData.keys()])) {
    const match = name.match(pattern);
    if (!match) continue;
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index)) continue;
    const row = rows[index] ||= { id: '', token: '' };
    if (match[2] === 'id') row.id = formData.get(name)?.toString() ?? '';
    else row.token = formData.get(name)?.toString() ?? '';
  }
  return Object.entries(rows)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, row]) => row);
}

function parseObjectField(
  key: string,
  field: ConfigField,
  formData: FormData,
): Record<string, any> {
  const values: Record<string, any> = {};
  for (const [childKey, childField] of Object.entries(field.itemFields || {})) {
    values[childKey] = readConfigFieldValue(formData, `${key}[${childKey}]`, childField);
  }
  return values;
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
    result[key] = row[key] !== undefined
      ? row[key]
      : getFieldDefault(field);
  }
  return result;
}

function readConfigFieldValue(
  formData: FormData,
  name: string,
  field: ConfigField,
): unknown {
  if (field.type === 'checkbox') {
    if (field.options) {
      return [...new Set(formData.getAll(name).map(value => value.toString()))];
    }
    return formData.has(name) ? '1' : '0';
  }
  if (field.type === 'repeatable') {
    return parseRepeatableField(name, field, formData);
  }
  if (field.type === 'object') {
    return parseObjectField(name, field, formData);
  }
  if (field.type === 'tokens') {
    return parseTokensField(name, formData);
  }
  return formData.get(name)?.toString() ?? getFieldDefault(field);
}

function hasFormField(formData: FormData, name: string, field: ConfigField): boolean {
  if (field.type === 'repeatable' || field.type === 'object' || field.type === 'tokens') {
    const prefix = `${name}[`;
    return [...new Set([...formData.keys()])].some(key => key.startsWith(prefix));
  }
  return formData.has(name);
}

function getFieldDefault(field: ConfigField): unknown {
  if (field.default !== undefined) return cloneConfigValue(field.default);
  if (field.type === 'object') {
    return Object.fromEntries(Object.entries(field.itemFields || {}).map(([key, child]) => [key, getFieldDefault(child)]));
  }
  if (field.type === 'repeatable' || field.type === 'tokens') return [];
  if (field.type === 'checkbox') return field.options ? [] : '0';
  return '';
}

function cloneConfigValue(value: unknown): any {
  if (Array.isArray(value)) return value.map(cloneConfigValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneConfigValue(entry)]));
  }
  return value;
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
  if (field.type === 'tokens') {
    // Tokens stay readable so the admin can copy them; the field intentionally
    // has no editable form control.
    return normalizeTokenRows(value);
  }
  if (field.type === 'object' && isRecord(value)) {
    return Object.fromEntries(Object.entries(field.itemFields || {}).map(([key, child]) => [
      key,
      maskConfigValue(child, value[key]),
    ]));
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
  return normalizeConfigValue(field, value);
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
    const value = Object.hasOwn(incoming, key) ? incoming[key] : defaults[key];
    clean[key] = normalizeConfigValue(field, value);
  }
  return clean;
}

export function restoreConfigValue(field: ConfigField, incoming: unknown, previous: unknown): unknown {
  if (isSecretField(field) && incoming === CONFIG_SECRET_PLACEHOLDER) return previous ?? '';
  if (field.type === 'object' && isRecord(incoming)) {
    const previousObject = isRecord(previous) ? previous : {};
    return Object.fromEntries(Object.entries(field.itemFields || {}).map(([key, child]) => [
      key,
      restoreConfigValue(child, incoming[key], previousObject[key]),
    ]));
  }
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
    if (typeof submittedRowId === 'string' && /^\d+$/.test(submittedRowId)) {
      // Keep the transient identity through the validation/allowlist pipeline;
      // stripConfigRowIds() removes it immediately before persistence.
      restored[CONFIG_ROW_ID] = submittedRowId;
    }
    for (const [key, itemField] of Object.entries(itemFields)) {
      restored[key] = restoreConfigValue(itemField, row[key], previousRow[key]);
    }
    return restored;
  });
}

/** Remove transient repeatable row identities before writing configuration. */
export function stripConfigRowIds(
  fields: Record<string, ConfigField>,
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [
    key,
    stripConfigRowIdsForField(field, value[key]),
  ]));
}

function stripConfigRowIdsForField(field: ConfigField, value: unknown): unknown {
  if (field.type === 'object' && isRecord(value)) {
    return Object.fromEntries(Object.entries(field.itemFields || {}).map(([key, child]) => [
      key,
      stripConfigRowIdsForField(child, value[key]),
    ]));
  }
  if (field.type !== 'repeatable' || !Array.isArray(value)) return value;
  const itemFields = field.itemFields || {};
  return value.map(row => {
    if (!isRecord(row)) return {};
    return Object.fromEntries(Object.entries(itemFields).map(([key, child]) => [
      key,
      stripConfigRowIdsForField(child, row[key]),
    ]));
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
    if (!isRecord(saved)) return { ...defaults };
    if (!config) return { ...defaults, ...saved };
    return allowlistConfigSettings(config, saved, defaults) as Record<string, any>;
  } catch {
    return { ...defaults };
  }
}

/**
 * Normalize a value against one field definition. The same routine is used
 * when loading old JSON, accepting a JSON admin submission, and restoring a
 * masked secret from a form. Unknown nested keys are deliberately omitted by
 * the repeatable branch rather than copied through to storage.
 */
function normalizeConfigValue(field: ConfigField, value: unknown): unknown {
  if (field.type === 'object') {
    const source = isRecord(value)
      ? value
      : isRecord(field.default)
        ? field.default
        : {};
    return Object.fromEntries(Object.entries(field.itemFields || {}).map(([key, child]) => [
      key,
      normalizeConfigValue(child, Object.hasOwn(source, key) ? source[key] : getFieldDefault(child)),
    ]));
  }
  if (field.type === 'repeatable') {
    if (!Array.isArray(value)) {
      const fallback = field.default;
      return Array.isArray(fallback)
        ? normalizeRepeatableRows(field, fallback)
        : [];
    }
    return normalizeRepeatableRows(field, value);
  }

  if (field.type === 'tokens') return normalizeTokenRows(value);

  if (field.type === 'checkbox' && field.options) {
    const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    const allowed = new Set(Object.keys(field.options));
    const disabled = disabledOptions(field);
    return [...new Set(values
      .filter(item => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
      .map(String)
      .filter(item => allowed.has(item) && !disabled.has(item)))];
  }

  if (field.type === 'checkbox') {
    if (value === true || value === false) return value;
    if (value === '1' || value === '0') return value;
    return normalizeScalarFallback(field, '0');
  }

  if (field.type === 'select' || field.type === 'radio') {
    const candidate = value === null || value === undefined ? '' : String(value);
    // A capability-backed option source is resolved at render time from another
    // plugin, so membership cannot be checked here. Bound the shape instead;
    // the owning plugin re-validates the value in plugin:config:beforeSave.
    if (isCapabilityOptionSource(field.optionsSource)) {
      return isDynamicOptionValue(candidate) ? candidate : normalizeScalarFallback(field, '');
    }
    if ((!field.options || Object.hasOwn(field.options, candidate)) && !disabledOptions(field).has(candidate)) {
      return candidate;
    }
    return normalizeScalarFallback(field, '');
  }

  if (value === null || value === undefined) return normalizeScalarFallback(field, '');
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return normalizeScalarFallback(field, '');
}

/** Option values a field declares as unavailable in this version. */
function disabledOptions(field: ConfigField): Set<string> {
  return new Set(Array.isArray(field.optionDisabled) ? field.optionDisabled : []);
}

/** Shape guard for a value that came from a dynamic option source. */
function isDynamicOptionValue(value: string): boolean {
  return value.length > 0
    && value.length <= CONFIG_DYNAMIC_OPTION_MAX_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeRepeatableRows(field: ConfigField, value: unknown[]): Record<string, unknown>[] {
  const itemFields = field.itemFields || {};
  return value.filter(isRecord).map((row) => {
    const clean: Record<string, unknown> = {};
    if (typeof row[CONFIG_ROW_ID] === 'string' && /^\d+$/.test(row[CONFIG_ROW_ID])) {
      clean[CONFIG_ROW_ID] = row[CONFIG_ROW_ID];
    }
    for (const [key, itemField] of Object.entries(itemFields)) {
      clean[key] = Object.hasOwn(row, key)
        ? normalizeConfigValue(itemField, row[key])
        : getFieldDefault(itemField);
    }
    return clean;
  });
}

export interface TokenLimitOverflow {
  max: number;
  count: number;
}

/**
 * Detect a token list that exceeds the per-field maximum. Runs on the submitted
 * value before normalization trims it, so the save can fail loudly instead of
 * silently dropping rows.
 */
export function findTokenLimitOverflow(
  fields: Record<string, ConfigField>,
  value: unknown,
): TokenLimitOverflow | null {
  return findTokenOverflowInFields(fields, isRecord(value) ? value : {});
}

function findTokenOverflowInFields(
  fields: Record<string, ConfigField>,
  source: Record<string, unknown>,
): TokenLimitOverflow | null {
  for (const [key, field] of Object.entries(fields)) {
    const found = findTokenOverflowInField(field, source[key]);
    if (found) return found;
  }
  return null;
}

function findTokenOverflowInField(field: ConfigField, value: unknown): TokenLimitOverflow | null {
  if (field.type === 'tokens') {
    const count = Array.isArray(value) ? value.filter(isRecord).length : 0;
    return count > CONFIG_TOKEN_MAX ? { max: CONFIG_TOKEN_MAX, count } : null;
  }
  const itemFields = field.itemFields || {};
  if (field.type === 'object' && isRecord(value)) {
    return findTokenOverflowInFields(itemFields, value);
  }
  if (field.type === 'repeatable' && Array.isArray(value)) {
    for (const row of value) {
      if (!isRecord(row)) continue;
      const found = findTokenOverflowInFields(itemFields, row);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Normalize a token list: keep only well-formed entries, drop duplicates and
 * anything past the cap. The admin UI generates tokens client-side and the
 * save path rejects an overlong list before it gets here.
 */
function normalizeTokenRows(value: unknown): Array<{ id: string; token: string }> {
  if (!Array.isArray(value)) return [];
  const rows: Array<{ id: string; token: string }> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === 'string' && CONFIG_TOKEN_ID_PATTERN.test(entry.id) ? entry.id : '';
    const raw = typeof entry.token === 'string' ? entry.token.trim() : '';
    const token = raw && CONFIG_TOKEN_PATTERN.test(raw) ? raw : '';
    // The admin UI generates tokens client-side; an empty value is dropped.
    if (!token) continue;
    if (token && seen.has(token)) continue;
    if (token) seen.add(token);
    rows.push({ id, token });
    if (rows.length >= CONFIG_TOKEN_MAX) break;
  }
  return rows;
}

function normalizeScalarFallback(field: ConfigField, primitiveFallback: string): unknown {
  const fallback = field.default;
  if (fallback === undefined) return primitiveFallback;
  if (field.type === 'select' || field.type === 'radio') {
    const candidate = String(fallback);
    return (!field.options || Object.hasOwn(field.options, candidate)) && !disabledOptions(field).has(candidate)
      ? candidate
      : primitiveFallback;
  }
  if (field.type === 'checkbox' && !field.options) {
    return fallback === true || fallback === false || fallback === '1' || fallback === '0'
      ? fallback
      : primitiveFallback;
  }
  return typeof fallback === 'string' || typeof fallback === 'number' || typeof fallback === 'boolean'
    ? String(fallback)
    : primitiveFallback;
}
