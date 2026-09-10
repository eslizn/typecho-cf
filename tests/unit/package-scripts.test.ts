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

  it('provisions task queues before the one-command deployment flow', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    expect(pkg.scripts['queues:ensure']).toBe('node scripts/ensure-queues.mjs');
    expect(pkg.scripts['queues:cleanup-legacy']).toBe('node scripts/cleanup-legacy-queue.mjs');
    expect(pkg.scripts.deploy).toBe('node scripts/deploy.mjs');
  });
});
