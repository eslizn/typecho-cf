import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('admin Queue page wiring', () => {
  it('exposes the Queue page only to administrators', () => {
    const page = read('src/pages/admin/manage-queues.astro');

    expect(page).toContain("hasPermission(ctx.user!.group || 'visitor', 'administrator')");
    expect(page).toContain('getQueueDashboardSnapshot');
    expect(page).toContain('activeMenu="manage-queues"');
    // The nav entry and its administrator-only visibility are asserted against
    // the rendered layout in tests/astro/admin-layout.test.ts.
  });

  it('keeps the first version read-only and does not expose message mutation controls', () => {
    const page = read('src/pages/admin/manage-queues.astro');
    const observability = read('src/lib/queue-observability.ts');

    expect(page).not.toMatch(/\/api\/admin\/.*queue/i);
    expect(observability).not.toContain('/messages/pull');
    expect(observability).not.toContain('/messages/peek');
    expect(observability).not.toContain('/purge');
    expect(page).not.toContain('deadLetterQueue');
    expect(observability).not.toContain('DLQ');
    expect(page).toContain('queue-card');
    expect(page).toContain('queue-metrics');
    expect(page).toContain('queue-consumer-table');
  });

  it('keeps the single Queue aligned with the Wrangler resource', () => {
    const { rawConfig: config } = experimental_readRawConfig({ config: join(process.cwd(), 'wrangler.jsonc') });

    expect(config.vars?.QUEUE_NAME).toBe('typecho-cf-tasks');
    expect(config.vars).not.toHaveProperty('QUEUE_DLQ_NAME');
    expect(config.queues?.producers).toEqual([{ binding: 'QUEUE', queue: config.vars?.QUEUE_NAME }]);
    expect(config.queues?.consumers).toHaveLength(1);
    expect(config.queues?.consumers?.[0]?.queue).toBe(config.vars?.QUEUE_NAME);
    expect(config.queues?.consumers?.[0]).not.toHaveProperty('dead_letter_queue');
  });
});
