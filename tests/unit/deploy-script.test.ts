import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import {
  deploy,
  effectiveRoot,
  isDryRun,
  isWorkersBuild,
} from '../../scripts/deploy.mjs';

type DeployOptions = NonNullable<Parameters<typeof deploy>[1]>;
type EnsureQueuesFunction = NonNullable<DeployOptions['ensureQueuesFn']>;
type WranglerFunction = NonNullable<DeployOptions['runWranglerFn']>;

function commandResult(status: number) {
  return {
    status,
    signal: null,
    error: undefined,
    stdout: '',
    stderr: '',
  };
}

describe('deployment wrapper', () => {
  it.each([
    [['--dry-run'], true],
    [['--dry-run=true'], true],
    [['--dry-run', 'true'], true],
    [['--dry-run=false'], false],
    [['--dry-run', 'false'], false],
    [['--no-dry-run'], false],
  ])('parses dry-run value %j', (argv, expected) => {
    expect(isDryRun(argv)).toBe(expected);
  });

  it.each([
    [{ WORKERS_CI: '1' }, true],
    [{ WORKERS_CI: '0' }, false],
    [{}, false],
  ])('detects Workers Builds from WORKERS_CI: %j', (env, expected) => {
    expect(isWorkersBuild(env)).toBe(expected);
  });

  it('resolves a relative --cwd against the repository root', () => {
    expect(effectiveRoot(['--cwd', 'apps/site'], 'C:\\workspace'))
      .toBe(resolve('C:\\workspace', 'apps/site'));
    expect(effectiveRoot(['--cwd=/srv/typecho'], 'C:\\workspace'))
      .toBe(resolve('/srv/typecho'));
  });

  it('returns the build failure status and does not invoke Wrangler', async () => {
    const ensureQueues = vi.fn<EnsureQueuesFunction>(async () => ({
      queueNames: [],
      created: [],
      configPath: '',
      environment: undefined,
    }));
    const runBuild = vi.fn(() => 23);
    const runWrangler = vi.fn<WranglerFunction>(() => commandResult(0));

    await expect(deploy(['--dry-run'], {
      rootDir: process.cwd(),
      ensureQueuesFn: ensureQueues,
      runBuildFn: runBuild,
      runWranglerFn: runWrangler,
    })).resolves.toBe(23);

    expect(ensureQueues).not.toHaveBeenCalled();
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('applies --cwd once while provisioning and deploying', async () => {
    const rootDir = process.cwd();
    const argv = ['--cwd', 'apps/site'];
    const ensureQueues = vi.fn<EnsureQueuesFunction>(async () => ({
      queueNames: [],
      created: [],
      configPath: '',
      environment: undefined,
    }));
    const runBuild = vi.fn(() => 0);
    const runWrangler = vi.fn<WranglerFunction>(() => commandResult(0));

    await expect(deploy(argv, {
      rootDir,
      ensureQueuesFn: ensureQueues,
      runBuildFn: runBuild,
      runWranglerFn: runWrangler,
    })).resolves.toBe(0);

    expect(ensureQueues).toHaveBeenCalledWith({ rootDir, argv });
    expect(runBuild).toHaveBeenCalledWith(resolve(rootDir, 'apps/site'));
    expect(runWrangler).toHaveBeenCalledWith(
      ['deploy', '--cwd', 'apps/site'],
      { cwd: rootDir, capture: false },
    );
  });

  it('skips local preflight and build when invoked by Workers Builds', async () => {
    const rootDir = process.cwd();
    const ensureQueues = vi.fn<EnsureQueuesFunction>(async () => ({
      queueNames: [],
      created: [],
      configPath: '',
      environment: undefined,
    }));
    const runBuild = vi.fn(() => 23);
    const runWrangler = vi.fn<WranglerFunction>(() => commandResult(0));

    await expect(deploy([], {
      rootDir,
      ensureQueuesFn: ensureQueues,
      runBuildFn: runBuild,
      runWranglerFn: runWrangler,
      workersBuild: true,
    })).resolves.toBe(0);

    expect(ensureQueues).not.toHaveBeenCalled();
    expect(runBuild).not.toHaveBeenCalled();
    expect(runWrangler).toHaveBeenCalledWith(
      ['deploy'],
      { cwd: rootDir, capture: false },
    );
  });
});
