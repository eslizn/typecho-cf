import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('admin Queue page wiring', () => {
  it('exposes the Queue page only to administrators and adds it to Manage', () => {
    const page = read('src/pages/admin/manage-queues.astro');
    const layout = read('src/layouts/Admin.astro');

    expect(page).toContain("hasPermission(ctx.user!.group || 'visitor', 'administrator')");
    expect(page).toContain('getQueueDashboardSnapshot');
    expect(page).toContain('activeMenu="manage-queues"');
    expect(layout).toContain("t('admin.menu.queues'");
    expect(layout).toContain("href: '/admin/manage-queues'");
    expect(layout).toContain('show: isAdmin');
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
    const config = read('wrangler.toml');

    expect(config).toContain('QUEUE_NAME = "typecho-cf-tasks"');
    expect(config).toContain('binding = "QUEUE"');
    expect(config).not.toContain('QUEUE_DLQ_NAME');
    expect(config).not.toContain('dead_letter_queue');
    expect(config.match(/\[\[queues\.producers\]\]/g)).toHaveLength(1);
  });
});
