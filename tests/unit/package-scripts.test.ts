/**
 * Regression tests for package lifecycle scripts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('package scripts', () => {
  it('keeps build as a pure build command without installing dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    expect(pkg.scripts.build).toBe('astro build');
    expect(pkg.scripts.build).not.toContain('install');
  });

  it('composes the local deployment flow from explicit steps', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    expect(pkg.scripts.ops).toBe('node scripts/ops.mjs');
    expect(pkg.scripts.deploy).toBe(
      'node scripts/ensure-queues.mjs && pnpm run build && pnpm exec wrangler deploy',
    );
  });

  it('keeps dry-run and Workers Builds paths free of local preflight', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    expect(pkg.scripts['deploy:dry-run']).toBe(
      'pnpm run build && pnpm exec wrangler deploy --dry-run',
    );
    expect(pkg.scripts['deploy:ci']).toBe('pnpm exec wrangler deploy');
    expect(pkg.scripts['deploy:dry-run']).not.toContain('ensure-queues');
    expect(pkg.scripts['deploy:ci']).not.toContain('build');
  });

  it('keeps operational commands under ops instead of top-level scripts', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    for (const removed of [
      'queues:ensure',
      'reinstall:extensions',
      'types:workers',
      'db:generate',
      'db:studio',
      'db:migrate',
      'db:migrate:local',
      'db:migrate:cloudflare',
      'db:migrate:dry-run',
      'reset-password',
      'reset-password:cloudflare',
    ]) {
      expect(pkg.scripts[removed]).toBeUndefined();
    }
  });
});
