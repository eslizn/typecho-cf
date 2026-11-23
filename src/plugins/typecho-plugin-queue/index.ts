import {
  TASK_QUEUE_CAPABILITY,
  TASK_QUEUE_CAPABILITY_VERSION,
  type PluginInitContext,
  type TaskEnvelope,
  type TaskQueueProvider,
} from 'typecho/plugin-sdk';
import {
  MAX_QUEUE_BATCH_BYTES,
  MAX_QUEUE_BATCH_SIZE,
  MAX_QUEUE_DELAY_SECONDS,
  readCloudflareTaskQueueBinding,
} from './binding';
import { readQueueProviderConfig } from './config';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';
import { getQueueDashboardSnapshot } from './observability';

// Reserve space for the transport metadata Cloudflare adds to the batch.
const QUEUE_BATCH_OVERHEAD_BYTES = 1024;
const encoder = new TextEncoder();

export function createCloudflareTaskQueue(
  env: Readonly<Record<string, unknown>>,
  configValue: unknown,
): TaskQueueProvider {
  const binding = readCloudflareTaskQueueBinding(env.QUEUE);
  const config = readQueueProviderConfig(configValue);
  const metricsBinding = typeof binding?.metrics === 'function'
    ? { metrics: binding.metrics.bind(binding) }
    : undefined;

  return {
    isAvailable: binding !== undefined,
    async send(envelope, delaySeconds) {
      if (!binding) throw new Error('Cloudflare task Queue binding is unavailable');
      const options: QueueSendOptions = { contentType: 'json' };
      if (delaySeconds !== undefined) {
        if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_QUEUE_DELAY_SECONDS) {
          throw new RangeError(`delaySeconds must be an integer between 0 and ${MAX_QUEUE_DELAY_SECONDS}`);
        }
        options.delaySeconds = delaySeconds;
      }
      await binding.send(envelope, options);
    },
    async sendBatch(envelopes) {
      if (!binding) throw new Error('Cloudflare task Queue binding is unavailable');
      let batch: MessageSendRequest<TaskEnvelope>[] = [];
      let batchBytes = QUEUE_BATCH_OVERHEAD_BYTES;
      for (const envelope of envelopes) {
        const message = { body: envelope, contentType: 'json' } as const;
        const messageBytes = encoder.encode(JSON.stringify(message)).byteLength;
        if (messageBytes + QUEUE_BATCH_OVERHEAD_BYTES > MAX_QUEUE_BATCH_BYTES) {
          throw new RangeError('Task message exceeds the Cloudflare Queue batch byte limit');
        }
        if (batch.length === MAX_QUEUE_BATCH_SIZE || batchBytes + messageBytes > MAX_QUEUE_BATCH_BYTES) {
          await binding.sendBatch(batch);
          batch = [];
          batchBytes = QUEUE_BATCH_OVERHEAD_BYTES;
        }
        batch.push(message);
        batchBytes += messageBytes;
      }
      if (batch.length > 0) await binding.sendBatch(batch);
    },
    getDashboardSnapshot: () => getQueueDashboardSnapshot({
      QUEUE: metricsBinding,
      queueName: config.queueName,
      accountId: config.accountId,
      apiToken: config.apiToken,
    }),
  };
}

export default function init({ registerCapability, registerTranslations }: PluginInitContext): void {
  if (!registerCapability) {
    throw new Error('The Typecho runtime does not provide generic capability registration.');
  }
  registerTranslations?.('en', en);
  registerTranslations?.('zh-CN', zhCN);
  registerCapability<TaskQueueProvider>({
    capability: TASK_QUEUE_CAPABILITY,
    version: TASK_QUEUE_CAPABILITY_VERSION,
    scope: 'any',
    factory: ({ env, getOwnPluginConfig }) => (
      createCloudflareTaskQueue(env, getOwnPluginConfig())
    ),
  });
}
