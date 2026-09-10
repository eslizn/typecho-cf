import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('Workers configuration and static checks', () => {
  it('generates Worker binding declarations from the committed Wrangler config', () => {
    const config = read('wrangler.toml');
    const appEnv = read('src/env.d.ts');
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const ci = read('.github/workflows/ci.yml');
    expect(config).toContain('binding = "BUCKET"');
    expect(config).toContain('binding = "DB"');
    expect(config).toContain('queue = "typecho-cf-tasks"');
    expect(config).not.toContain('dead_letter_queue');
    expect(config).not.toContain('typecho-cf-tasks-dlq');
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

  it('enables persisted searchable logs and sampled traces in wrangler.toml', () => {
    const config = read('wrangler.toml');
    expect(config).toContain('[observability.logs]');
    expect(config).toContain('head_sampling_rate = 1');
    expect(config).toContain('persist = true');
    expect(config).toContain('[observability.traces]');
    expect(config).toContain('head_sampling_rate = 0.01');
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
