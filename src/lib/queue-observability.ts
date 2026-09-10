/**
 * Read-only observability helpers for the task Queue.
 *
 * Queue bindings expose realtime backlog metrics without any account API
 * credentials. Queue configuration is account-level data and is loaded only
 * when an operator supplies a read-scoped Cloudflare API token and account ID;
 * the task Queue metrics can come from the local binding.
 */

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const MAX_QUEUE_NAME_LENGTH = 255;
const MAX_RESOURCE_ID_LENGTH = 64;
const MAX_API_RESPONSE_BYTES = 1_000_000;
const MAX_API_LIST_PAGES = 10;
const API_TIMEOUT_MS = 4_000;

export const DEFAULT_TASK_QUEUE_NAME = 'typecho-cf-tasks';

export interface QueueMetricsBinding {
  metrics(): Promise<unknown>;
}

/** The subset of the Worker environment used by this read-only module. */
export interface QueueObservabilityEnv {
  QUEUE?: QueueMetricsBinding;
  QUEUE_NAME?: unknown;
  CF_ACCOUNT_ID?: unknown;
  CF_API_TOKEN?: unknown;
}

export interface QueueMetricsSnapshot {
  backlogCount: number | null;
  backlogBytes: number | null;
  oldestMessageTimestampMs: number | null;
}

export interface QueueSettingsSnapshot {
  deliveryDelaySeconds: number | null;
  deliveryPaused: boolean | null;
  retentionPeriodSeconds: number | null;
}

export interface QueueConsumerSnapshot {
  consumerId: string | null;
  type: 'worker' | 'http_pull' | 'unknown';
  queueName: string | null;
  scriptName: string | null;
  batchSize: number | null;
  maxConcurrency: number | 'automatic' | null;
  maxRetries: number | null;
  maxWaitTimeMs: number | null;
  retryDelaySeconds: number | null;
  visibilityTimeoutMs: number | null;
}

export interface QueueResourceSnapshot {
  key: 'main';
  name: string;
  queueId: string | null;
  metrics: QueueMetricsSnapshot | null;
  metricsSource: 'binding' | 'api' | 'unavailable';
  settings: QueueSettingsSnapshot | null;
  consumers: readonly QueueConsumerSnapshot[];
  apiResourceFound: boolean;
}

export interface QueueDashboardSnapshot {
  queues: readonly QueueResourceSnapshot[];
  api: {
    configured: boolean;
    available: boolean;
  };
  refreshedAt: number;
}

export interface QueueObservabilityDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

interface QueueApiConfig {
  accountId: string;
  token: string;
}

interface QueueApiClient {
  request(path: string, init?: RequestInit): Promise<unknown>;
}

interface QueueApiResource {
  queueId: string;
  queueName: string;
  settings: QueueSettingsSnapshot | null;
  consumers: readonly QueueConsumerSnapshot[];
}

interface RecordLike {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) return null;
  return normalized;
}

function queueName(value: unknown, fallback: string): string {
  const normalized = boundedString(value, MAX_QUEUE_NAME_LENGTH);
  return normalized && !/\s/.test(normalized) ? normalized : fallback;
}

function resourceId(value: unknown): string | null {
  const normalized = boundedString(value, MAX_RESOURCE_ID_LENGTH);
  return normalized && !/\s/.test(normalized) ? normalized : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = nonNegativeNumber(value);
  return number !== null && Number.isSafeInteger(number) ? number : null;
}

function readMetricTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
  }
  const timestamp = nonNegativeNumber(value);
  return timestamp !== null && timestamp > 0 ? timestamp : null;
}

/** Parse both the Workers binding camelCase shape and REST snake_case shape. */
export function parseQueueMetrics(value: unknown): QueueMetricsSnapshot | null {
  if (!isRecord(value)) return null;

  const backlogCount = nonNegativeInteger(value.backlogCount ?? value.backlog_count);
  const backlogBytes = nonNegativeInteger(value.backlogBytes ?? value.backlog_bytes);
  const oldestMessageTimestampMs = readMetricTimestamp(
    value.oldestMessageTimestamp ?? value.oldest_message_timestamp_ms,
  );

  if (backlogCount === null && backlogBytes === null && oldestMessageTimestampMs === null) {
    return null;
  }
  return { backlogCount, backlogBytes, oldestMessageTimestampMs };
}

