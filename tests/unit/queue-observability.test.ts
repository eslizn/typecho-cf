import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TASK_QUEUE_NAME,
  getQueueDashboardSnapshot,
  parseQueueMetrics,
} from '@/lib/queue-observability';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('queue observability', () => {
  it('uses the Worker Queue binding for realtime metrics without API credentials', async () => {
    const metrics = vi.fn(async () => ({
      backlogCount: 3,
      backlogBytes: 512,
      oldestMessageTimestamp: new Date('2026-09-10T00:00:00.000Z'),
    }));
    const snapshot = await getQueueDashboardSnapshot({ QUEUE: { metrics } }, { now: () => 123 });

    expect(metrics).toHaveBeenCalledTimes(1);
    expect(snapshot.api).toEqual({ configured: false, available: false });
    expect(snapshot.refreshedAt).toBe(123);
    expect(snapshot.queues).toHaveLength(1);
    expect(snapshot.queues[0]).toMatchObject({
      name: DEFAULT_TASK_QUEUE_NAME,
      metrics: {
        backlogCount: 3,
        backlogBytes: 512,
        oldestMessageTimestampMs: Date.parse('2026-09-10T00:00:00.000Z'),
      },
      metricsSource: 'binding',
    });
  });

  it('loads account-level queue configuration and metrics with a read-only API client', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/queues?per_page=100&page=1')) {
        return jsonResponse({
          success: true,
          result: [
            {
              queue_id: 'queue-main',
              queue_name: 'main-queue',
              settings: { delivery_delay: 0, delivery_paused: false, message_retention_period: 86400 },
              consumers: [{
                consumer_id: 'consumer-1',
                type: 'worker',
                queue_name: 'main-queue',
                script_name: 'typecho-cf',
                settings: {
                  batch_size: 100,
                  max_concurrency: 1,
                  max_retries: 3,
                  max_wait_time_ms: 5000,
                  retry_delay: 10,
                },
              }],
            },
          ],
          result_info: { total_pages: 1 },
        });
      }
      if (url.endsWith('/queues/queue-main/metrics')) {
        return jsonResponse({
          success: true,
          result: {
            backlog_count: 2,
            backlog_bytes: 128,
            oldest_message_timestamp_ms: 1_700_000_000_000,
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const snapshot = await getQueueDashboardSnapshot({
      QUEUE_NAME: 'main-queue',
      CF_ACCOUNT_ID: 'account-id',
      CF_API_TOKEN: 'read-only-token',
    }, { fetch, now: () => 456 });

    expect(snapshot.api).toEqual({ configured: true, available: true });
    expect(snapshot.queues).toHaveLength(1);
    expect(snapshot.queues[0]).toMatchObject({
      queueId: 'queue-main',
      metricsSource: 'api',
      metrics: { backlogCount: 2, backlogBytes: 128 },
      settings: { deliveryPaused: false },
      consumers: [{
        consumerId: 'consumer-1',
        type: 'worker',
        scriptName: 'typecho-cf',
        batchSize: 100,
        maxConcurrency: 1,
        maxRetries: 3,
      }],
      apiResourceFound: true,
    });
    expect(snapshot.refreshedAt).toBe(456);
    expect(fetch).toHaveBeenCalledTimes(2);
    const authorizationHeaders = fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'));
    expect(authorizationHeaders).toEqual(['Bearer read-only-token', 'Bearer read-only-token']);
  });

  it('degrades safely when the optional API fails and does not expose API error details', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      success: false,
      errors: [{ message: 'account secret should not be rendered' }],
    }, 403));

    const snapshot = await getQueueDashboardSnapshot({
      QUEUE: { metrics: vi.fn(async () => ({ backlogCount: 1, backlogBytes: 64 })) },
      CF_ACCOUNT_ID: 'account-id',
      CF_API_TOKEN: 'token',
    }, { fetch });

    expect(snapshot.api).toEqual({ configured: true, available: false });
    expect(snapshot.queues[0].metricsSource).toBe('binding');
    expect(JSON.stringify(snapshot)).not.toContain('account secret');
  });

  it('rejects malformed and negative metric values instead of displaying them as real data', () => {
    expect(parseQueueMetrics({ backlog_count: -1, backlog_bytes: '100' })).toBeNull();
    expect(parseQueueMetrics({ backlogCount: 0, backlogBytes: 0, oldestMessageTimestampMs: 0 })).toEqual({
      backlogCount: 0,
      backlogBytes: 0,
      oldestMessageTimestampMs: null,
    });
  });

  it('bounds an oversized account API response before parsing it', async () => {
    const fetch = vi.fn(async () => new Response('x'.repeat(1_000_001), { status: 200 }));

    const snapshot = await getQueueDashboardSnapshot({
      CF_ACCOUNT_ID: 'account-id',
      CF_API_TOKEN: 'token',
    }, { fetch });

    expect(snapshot.api).toEqual({ configured: true, available: false });
  });
});
