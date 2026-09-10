/** Cloudflare Queue limits shared by producers, schedulers, and consumers. */
export const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60;

// Cloudflare documents the sendBatch aggregate limit as 256 KB (decimal).
export const MAX_QUEUE_BATCH_BYTES = 256_000;
