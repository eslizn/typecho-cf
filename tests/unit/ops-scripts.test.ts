import { describe, expect, it } from 'vitest';
import { OPS_COMMANDS, formatHelp, resolveOpsCommand } from '../../scripts/ops.mjs';

describe('ops command dispatcher', () => {
  it('resolves grouped commands and forwards remaining arguments', () => {
    expect(resolveOpsCommand(['db', 'migrate', '--target', 'cloudflare', '--dry-run'])).toEqual({
      kind: 'command',
      key: 'db migrate',
      args: ['--target', 'cloudflare', '--dry-run'],
    });
    expect(resolveOpsCommand(['user', 'reset-password', '--user', 'admin'])).toEqual({
      kind: 'command',
      key: 'user reset-password',
      args: ['--user', 'admin'],
    });
  });

  it('accepts a leading -- separator from pnpm', () => {
    expect(resolveOpsCommand(['--', 'db', 'generate'])).toEqual({
      kind: 'command',
      key: 'db generate',
      args: [],
    });
  });

  it('shows help when invoked without a command or with --help', () => {
    expect(resolveOpsCommand([])).toEqual({ kind: 'help' });
    expect(resolveOpsCommand(['--help'])).toEqual({ kind: 'help' });
    expect(formatHelp()).toContain('pnpm run ops db migrate');
  });

  it('rejects unknown commands', () => {
    expect(() => resolveOpsCommand(['db', 'drop'])).toThrow(/Unknown ops command/);
  });

  it('only exposes commands that need human judgment', () => {
    expect(Object.keys(OPS_COMMANDS)).toEqual([
      'db generate',
      'db studio',
      'db migrate',
      'user reset-password',
    ]);
    expect(OPS_COMMANDS['db generate'].args).toEqual(['exec', 'drizzle-kit', 'generate']);
    expect(OPS_COMMANDS['db studio'].args).toEqual(['exec', 'drizzle-kit', 'studio']);
    expect(OPS_COMMANDS['db migrate'].args).toEqual(['exec', 'tsx', 'scripts/migrate.ts']);
    expect(OPS_COMMANDS['user reset-password'].args).toEqual([
      'exec',
      'tsx',
      'scripts/reset-password.ts',
    ]);
  });
});
