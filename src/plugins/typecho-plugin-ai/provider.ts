import { CONFIG_TOKEN_MAX, CONFIG_TOKEN_PATTERN } from '@/lib/config';
import {
  AI_CAPABILITIES,
  AI_MODALITIES,
  type AiCapability,
  type AiChatRequest,
  type AiConfig,
  type AiModelConfig,
  type AiModelModality,
  type AiAccessToken,
  type AiProviderConfig,
} from './types';
import { readBoundedBytes } from './io';

export interface AiValidationLimits {
  concurrency: number;
  requestTimeoutMs: number;
  totalBudgetMs: number;
  responseBodyBytes: number;
}

export const AI_VALIDATION_LIMITS = {
  concurrency: 4,
  // The host wraps plugin config hooks in a 5 second budget. Keep the AI
  // validation budget below that ceiling while still checking providers in a
  // bounded parallel pool.
  requestTimeoutMs: 1_200,
  totalBudgetMs: 4_500,
  responseBodyBytes: 256 * 1024,
} as const satisfies AiValidationLimits;

export interface AiRequestLimits {
  /** Total generation budget for a stream after it has started producing data. */
  timeoutMs: number;
  /** Per-attempt budget for upstream response headers or the first stream chunk. */
  initialTimeoutMs?: number;
  requestBodyBytes: number;
  responseBodyBytes: number;
  maxMessages: number;
  maxTools: number;
  maxToolSchemaBytes: number;
  maxTextBytes: number;
  maxMediaBytes: number;
}

export const AI_REQUEST_LIMITS = {
  // Keep the long-lived stream budget separate from the short first-response
  // budget. The latter lets callers fail over quickly without cutting off a
  // stream that has already started producing useful output.
  timeoutMs: 120_000,
  initialTimeoutMs: 3_000,
  requestBodyBytes: 2 * 1024 * 1024,
  responseBodyBytes: 8 * 1024 * 1024,
  maxMessages: 100,
  maxTools: 64,
  maxToolSchemaBytes: 256 * 1024,
  maxTextBytes: 2 * 1024 * 1024,
  maxMediaBytes: 8 * 1024 * 1024,
} as const satisfies AiRequestLimits;

export interface AiModelCandidate {
  provider: AiProviderConfig;
  model: AiModelConfig;
  logicalModel: string;
}

