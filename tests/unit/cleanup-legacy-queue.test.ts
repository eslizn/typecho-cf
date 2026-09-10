import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cleanupLegacyQueue,
  hasLegacyTaskDlqReference,
  LEGACY_TASK_DLQ_NAME,
} from '../../scripts/cleanup-legacy-queue.mjs';

const queueTable = (name: string) => `
┌────┬────────────────────────────┬────────────┐
│ id │ name                       │ consumers  │
├────┼────────────────────────────┼────────────┤
│ 1  │ ${name.padEnd(26)} │ 1          │
└────┴────────────────────────────┴────────────┘
`;

const commandResult = (status: number, stdout = '') => ({
  status,
  signal: null,
  error: undefined,
  stdout,
  stderr: '',
});

describe('legacy Queue cleanup helper', () => {
  it('requires the exact legacy Queue name before deleting', async () => {
    const runner = vi.fn();

    await expect(cleanupLegacyQueue({
      rootDir: process.cwd(),
      runner,
      logger: { log: vi.fn() } as unknown as Console,
    })).rejects.toThrow(`--confirm ${LEGACY_TASK_DLQ_NAME}`);
    expect(runner).not.toHaveBeenCalled();
  });

  it('supports a read-only dry run without confirmation or delete', async () => {
    const runner = vi.fn((args: string[]) => {
      if (args[1] === 'list') {
        return commandResult(0, args.at(-1) === '1' ? queueTable(LEGACY_TASK_DLQ_NAME) : '');
      }
      return commandResult(0);
    });

    await expect(cleanupLegacyQueue({
      rootDir: process.cwd(),
      argv: ['--dry-run'],
      runner,
      logger: { log: vi.fn() } as unknown as Console,
    })).resolves.toMatchObject({
      queueName: LEGACY_TASK_DLQ_NAME,
      exists: true,
      deleted: false,
      dryRun: true,
    });
    expect(runner.mock.calls.some(([args]) => args[1] === 'delete')).toBe(false);
  });

  it('deletes only the known legacy Queue after exact confirmation', async () => {
    const runner = vi.fn((args: string[]) => {
      if (args[1] === 'list') {
        return commandResult(0, args.at(-1) === '1' ? queueTable(LEGACY_TASK_DLQ_NAME) : '');
      }
      if (args[1] === 'delete') return commandResult(0);
      return commandResult(1);
    });

    await expect(cleanupLegacyQueue({
      rootDir: process.cwd(),
      argv: ['--confirm', LEGACY_TASK_DLQ_NAME],
      runner,
      logger: { log: vi.fn() } as unknown as Console,
    })).resolves.toMatchObject({
      queueName: LEGACY_TASK_DLQ_NAME,
      exists: true,
      deleted: true,
    });
    expect(runner).toHaveBeenLastCalledWith(
      ['queues', 'delete', LEGACY_TASK_DLQ_NAME],
      { cwd: process.cwd(), capture: false },
    );
  });

  it('detects a legacy reference before allowing cleanup', () => {
    expect(hasLegacyTaskDlqReference(`
[[queues.consumers]]
dead_letter_queue = "${LEGACY_TASK_DLQ_NAME}"
`)).toBe(true);
    expect(hasLegacyTaskDlqReference('[[queues.producers]]\nqueue = "typecho-cf-tasks"')).toBe(false);
  });

  it('refuses to delete when the selected config still references the legacy Queue', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'typecho-cf-queue-cleanup-'));
    try {
      writeFileSync(join(tempRoot, 'wrangler.toml'), `
[[queues.producers]]
queue = "typecho-cf-tasks"

[[queues.consumers]]
queue = "typecho-cf-tasks"
dead_letter_queue = "${LEGACY_TASK_DLQ_NAME}"
`);
      const runner = vi.fn();

      await expect(cleanupLegacyQueue({
        rootDir: tempRoot,
        argv: ['--config', 'wrangler.toml', '--confirm', LEGACY_TASK_DLQ_NAME],
        runner,
        logger: { log: vi.fn() } as unknown as Console,
      })).rejects.toThrow('still references it');
      expect(runner).not.toHaveBeenCalled();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
