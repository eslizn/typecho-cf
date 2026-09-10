import { describe, expect, it, vi } from 'vitest';
import {
  ensureQueues,
  extractWranglerContext,
  parseQueueListOutput,
  parseQueueNamesFromWranglerConfig,
} from '../../scripts/ensure-queues.mjs';

const QUEUE_TABLE = `
┌────┬───────────────────────┬────────────────────┬────────────────────┬───────────┬────────────┐
│ id │ name                  │ created_on         │ modified_on        │ producers │ consumers  │
├────┼───────────────────────┼────────────────────┼────────────────────┼───────────┼────────────┤
│ 1  │ typecho-cf-tasks      │ 2026-09-10         │ 2026-09-10         │ 1         │ 1          │
└────┴───────────────────────┴────────────────────┴────────────────────┴───────────┴────────────┘
`;

const WRANGLER_EMPTY_QUEUE_OUTPUT = `
 ⛅️ wrangler 4.129.1 (update available 4.130.0)
───────────────────────────────────────────────
`;

const commandResult = (status: number, stdout = '', stderr = '') => ({
  status,
  signal: null,
  error: undefined,
  stdout,
  stderr,
});

describe('ensure queues deployment helper', () => {
  it('extracts only Queue names and ignores legacy DLQ declarations', () => {
    const config = `
[[queues.producers]]
binding = "QUEUE"
queue = "task-queue"

[[queues.consumers]]
queue = "task-queue"
dead_letter_queue = "task-failures"
`;

    expect(parseQueueNamesFromWranglerConfig(config)).toEqual([
      'task-queue',
    ]);
  });

  it('selects environment-specific queue declarations when present', () => {
    const config = `
[[queues.producers]]
queue = "task-queue"

[[queues.consumers]]
queue = "task-queue"
dead_letter_queue = "task-failures"

[[env.production.queues.producers]]
queue = "task-prod"

[[env.production.queues.consumers]]
queue = "task-prod"
dead_letter_queue = "task-prod-failures"
`;

    expect(parseQueueNamesFromWranglerConfig(config, 'production')).toEqual([
      'task-prod',
    ]);
  });

  it('rejects a config that contains only a legacy DLQ declaration', () => {
    expect(() => parseQueueNamesFromWranglerConfig(`
[[queues.consumers]]
dead_letter_queue = "task-failures"
`)).toThrow('No Queue references found');
  });

  it('parses the exact Queue name column instead of substring matching', () => {
    const parsed = parseQueueListOutput(`${QUEUE_TABLE}\nqueue-with-typecho-cf-tasks-suffix`);
    expect(parsed.recognized).toBe(true);
    expect(parsed.hasRows).toBe(true);
    expect(parsed.names).toEqual(new Set(['typecho-cf-tasks']));
  });

  it('treats Wrangler’s successful empty-list banner as an empty result', () => {
    expect(parseQueueListOutput(WRANGLER_EMPTY_QUEUE_OUTPUT)).toEqual({
      recognized: true,
      hasRows: false,
      names: new Set(),
    });
  });

  it('forwards only Wrangler global options to queue commands', () => {
    expect(extractWranglerContext([
      '--env',
      'production',
      '--config=wrangler.production.toml',
      '--cwd',
      'deploy-target',
      '--minify',
      '--profile',
      'deploy-profile',
    ])).toEqual({
      globalArgs: [
        '--env',
        'production',
        '--config=wrangler.production.toml',
        '--profile',
        'deploy-profile',
      ],
      configPath: 'wrangler.production.toml',
      environment: 'production',
      cwd: 'deploy-target',
    });
  });

  it('applies --cwd through the child process working directory only once', async () => {
    const calls: string[][] = [];
    const runner = vi.fn((args: string[], options: { cwd?: string; capture?: boolean } = {}) => {
      calls.push(args);
      expect(options.cwd).toBe(process.cwd());
      if (args[1] === 'list') {
        return commandResult(0, args.at(-1) === '1' ? QUEUE_TABLE : '');
      }
      return commandResult(0);
    });

    await ensureQueues({
      rootDir: process.cwd(),
      argv: ['--cwd', '.'],
      runner,
      logger: { log: vi.fn() } as unknown as Console,
    });

    expect(calls).toEqual([
      ['queues', 'list', '--page', '1'],
      ['queues', 'list', '--page', '2'],
    ]);
  });

  it('does not create an unconfigured Queue resource', async () => {
    const calls: string[][] = [];
    const logger = { log: vi.fn() };
    const runner = vi.fn((args: string[]) => {
      calls.push(args);
      if (args[1] === 'list') {
        return commandResult(0, args.at(-1) === '1' ? QUEUE_TABLE : '');
      }
      return commandResult(0);
    });

    const result = await ensureQueues({
      rootDir: process.cwd(),
      runner,
      logger: logger as unknown as Console,
    });

    expect(result.created).toEqual([]);
    expect(calls).toEqual([
      ['queues', 'list', '--page', '1'],
      ['queues', 'list', '--page', '2'],
    ]);
  });

  it('accepts a concurrent create when the retrying list sees the Queue', async () => {
    let listCalls = 0;
    const runner = vi.fn((args: string[]) => {
      if (args[1] === 'list') {
        listCalls += 1;
        if (listCalls === 2) return commandResult(0, QUEUE_TABLE);
        return commandResult(0);
      }
      if (args[2] === 'typecho-cf-tasks') return commandResult(1, '', 'already exists');
      return commandResult(1, '', 'already exists');
    });

    const result = await ensureQueues({
      rootDir: process.cwd(),
      runner,
      logger: { log: vi.fn() } as unknown as Console,
    });

    expect(result.created).toEqual([]);
    expect(listCalls).toBeGreaterThan(1);
  });

  it('fails closed when Queue creation fails and the Queue is still absent', async () => {
    const runner = vi.fn((args: string[]) => {
      if (args[1] === 'list') return commandResult(0);
      return commandResult(1, '', 'permission denied');
    });

    await expect(ensureQueues({
      rootDir: process.cwd(),
      runner,
      logger: { log: vi.fn() } as unknown as Console,
    })).rejects.toThrow("wrangler queues create failed for 'typecho-cf-tasks'");
  });
});
