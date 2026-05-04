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
});
