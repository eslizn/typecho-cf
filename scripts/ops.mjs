#!/usr/bin/env node
/**
 * Repository operations entry point.
 *
 * Keeps operational tooling out of the top-level package scripts. Each
 * subcommand delegates to an existing script or CLI; this file only maps
 * commands and forwards arguments.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const USE_SHELL = process.platform === 'win32';

export const OPS_COMMANDS = {
  'db generate': {
    command: PNPM,
    args: ['exec', 'drizzle-kit', 'generate'],
    shell: USE_SHELL,
    description: 'Generate Drizzle database migrations',
  },
  'db studio': {
    command: PNPM,
    args: ['exec', 'drizzle-kit', 'studio'],
    shell: USE_SHELL,
    description: 'Launch Drizzle Studio',
  },
  'db migrate': {
    command: PNPM,
    args: ['exec', 'tsx', 'scripts/migrate.ts'],
    shell: USE_SHELL,
    description: 'Migrate PHP Typecho data (--target local|cloudflare, --dry-run)',
  },
  'user reset-password': {
    command: PNPM,
    args: ['exec', 'tsx', 'scripts/reset-password.ts'],
    shell: USE_SHELL,
    description: 'Reset a user password (--target local|cloudflare)',
  },
};

export function resolveOpsCommand(argv = []) {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { kind: 'help' };
  }

  const key = Object.keys(OPS_COMMANDS).find((candidate) => {
    const parts = candidate.split(' ');
    return parts.every((part, index) => args[index] === part);
  });
  if (!key) {
    throw new Error(`Unknown ops command: ${args.join(' ')}`);
  }

  return { kind: 'command', key, args: args.slice(key.split(' ').length) };
}

export function formatHelp() {
  const commandLines = Object.entries(OPS_COMMANDS).map(
    ([key, command]) => `  ${key.padEnd(22)} ${command.description}`,
  );
  return [
    'Usage: pnpm run ops <group> <command> [args...]',
    '',
    'Commands:',
    ...commandLines,
    '',
    'Examples:',
    '  pnpm run ops db migrate --target cloudflare --source ./typecho.db',
    '  pnpm run ops user reset-password --user admin --target cloudflare',
  ].join('\n');
}

export function runOps(argv = process.argv.slice(2)) {
  const resolved = resolveOpsCommand(argv);
  if (resolved.kind === 'help') {
    console.log(formatHelp());
    return 0;
  }

  const { command, args, shell } = OPS_COMMANDS[resolved.key];
  const result = spawnSync(command, [...args, ...resolved.args], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    shell,
    windowsHide: true,
  });
  if (result.error) {
    console.error(`[ops] ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

const invokedScript = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedScript === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runOps();
  } catch (error) {
    console.error(`[ops] ${error.message}`);
    console.error(formatHelp());
    process.exitCode = 1;
  }
}