function readOptionalNumber(record: RecordLike, key: string): number | null {
  return nonNegativeNumber(record[key]);
}

function readOptionalInteger(record: RecordLike, key: string): number | null {
  return nonNegativeInteger(record[key]);
}

function parseQueueSettings(value: unknown): QueueSettingsSnapshot | null {
  if (!isRecord(value)) return null;
  return {
    deliveryDelaySeconds: readOptionalNumber(value, 'delivery_delay'),
    deliveryPaused: typeof value.delivery_paused === 'boolean' ? value.delivery_paused : null,
    retentionPeriodSeconds: readOptionalNumber(value, 'message_retention_period'),
  };
}

function parseMaxConcurrency(record: RecordLike): number | 'automatic' | null {
  if (record.max_concurrency === null) return 'automatic';
  return readOptionalInteger(record, 'max_concurrency');
}

function parseConsumer(value: unknown): QueueConsumerSnapshot | null {
  if (!isRecord(value)) return null;
  const type = value.type === 'worker' || value.type === 'http_pull' ? value.type : 'unknown';
  const settings = isRecord(value.settings) ? value.settings : {};
  return {
    consumerId: resourceId(value.consumer_id),
    type,
    queueName: boundedString(value.queue_name, MAX_QUEUE_NAME_LENGTH),
    scriptName: boundedString(value.script_name, MAX_QUEUE_NAME_LENGTH),
    batchSize: readOptionalInteger(settings, 'batch_size'),
    maxConcurrency: parseMaxConcurrency(settings),
    maxRetries: readOptionalInteger(settings, 'max_retries'),
    maxWaitTimeMs: readOptionalNumber(settings, 'max_wait_time_ms'),
    retryDelaySeconds: readOptionalNumber(settings, 'retry_delay'),
    visibilityTimeoutMs: readOptionalNumber(settings, 'visibility_timeout_ms'),
  };
}

function parseConsumers(value: unknown): readonly QueueConsumerSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseConsumer)
    .filter((consumer): consumer is QueueConsumerSnapshot => consumer !== null);
}

function parseApiResource(value: unknown): QueueApiResource | null {
  if (!isRecord(value)) return null;
  const queueId = resourceId(value.queue_id);
  const queueName = boundedString(value.queue_name, MAX_QUEUE_NAME_LENGTH);
  if (!queueId || !queueName || /\s/.test(queueName)) return null;
  return {
    queueId,
    queueName,
    settings: parseQueueSettings(value.settings),
    consumers: parseConsumers(value.consumers),
  };
}

function parseApiResultArray(value: unknown): readonly unknown[] {
  if (!isRecord(value) || value.success !== true || !Array.isArray(value.result)) {
    throw new Error('Invalid Cloudflare Queue API response');
  }
  return value.result;
}

function parseApiResultObject(value: unknown): RecordLike {
  if (!isRecord(value) || value.success !== true || !isRecord(value.result)) {
    throw new Error('Invalid Cloudflare Queue API response');
  }
  return value.result;
}

function readTotalPages(value: unknown): number {
  if (!isRecord(value)) return 1;
  const totalPages = nonNegativeInteger(value.total_pages);
  return totalPages && totalPages > 0 ? totalPages : 1;
}

function readApiConfig(env: QueueObservabilityEnv): QueueApiConfig | null {
  const accountId = resourceId(env.CF_ACCOUNT_ID);
  const token = boundedString(env.CF_API_TOKEN, 512);
  if (!accountId || !token) return null;
  return { accountId, token };
}

