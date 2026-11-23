import { cloudflareTaskQueueName } from './binding';

/** Plugin-owned Queue settings; no Worker environment fallbacks. */
export interface QueueProviderConfig {
  /** Name shown on the admin Queue page and used for drift warnings. */
  queueName: string;
  /** Optional Cloudflare account id for the read-only account API. */
  accountId: string;
  /** Optional read-only (Queues Read) API token. */
  apiToken: string;
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : '';
}

/** Normalize plugin configuration saved in `typecho_options` (`plugin:<id>`). */
export function readQueueProviderConfig(value: unknown): QueueProviderConfig {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    queueName: cloudflareTaskQueueName(record.queueName),
    accountId: boundedString(record.accountId, 64),
    apiToken: boundedString(record.apiToken, 512),
  };
}