/** Token limits discovered from a provider's non-standard model metadata. */
export interface AiModelLimits {
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface AiModelLimitDiscovery extends AiModelLimits {
  providerName: string;
  model: string;
}

/**
 * Parse a positive token limit from config text or provider metadata.
 * Empty, fractional, negative, and non-numeric values are rejected.
 */
export function parseTokenLimit(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Fill missing model limits from provider metadata. Admin-provided values
 * always win; only unset fields are populated.
 */
export function applyDiscoveredModelLimits(
  config: AiConfig,
  discoveries: readonly AiModelLimitDiscovery[],
): void {
  if (discoveries.length === 0) return;
  const byKey = new Map<string, AiModelLimitDiscovery>();
  for (const discovery of discoveries) {
    byKey.set(`${discovery.providerName}\u0000${discovery.model}`, discovery);
  }
  for (const provider of config.providers) {
    for (const model of provider.models) {
      const discovered = byKey.get(`${provider.name}\u0000${model.model}`);
      if (!discovered) continue;
      if (model.contextWindow === undefined && discovered.contextWindow !== undefined) {
        model.contextWindow = discovered.contextWindow;
      }
      if (model.maxOutputTokens === undefined && discovered.maxOutputTokens !== undefined) {
        model.maxOutputTokens = discovered.maxOutputTokens;
      }
    }
  }
}

/** Reject invalid raw limit input before normalization can silently drop it. */
export function validateRawModelLimits(raw: unknown): void {
  if (!isRecord(raw)) return;
  const providers = Array.isArray(raw.providers) ? raw.providers : [];
  for (const provider of providers) {
    if (!isRecord(provider)) continue;
    const models = Array.isArray(provider.models) ? provider.models : [];
    for (const model of models) {
      if (!isRecord(model)) continue;
      for (const [field, code] of [
        ['contextWindow', 'context-window-invalid'],
        ['maxOutputTokens', 'max-output-tokens-invalid'],
      ] as const) {
        const value = model[field];
        if (value === undefined || value === null || value === '') continue;
        if (parseTokenLimit(value) === undefined) {
          throw new AiConfigValidationError(
            `Model ${field} must be a positive integer token count.`,
            code,
          );
        }
      }
    }
  }
}

export class AiConfigValidationError extends Error {
  readonly name = 'AiConfigValidationError';
  readonly code: string;
  readonly params: Record<string, string | number>;

  constructor(message: string, code = 'invalid-config', params: Record<string, string | number> = {}) {
    super(message);
    this.code = code;
    this.params = params;
  }
}

export function normalizeAiConfig(raw: unknown): AiConfig {
  const source = isRecord(raw) ? raw : {};
  const providers = Array.isArray(source.providers)
    ? source.providers.filter(isRecord).map(normalizeProvider).filter(provider => (
      provider.name || provider.baseUrl || provider.apiKey || provider.models.length > 0
    ))
    : [];
  const httpSource = isRecord(source.http) ? source.http : {};

  return {
    providers,
    http: {
      enabled: parseBoolean(httpSource.enabled, false),
      basePath: normalizeBasePath(httpSource.basePath),
      tokens: normalizeAccessTokens(httpSource.tokens),
    },
  };
}

/** Normalize the token list; an empty token marks a row filled in on save. */
export function normalizeAccessTokens(raw: unknown): AiAccessToken[] {
  if (!Array.isArray(raw)) return [];
  const tokens: AiAccessToken[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const token = typeof entry.token === 'string' ? entry.token.trim() : '';
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!token && !id) continue;
    tokens.push({ id, token });
    if (tokens.length >= CONFIG_TOKEN_MAX) break;
  }
  return tokens;
}

export function normalizeProviderConfig(raw: unknown): AiProviderConfig {
  return normalizeProvider(isRecord(raw) ? raw : {});
}

export function normalizeBasePath(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '/ai';
  const normalized = value.startsWith('/') ? value : `/${value}`;
  return normalized.replace(/\/+/g, '/').replace(/\/+$/, '') || '/ai';
}

export function normalizeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  if (!url.hostname || isIpLiteral(url.hostname) || isPrivateHostname(url.hostname)) return null;
  try {
    const decodedPath = decodeURIComponent(url.pathname);
    if (decodedPath.split('/').some(segment => segment === '..')) return null;
  } catch {
    return null;
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

export function buildProviderEndpoint(baseUrl: string, suffix: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${normalizedBase}${normalizedSuffix}`;
}

export function logicalModelName(model: AiModelConfig): string {
  return model.alias?.trim() || model.model;
}

export function validateAiConfigLocally(config: AiConfig): void {
  const seenProviderNames = new Set<string>();
  for (const provider of config.providers) {
    const providerName = provider.name.trim();
    if (!providerName) {
      throw new AiConfigValidationError('Each provider needs a name.', 'provider-name-required');
    }
    if (providerName.length > 128) {
      throw new AiConfigValidationError('Provider names must be at most 128 characters.', 'provider-name-too-long', { max: 128 });
    }
    if (seenProviderNames.has(providerName)) {
      throw new AiConfigValidationError(`Provider name ${providerName} is duplicated.`, 'provider-name-duplicate', { name: providerName });
    }
    seenProviderNames.add(providerName);

    if (provider.baseUrl.length > 2_048) {
      throw new AiConfigValidationError(`Provider ${providerName} has an overly long base URL.`, 'base-url-too-long', { name: providerName });
    }
    if (provider.apiKey.length > 8_192) {
      throw new AiConfigValidationError(`Provider ${providerName} has an overly long API key.`, 'api-key-too-long', { name: providerName });
    }

    for (const model of provider.models) {
      if (model.model.length > 256 || (model.alias?.length ?? 0) > 256) {
        throw new AiConfigValidationError(`Model names and aliases in provider ${providerName} must be at most 256 characters.`, 'model-name-too-long', { name: providerName });
      }
      if (model.contextWindow !== undefined && parseTokenLimit(model.contextWindow) === undefined) {
        throw new AiConfigValidationError(`Model contextWindow in provider ${providerName} must be a positive integer.`, 'context-window-invalid', { name: providerName });
      }
      if (model.maxOutputTokens !== undefined && parseTokenLimit(model.maxOutputTokens) === undefined) {
        throw new AiConfigValidationError(`Model maxOutputTokens in provider ${providerName} must be a positive integer.`, 'max-output-tokens-invalid', { name: providerName });
      }
    }

    if (provider.baseUrl && !normalizeBaseUrl(provider.baseUrl)) {
      throw new AiConfigValidationError(`Provider ${providerName} must use a public HTTPS base URL without credentials, query, or fragment.`, 'base-url-invalid', { name: providerName });
    }
    const seenModels = new Set<string>();
    for (const model of provider.models) {
      if (!model.enabled || !model.model.trim()) continue;
      const logical = logicalModelName(model);
      if (seenModels.has(logical)) {
        throw new AiConfigValidationError(`Model alias ${logical} is duplicated within provider ${providerName}.`, 'model-alias-duplicate', { name: providerName, model: logical });
      }
      seenModels.add(logical);
      if (!model.capabilities.includes(AI_CAPABILITIES.chatGenerate)) continue;
      if (!model.modalities.includes(AI_MODALITIES.text)) {
        throw new AiConfigValidationError(`Chat model ${logical} in provider ${providerName} must support text modality.`, 'chat-model-modality', { name: providerName, model: logical });
      }
    }
  }
  if (config.http.enabled && !isValidHttpBasePath(config.http.basePath)) {
    throw new AiConfigValidationError('HTTP base path must be a site-relative path without query, fragment, or traversal segments.', 'http-base-path-invalid');
  }
  if (config.http.enabled && config.http.tokens.length > CONFIG_TOKEN_MAX) {
    throw new AiConfigValidationError(
      `At most ${CONFIG_TOKEN_MAX} access tokens are allowed.`,
      'http-token-limit',
      { max: CONFIG_TOKEN_MAX },
    );
  }
  if (config.http.enabled) {
    for (const entry of config.http.tokens) {
      // Pending rows carry an empty token until the save boundary fills them.
      if (!entry.token || CONFIG_TOKEN_PATTERN.test(entry.token)) continue;
      throw new AiConfigValidationError(
        'Access tokens must be 16-128 characters using letters, digits, underscore, or hyphen.',
        'http-token-invalid',
      );
    }
  }
}
export interface AiModelOption {
  value: string;
  label: string;
}

/**
 * Public chat model catalog: the aliases an admin can pick, merged and deduped
 * across every provider.
 *
 * Only the alias is published. The upstream model name is an internal detail of
 * the provider entry, so a model without an alias stays private and cannot be
 * selected by other plugins or through the HTTP surface.
 */
export function listChatModelOptions(config: AiConfig): AiModelOption[] {
  const options: AiModelOption[] = [];
  const seen = new Set<string>();
  for (const provider of config.providers) {
    if (!normalizeBaseUrl(provider.baseUrl)) continue;
    for (const model of provider.models) {
      const alias = model.alias?.trim() || '';
      if (!alias || !model.enabled || !model.model) continue;
      if (!model.capabilities.includes(AI_CAPABILITIES.chatGenerate)) continue;
      if (!model.modalities.includes(AI_MODALITIES.text)) continue;
      if (seen.has(alias)) continue;
      seen.add(alias);
      options.push({ value: alias, label: alias });
    }
  }
  return options;
}

export function listChatModels(config: AiConfig): string[] {
  return listChatModelOptions(config).map(option => option.value);
}

export function selectAiModel(
  config: AiConfig,
  request: AiChatRequest,
  fitsContext?: (model: AiModelConfig) => boolean,
): { candidate?: AiModelCandidate; reason: 'ok' | 'no-available-model' | 'model-not-found' | 'unsupported-modality' | 'context-exceeded' } {
  validateAiConfigLocally(config);
  const allChatCandidates: AiModelCandidate[] = [];
  const requestedCandidates: AiModelCandidate[] = [];
  for (const provider of config.providers) {
    if (!normalizeBaseUrl(provider.baseUrl)) continue;
    for (const model of provider.models) {
      if (!model.enabled || !model.model || !model.capabilities.includes(AI_CAPABILITIES.chatGenerate)) continue;
      if (!model.modalities.includes(AI_MODALITIES.text)) continue;
      const candidate = { provider, model, logicalModel: logicalModelName(model) };
      allChatCandidates.push(candidate);
      if (request.model && candidate.logicalModel === request.model) requestedCandidates.push(candidate);
    }
  }
  if (request.model && requestedCandidates.length === 0) {
    return { reason: 'model-not-found' };
  }
  const pool = request.model ? requestedCandidates : allChatCandidates;
  if (pool.length === 0) return { reason: 'no-available-model' };
  const compatible = pool.filter(candidate => supportsRequestModalities(candidate.model, request));
  if (compatible.length === 0) return { reason: 'unsupported-modality' };
  const eligible = fitsContext ? compatible.filter(candidate => fitsContext(candidate.model)) : compatible;
  if (eligible.length === 0) return { reason: 'context-exceeded' };
  return { candidate: eligible[randomIndex(eligible.length)], reason: 'ok' };
}

export function supportsRequestModalities(model: AiModelConfig, request: AiChatRequest): boolean {
  const required = new Set<AiModelModality>([AI_MODALITIES.text]);
  for (const message of request.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'image_url') required.add(AI_MODALITIES.image);
      if (part.type === 'input_audio') required.add(AI_MODALITIES.audioInput);
    }
  }
  if (request.modalities?.includes('audio') || request.audio) required.add(AI_MODALITIES.audioOutput);
  return [...required].every(modality => model.modalities.includes(modality));
}

export async function validateAiConfig(
  config: AiConfig,
  fetcher: typeof fetch = fetch,
  limits: AiValidationLimits = AI_VALIDATION_LIMITS,
): Promise<AiModelLimitDiscovery[]> {
  validateAiConfigLocally(config);
  const jobs = config.providers.filter(provider => (
    provider.models.some(model => model.enabled && model.model)
  ));
  if (jobs.length === 0) return [];

  type ListResult =
    | { provider: AiProviderConfig; fallback: true }
    | { provider: AiProviderConfig; discoveries: AiModelLimitDiscovery[] }
    | { provider: AiProviderConfig; error: unknown };
  type FallbackResult =
    | { discovery: AiModelLimitDiscovery | null }
    | { error: unknown };

  const controller = new AbortController();
  const totalTimer = setTimeout(() => controller.abort(), limits.totalBudgetMs);
  const deadline = Date.now() + limits.totalBudgetMs;
  try {
    const listResults = await runPool(jobs, limits.concurrency, async (provider): Promise<ListResult> => {
      try {
        const response = await fetchProvider(provider, '/models', fetcher, controller.signal, limits);
        if (response.status === 404 || response.status === 405) return { provider, fallback: true };
        if (!response.ok) throw upstreamValidationError(provider, response.status);
        const body = await readJsonBounded(response, limits.responseBodyBytes, controller.signal, deadline);
        const ids = extractModelIds(body);
        const limitsById = extractModelLimits(body);
        const enabledModels = provider.models.filter(model => model.enabled && model.model);
        const missing = enabledModels.find(model => !ids.has(model.model));
        if (missing) {
          throw new AiConfigValidationError(
            `Model ${missing.model} is unavailable at provider ${provider.name}.`,
            'model-unavailable',
            { model: missing.model, name: provider.name },
          );
        }
        const discoveries: AiModelLimitDiscovery[] = [];
        for (const model of enabledModels) {
          const discovered = limitsById.get(model.model);
          if (!discovered) continue;
          discoveries.push({ providerName: provider.name, model: model.model, ...discovered });
        }
        return { provider, discoveries };
      } catch (error) {
        return { provider, error };
      }
    });
    const errors: unknown[] = [];
    const discoveries: AiModelLimitDiscovery[] = [];
    const fallbackModels: Array<{ provider: AiProviderConfig; model: AiModelConfig }> = [];
    for (const result of listResults) {
      if ('error' in result) errors.push(result.error);
      else if ('fallback' in result) {
        for (const model of result.provider.models) {
          if (model.enabled && model.model) fallbackModels.push({ provider: result.provider, model });
        }
      } else {
        discoveries.push(...result.discoveries);
      }
    }

    if (fallbackModels.length > 0) {
      const fallbackResults = await runPool(fallbackModels, limits.concurrency, async (item): Promise<FallbackResult> => {
        try {
          const response = await fetchProvider(
            item.provider,
            `/models/${encodeURIComponent(item.model.model)}`,
            fetcher,
            controller.signal,
            limits,
          );
          if (!response.ok) throw upstreamValidationError(item.provider, response.status, item.model.model);
          const body = await readJsonBounded(response, limits.responseBodyBytes, controller.signal, deadline);
          const returnedId = extractSingleModelId(body);
          if (returnedId !== item.model.model) {
            throw new AiConfigValidationError(
              `Provider ${item.provider.name} did not confirm model ${item.model.model}`
              + (returnedId ? ` (returned ${returnedId}).` : '.'),
            );
          }
          const discovered = extractSingleModelLimits(body, item.model.model);
          return {
            discovery: discovered
              ? { providerName: item.provider.name, model: item.model.model, ...discovered }
              : null,
          };
        } catch (error) {
          return { error };
        }
      });
      for (const result of fallbackResults) {
        if ('error' in result) errors.push(result.error);
        else if (result.discovery) discoveries.push(result.discovery);
      }
    }

    if (controller.signal.aborted && errors.length === 0) {
      errors.push(new AiConfigValidationError('Upstream model validation timed out.', 'validation-timeout'));
    }
    if (errors.length > 0) {
      const error = errors[0];
      if (error instanceof AiConfigValidationError) throw error;
      throw new AiConfigValidationError(error instanceof Error ? error.message : 'Upstream model validation failed.', 'validation-failed');
    }
    return discoveries;
  } finally {
    clearTimeout(totalTimer);
  }
}

async function fetchProvider(
  provider: AiProviderConfig,
  suffix: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
  limits: AiValidationLimits,
): Promise<Response> {
  const baseUrl = normalizeBaseUrl(provider.baseUrl);
  if (!baseUrl) throw new AiConfigValidationError(`Provider ${provider.name} has an invalid base URL.`);
  const controller = new AbortController();
  let rejectTimeout: (reason?: unknown) => void = () => {};
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout(new AiConfigValidationError(`Provider ${provider.name} validation timed out.`));
  }, limits.requestTimeoutMs);
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const headers = new Headers({ Accept: 'application/json' });
    if (provider.apiKey) headers.set('Authorization', `Bearer ${provider.apiKey}`);
    return await Promise.race([
      fetcher(buildProviderEndpoint(baseUrl, suffix), {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      }),
      timeout,
    ]);
  } catch (error) {
    if (controller.signal.aborted || signal.aborted) {
      throw new AiConfigValidationError(`Provider ${provider.name} validation timed out.`);
    }
    throw new AiConfigValidationError(error instanceof Error ? `Provider ${provider.name}: ${error.message}` : `Provider ${provider.name} validation failed.`);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

async function readJsonBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  deadline: number,
): Promise<unknown> {
  const bytes = await readBoundedBytes(response.body, {
    maxBytes,
    signal,
    deadline,
    declaredLength: response.headers.get('content-length'),
    tooLarge: () => new AiConfigValidationError('Upstream response body is too large.'),
    onTimeout: () => new AiConfigValidationError('Upstream model validation timed out.'),
  });
  if (!bytes) return null;
  const text = new TextDecoder().decode(bytes);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new AiConfigValidationError('Upstream returned malformed JSON.');
  }
}

function extractModelIds(body: unknown): Set<string> {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new AiConfigValidationError('Upstream /models response must contain a data array.');
  }
  return new Set(body.data.map(item => {
    if (typeof item === 'string') return item;
    return isRecord(item) && typeof item.id === 'string' ? item.id : '';
  }).filter(Boolean));
}

function firstTokenLimit(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = parseTokenLimit(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * Read optional limit metadata from one model entry. The OpenAI contract does
 * not define these fields, so every shape is treated as best-effort.
 */
function readModelLimits(source: Record<string, unknown>): AiModelLimits | null {
  const topProvider = isRecord(source.top_provider) ? source.top_provider : {};
  const nestedLimits: Record<string, unknown> = isRecord(source.limits)
    ? source.limits
    : isRecord(source.metadata) && isRecord(source.metadata.limits)
      ? source.metadata.limits
      : {};
  const contextWindow = firstTokenLimit(
    source.context_length,
    source.context_window,
    source.max_context_length,
    topProvider.context_length,
    topProvider.context_window,
    nestedLimits.context_length,
    nestedLimits.context_window,
  );
  const maxOutputTokens = firstTokenLimit(
    source.max_completion_tokens,
    source.max_output_tokens,
    topProvider.max_completion_tokens,
    topProvider.max_output_tokens,
    nestedLimits.max_completion_tokens,
    nestedLimits.max_output_tokens,
    source.max_tokens,
    topProvider.max_tokens,
    nestedLimits.max_tokens,
  );
  if (contextWindow === undefined && maxOutputTokens === undefined) return null;
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

function extractModelLimits(body: unknown): Map<string, AiModelLimits> {
  const result = new Map<string, AiModelLimits>();
  if (!isRecord(body) || !Array.isArray(body.data)) return result;
  for (const item of body.data) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id) continue;
    const limits = readModelLimits(item);
    if (limits) result.set(item.id, limits);
  }
  return result;
}

function extractSingleModelLimits(body: unknown, model: string): AiModelLimits | null {
  if (!isRecord(body)) return null;
  const fromList = extractModelLimits(body).get(model);
  if (fromList) return fromList;
  if (isRecord(body.data)) return readModelLimits(body.data);
  return readModelLimits(body);
}

function upstreamValidationError(provider: AiProviderConfig, status: number, model?: string): AiConfigValidationError {
  const suffix = model ? ` for model ${model}` : '';
  return new AiConfigValidationError(`Provider ${provider.name} returned HTTP ${status}${suffix}.`);
}

async function runPool<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const count = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

function normalizeProvider(source: Record<string, unknown>): AiProviderConfig {
  const models = Array.isArray(source.models)
    ? source.models.filter(isRecord).map(normalizeModel).filter(model => model.model)
    : [];
  return {
    name: typeof source.name === 'string' ? source.name.trim() : '',
    baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl.trim().replace(/\/+$/, '') : '',
    apiKey: typeof source.apiKey === 'string' ? source.apiKey.trim() : '',
    models,
  };
}

function normalizeModel(source: Record<string, unknown>): AiModelConfig {
  const capabilityValues = Array.isArray(source.capabilities) ? source.capabilities : [AI_CAPABILITIES.chatGenerate];
  const modalityValues = Array.isArray(source.modalities) ? source.modalities : [AI_MODALITIES.text];
  const capabilities = [...new Set(capabilityValues.filter((value): value is AiCapability => (
    typeof value === 'string' && Object.values(AI_CAPABILITIES).includes(value as AiCapability)
  )))];
  const modalities = [...new Set(modalityValues.filter((value): value is AiModelModality => (
    typeof value === 'string' && Object.values(AI_MODALITIES).includes(value as AiModelModality)
  )))];
  const contextWindow = parseTokenLimit(source.contextWindow);
  const maxOutputTokens = parseTokenLimit(source.maxOutputTokens);
  return {
    model: typeof source.model === 'string' ? source.model.trim() : '',
    alias: typeof source.alias === 'string' ? source.alias.trim() : '',
    enabled: parseBoolean(source.enabled, true),
    capabilities,
    modalities,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  return fallback;
}

export function isValidHttpBasePath(path: string): boolean {
  if (
    !path.startsWith('/')
    || path.startsWith('//')
    || path.length > 128
    || path.includes('?')
    || path.includes('#')
    || path.includes('\\')
    || isReservedHttpBasePath(path)
  ) return false;
  try {
    const decoded = decodeURIComponent(path);
    return !decoded.split('/').some(segment => segment === '.' || segment === '..');
  } catch {
    return false;
  }
}

/** Paths already owned by the system route table cannot be plugin routes. */
export function isReservedHttpBasePath(path: string): boolean {
  const reserved = [
    '/admin', '/api', '/install', '/feed', '/contents', '/category', '/tag',
    '/author', '/search', '/usr', '/themes', '/css', '/js', '/img', '/vendor',
    '/plugin-assets', '/sitemap.xml', '/robots.txt',
  ];
  return reserved.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

function extractSingleModelId(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (typeof body.id === 'string') return body.id;
  if (isRecord(body.data) && typeof body.data.id === 'string') return body.data.id;
  return null;
}

function supportsIpv4PrivateRange(parts: number[]): boolean {
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

function isIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host.includes(':')) return true;
  const parts = host.split('.');
  return parts.length === 4 && parts.every(part => /^\d+$/.test(part) && Number(part) <= 255);
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const parts = host.split('.');
  if (parts.length === 4 && parts.every(part => /^\d+$/.test(part))) {
    return supportsIpv4PrivateRange(parts.map(Number));
  }
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.lan')
    || host === 'metadata.google.internal';
}

function randomIndex(length: number): number {
  if (length <= 1) return 0;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] % length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