function createApiClient(
  config: QueueApiConfig,
  dependencies: QueueObservabilityDependencies,
): QueueApiClient {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch is not available');
  }

  return {
    async request(path, init = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
      try {
        const headers = new Headers(init.headers);
        headers.set('Accept', 'application/json');
        headers.set('Authorization', `Bearer ${config.token}`);
        const response = await fetchImpl(
          `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(config.accountId)}${path}`,
          {
            ...init,
            redirect: 'error',
            signal: controller.signal,
            headers,
          },
        );
        const text = await readBoundedResponseText(response);
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error('Cloudflare Queue API returned invalid JSON');
        }
        if (!response.ok) throw new Error('Cloudflare Queue API request failed');
        return body;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > MAX_API_RESPONSE_BYTES) {
      throw new Error('Cloudflare Queue API response is too large');
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_API_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Cloudflare Queue API response is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function listApiResources(
  client: QueueApiClient,
  wantedNames: ReadonlySet<string>,
): Promise<readonly QueueApiResource[]> {
  const resources: QueueApiResource[] = [];
  const foundNames = new Set<string>();
  let page = 1;

  while (page <= MAX_API_LIST_PAGES && foundNames.size < wantedNames.size) {
    const response = await client.request(`/queues?per_page=100&page=${page}`);
    if (!isRecord(response)) throw new Error('Invalid Cloudflare Queue API response');
    const result = parseApiResultArray(response);
    for (const rawResource of result) {
      const resource = parseApiResource(rawResource);
      if (!resource || !wantedNames.has(resource.queueName) || foundNames.has(resource.queueName)) continue;
      foundNames.add(resource.queueName);
      resources.push(resource);
    }

    const resultInfo = isRecord(response.result_info) ? response.result_info : null;
    const totalPages = readTotalPages(resultInfo);
    if (result.length === 0 || page >= totalPages) break;
    page += 1;
  }
  return resources;
}

async function readApiMetrics(client: QueueApiClient, queueId: string): Promise<QueueMetricsSnapshot | null> {
  const response = await client.request(`/queues/${encodeURIComponent(queueId)}/metrics`);
  return parseQueueMetrics(parseApiResultObject(response));
}

async function readBindingMetrics(binding: QueueMetricsBinding | undefined): Promise<QueueMetricsSnapshot | null> {
  if (!binding || typeof binding.metrics !== 'function') return null;
  try {
    return parseQueueMetrics(await binding.metrics());
  } catch {
    return null;
  }
}

function createResource(name: string): QueueResourceSnapshot {
  return {
    key: 'main',
    name,
    queueId: null,
    metrics: null,
    metricsSource: 'unavailable',
    settings: null,
    consumers: [],
    apiResourceFound: false,
  };
}

/**
 * Load a bounded, read-only snapshot for the admin Queue page.
 *
 * A failed optional Cloudflare API call is intentionally converted into an
 * unavailable state. The page must remain usable with the binding metric even
 * when an operator has not configured account-level API credentials.
 */
export async function getQueueDashboardSnapshot(
  env: QueueObservabilityEnv,
  dependencies: QueueObservabilityDependencies = {},
): Promise<QueueDashboardSnapshot> {
  const mainName = queueName(env.QUEUE_NAME, DEFAULT_TASK_QUEUE_NAME);
  const queues = [createResource(mainName)];

  const bindingMetrics = await readBindingMetrics(env.QUEUE);
  if (bindingMetrics) {
    queues[0] = {
      ...queues[0],
      metrics: bindingMetrics,
      metricsSource: 'binding',
    };
  }
  const apiConfig = readApiConfig(env);
  if (!apiConfig) {
    return {
      queues,
      api: { configured: false, available: false },
      refreshedAt: dependencies.now?.() ?? Date.now(),
    };
  }

  try {
    const client = createApiClient(apiConfig, dependencies);
    const apiResources = await listApiResources(client, new Set([mainName]));
    const apiByName = new Map(apiResources.map(resource => [resource.queueName, resource]));
    const enrichedQueues = await Promise.all(queues.map(async queue => {
      const apiResource = apiByName.get(queue.name);
      if (!apiResource) return queue;

      let metrics = queue.metrics;
      let metricsSource = queue.metricsSource;
      if (!metrics) {
        try {
          const apiMetrics = await readApiMetrics(client, apiResource.queueId);
          if (apiMetrics) {
            metrics = apiMetrics;
            metricsSource = 'api';
          }
        } catch {
          // Keep the binding metric or unavailable state when the optional
          // account-level metric request fails.
        }
      }

      return {
        ...queue,
        queueId: apiResource.queueId,
        metrics,
        metricsSource,
        settings: apiResource.settings,
        consumers: apiResource.consumers,
        apiResourceFound: true,
      } satisfies QueueResourceSnapshot;
    }));

    return {
      queues: enrichedQueues,
      api: { configured: true, available: true },
      refreshedAt: dependencies.now?.() ?? Date.now(),
    };
  } catch {
    return {
      queues,
      api: { configured: true, available: false },
      refreshedAt: dependencies.now?.() ?? Date.now(),
    };
  }
}
