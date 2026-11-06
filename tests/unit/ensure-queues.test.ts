import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const fixtureDirectories: string[] = [];

function createConfigFixture(files: Record<string, string>) {
  const rootDir = mkdtempSync(join(tmpdir(), 'typecho-queue-config-'));
  fixtureDirectories.push(rootDir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(rootDir, name), contents);
  }
  return rootDir;
}

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ensure queues deployment helper', () => {
  it('extracts only Queue names and ignores legacy DLQ declarations', () => {
    const config = {
      queues: {
        producers: [{ binding: 'QUEUE', queue: 'task-queue' }],
        consumers: [{ queue: 'task-queue', dead_letter_queue: 'task-failures' }],
      },
    };

    expect(parseQueueNamesFromWranglerConfig(config)).toEqual([
      'task-queue',
    ]);
  });

  it('selects environment-specific queue declarations when present', () => {
    const config = {
      queues: { producers: [{ queue: 'task-queue' }] },
      env: {
        production: {
          queues: {
            producers: [{ queue: 'task-prod' }],
            consumers: [{ queue: 'task-prod', dead_letter_queue: 'task-prod-failures' }],
          },
        },
      },
    };

    expect(parseQueueNamesFromWranglerConfig(config, 'production')).toEqual([
      'task-prod',
    ]);
  });

  it('rejects a config that contains only a legacy DLQ declaration', () => {
    expect(() => parseQueueNamesFromWranglerConfig({
      queues: { consumers: [{ dead_letter_queue: 'task-failures' }] },
    })).toThrow('No Queue references found');
  });

  it('does not inherit top-level Queue bindings into a named environment', () => {
    const config = {
      queues: { producers: [{ queue: 'task-queue' }] },
      env: { production: { name: 'production-worker' } },
    };
    expect(() => parseQueueNamesFromWranglerConfig(config, 'production'))
      .toThrow("No Queue references found in the selected Wrangler config for environment 'production'");
    expect(() => parseQueueNamesFromWranglerConfig(config, 'missing'))
      .toThrow('No Queue references found');
  });

  it.each(['', 'task queue', 123, 'q'.repeat(256)])('rejects invalid Queue names (%j)', (queue) => {
    expect(() => parseQueueNamesFromWranglerConfig({
      queues: { producers: [{ queue }] },
    })).toThrow('Invalid Queue name');
  });

  it('parses JSONC comments, trailing commas and URL strings using Wrangler', async () => {
    const rootDir = createConfigFixture({
      'wrangler.jsonc': `{
        // Comments and URL literals must not confuse config parsing.
        "vars": { "SITE_URL": "https://example.com/blog/*" },
        "queues": {
          "producers": [{ "binding": "QUEUE", "queue": "jsonc-tasks", }],
          /* Consumers reference the same queue. */
          "consumers": [{ "queue": "jsonc-tasks" }],
        },
      }`,
    });
    const runner = vi.fn(() => commandResult(0));

    const result = await ensureQueues({ rootDir, runner, logger: { log: vi.fn() } as unknown as Console });

    expect(result.configPath).toBe(join(rootDir, 'wrangler.jsonc'));
    expect(result.queueNames).toEqual(['jsonc-tasks']);
    expect(runner).toHaveBeenCalledWith(['queues', 'create', 'jsonc-tasks'], { cwd: rootDir, capture: true });
  });

  it.each([
    ['wrangler.json', { 'wrangler.json': '{"queues":{"producers":[{"queue":"json-tasks"}]}}' }, 'json-tasks'],
    ['wrangler.jsonc', {}, 'jsonc-tasks'],
  ])('discovers %s before lower-priority config formats', async (expectedFile, extraFiles, expectedQueue) => {
    const rootDir = createConfigFixture({
      'wrangler.toml': '[[queues.producers]]\nqueue = "toml-tasks"',
      'wrangler.jsonc': '{"queues":{"producers":[{"queue":"jsonc-tasks"}]}}',
      ...extraFiles,
    });
    const result = await ensureQueues({
      rootDir,
      runner: vi.fn(() => commandResult(0)),
      logger: { log: vi.fn() } as unknown as Console,
    });
    expect(result.configPath).toBe(join(rootDir, expectedFile));
    expect(result.queueNames).toEqual([expectedQueue]);
  });

  it('discovers a TOML-only config from a child working directory', async () => {
    const rootDir = createConfigFixture({
      'wrangler.toml': '[[queues.producers]]\nqueue = "toml-tasks"',
    });
    mkdirSync(join(rootDir, 'child'));
    const result = await ensureQueues({
      rootDir,
      argv: ['--cwd', 'child'],
      runner: vi.fn(() => commandResult(0)),
      logger: { log: vi.fn() } as unknown as Console,
    });
    expect(result.configPath).toBe(join(rootDir, 'wrangler.toml'));
    expect(result.queueNames).toEqual(['toml-tasks']);
  });

  it('preserves an explicit TOML config and quoted environment names', async () => {
    const rootDir = createConfigFixture({
      'wrangler.jsonc': '{"queues":{"producers":[{"queue":"ignored-tasks"}]}}',
      'custom.toml': `[[queues.producers]]
queue = "ignored-default-tasks"
[[env."preview.deploy".queues.producers]]
queue = "preview-tasks"
[[env."preview.deploy".queues.consumers]]
queue = "preview-tasks"`,
    });
    const runner = vi.fn(() => commandResult(0));
    const args = ['--config', 'custom.toml', '--env', 'preview.deploy'];

    const result = await ensureQueues({ rootDir, argv: args, runner, logger: { log: vi.fn() } as unknown as Console });

    expect(result.configPath).toBe(join(rootDir, 'custom.toml'));
    expect(result.environment).toBe('preview.deploy');
    expect(result.queueNames).toEqual(['preview-tasks']);
    expect(runner).toHaveBeenCalledWith(['queues', 'list', ...args, '--page', '1'], { cwd: rootDir, capture: true });
  });

  it('fails before resource commands when a JSONC config is malformed', async () => {
    const rootDir = createConfigFixture({ 'wrangler.jsonc': '{"queues": invalid}' });
    const runner = vi.fn(() => commandResult(0));
    await expect(ensureQueues({ rootDir, runner })).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });

  it('fails before resource commands when --env has no Queue bindings', async () => {
    const rootDir = createConfigFixture({
      'wrangler.jsonc': '{"queues":{"producers":[{"queue":"default-tasks"}]},"env":{"production":{}}}',
    });
    const runner = vi.fn(() => commandResult(0));
    await expect(ensureQueues({ rootDir, argv: ['--env', 'production'], runner }))
      .rejects.toThrow("for environment 'production'");
    expect(runner).not.toHaveBeenCalled();
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

  it('preserves the actionable Wrangler authentication error when list fails', async () => {
    const runner = vi.fn(() => commandResult(
      1,
      '',
      '✘ [ERROR] Not logged in. Your auth token has expired and could not be refreshed, and the environment is non-interactive. Set CLOUDFLARE_API_TOKEN.',
    ));

    await expect(ensureQueues({
      rootDir: process.cwd(),
      runner,
      logger: { log: vi.fn() } as unknown as Console,
    })).rejects.toThrow(/Not logged in.*auth token has expired/i);
    expect(runner).toHaveBeenCalledOnce();
  });
});
