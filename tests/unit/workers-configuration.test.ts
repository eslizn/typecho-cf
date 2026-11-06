import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const { rawConfig: config } = experimental_readRawConfig({ config: join(process.cwd(), 'wrangler.jsonc') });

describe('Workers configuration and static checks', () => {
  it('generates Worker binding declarations from the committed Wrangler config', () => {
    const appEnv = read('src/env.d.ts');
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const ci = read('.github/workflows/ci.yml');
    expect(config.r2_buckets).toEqual([{ binding: 'BUCKET', bucket_name: 'typecho-cf-uploads' }]);
    expect(config.d1_databases).toEqual([{ binding: 'DB', database_name: 'typecho-cf-db', migrations_dir: 'drizzle' }]);
    expect(config.queues?.producers).toEqual([{ binding: 'QUEUE', queue: 'typecho-cf-tasks' }]);
    expect(config.queues?.consumers?.[0]).not.toHaveProperty('dead_letter_queue');
    expect(pkg.scripts['types:workers']).toContain('scripts/generate-worker-types.mjs');
    expect(pkg.scripts.typecheck).toContain('pnpm run types:workers');
    expect(pkg.scripts.typecheck).toContain('tsc --noEmit');
    expect(ci).toContain('pnpm run typecheck');
    expect(read('.gitignore')).toContain('worker-configuration.d.ts');
    expect(read('README.md')).toContain('`pnpm run typecheck`');
    expect(read('README.md')).not.toContain('提交更新后的 `worker-configuration.d.ts`');
    expect(appEnv).not.toContain('interface CloudflareEnv');
    expect(appEnv).not.toContain('interface D1Database');
    expect(appEnv).not.toContain('interface R2Bucket');
  });

  it('preserves Worker runtime, scheduled tasks and consumer settings in wrangler.jsonc', () => {
    expect(config.main).toBe('./src/worker.ts');
    expect(config.compatibility_date).toBe('2026-08-02');
    expect(config.compatibility_flags).toEqual(['nodejs_compat']);
    expect(config.assets).toEqual({ directory: 'dist', binding: 'ASSETS' });
    expect(config.triggers?.crons).toEqual(['* * * * *']);
    expect(config.queues?.consumers).toEqual([{
      queue: 'typecho-cf-tasks',
      max_batch_size: 100,
      max_batch_timeout: 5,
      max_retries: 3,
      max_concurrency: 1,
    }]);
  });

  it('enables persisted searchable logs and sampled traces in wrangler.jsonc', () => {
    expect(config.observability).toEqual({
      enabled: true,
      logs: { enabled: true, invocation_logs: false, head_sampling_rate: 1, persist: true },
      traces: { enabled: true, head_sampling_rate: 0.01, persist: true },
    });
  });

  it('provides repeatable generated-type and floating-Promise checks', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const eslint = read('eslint.config.mjs');
    const generator = read('scripts/generate-worker-types.mjs');
    expect(generator).toContain("['types', 'worker-configuration.d.ts'");
    expect(pkg.scripts.lint).toContain('eslint');
    expect(eslint).toContain("'@typescript-eslint/no-floating-promises': 'error'");
    expect(eslint).toContain("'worker-configuration.d.ts'");
  });
});
