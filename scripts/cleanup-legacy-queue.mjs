import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  extractWranglerContext,
  listExistingQueueNames,
  resolvedWorkingDirectory,
  runWrangler,
} from './ensure-queues.mjs';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, '..');

/** The queue name used by the pre-single-Queue deployment. */
export const LEGACY_TASK_DLQ_NAME = 'typecho-cf-tasks-dlq';

export function hasLegacyTaskDlqReference(configText) {
  return String(configText).includes(LEGACY_TASK_DLQ_NAME);
}

const GLOBAL_VALUE_FLAGS = new Set([
  '--config',
  '-c',
  '--env',
  '-e',
  '--env-file',
  '--profile',
  '--cwd',
]);

function optionName(arg) {
  const equalsIndex = arg.indexOf('=');
  return equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
}

function optionValue(arg, nextArg, index) {
  const equalsIndex = arg.indexOf('=');
  if (equalsIndex !== -1) {
    const value = arg.slice(equalsIndex + 1);
    if (!value) throw new Error(`${optionName(arg)} requires a value`);
    return { value, nextIndex: index };
  }
  if (!nextArg || nextArg.startsWith('-')) {
    throw new Error(`${arg} requires a value`);
  }
  return { value: nextArg, nextIndex: index + 1 };
}

function parseCleanupArgs(argv = []) {
  let confirmation;
  let dryRun = false;
  const wranglerArgv = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--confirm' || arg.startsWith('--confirm=')) {
      const parsed = optionValue(arg, argv[index + 1], index);
      confirmation = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (arg === '--dry-run') {
      const next = argv[index + 1]?.toLowerCase();
      if (next === 'true' || next === 'false') {
        dryRun = next === 'true';
        index += 1;
      } else {
        dryRun = true;
      }
      continue;
    }
    if (arg.startsWith('--dry-run=')) {
      dryRun = arg.slice('--dry-run='.length).toLowerCase() !== 'false';
      continue;
    }
    if (arg === '--no-dry-run') {
      dryRun = false;
      continue;
    }

    const name = optionName(arg);
    if (!GLOBAL_VALUE_FLAGS.has(name)) {
      throw new Error(`Unsupported cleanup option '${arg}'. Only Wrangler global options, --confirm, and --dry-run are supported.`);
    }
    const parsed = optionValue(arg, argv[index + 1], index);
    wranglerArgv.push(arg);
    if (parsed.nextIndex !== index) wranglerArgv.push(parsed.value);
    index = parsed.nextIndex;
  }

  return { confirmation, dryRun, wranglerArgv };
}

function commandStatus(result) {
  if (typeof result?.status === 'number') return String(result.status);
  if (result?.signal) return `signal ${result.signal}`;
  if (result?.error?.code) return String(result.error.code);
  return 'unknown failure';
}

/**
 * Delete only the known pre-single-Queue DLQ after an explicit confirmation.
 * Ordinary deploys never call this function, and the current config must not
 * still mention the legacy name.
 *
 * @param {{ rootDir?: string, argv?: string[], runner?: Function, logger?: Console }} [options]
 */
export async function cleanupLegacyQueue({
  rootDir = ROOT_DIR,
  argv = [],
  runner = runWrangler,
  logger = console,
} = {}) {
  const cleanup = parseCleanupArgs(argv);
  const context = extractWranglerContext(cleanup.wranglerArgv);
  const cwd = resolvedWorkingDirectory(rootDir, context.cwd);
  const configPath = resolve(cwd, context.configPath ?? 'wrangler.toml');
  const configText = readFileSync(configPath, 'utf8');
  const log = typeof logger?.log === 'function' ? logger.log.bind(logger) : () => {};

  if (hasLegacyTaskDlqReference(configText)) {
    throw new Error(`Refusing to delete '${LEGACY_TASK_DLQ_NAME}' while the selected Wrangler config still references it`);
  }
  if (!cleanup.dryRun && cleanup.confirmation !== LEGACY_TASK_DLQ_NAME) {
    throw new Error(`Refusing to delete '${LEGACY_TASK_DLQ_NAME}'. Re-run with --confirm ${LEGACY_TASK_DLQ_NAME}`);
  }

  log(`[queues:cleanup] checking legacy Queue: ${LEGACY_TASK_DLQ_NAME}`);
  const existing = await listExistingQueueNames({
    runner,
    cwd,
    globalArgs: context.globalArgs,
  });
  if (!existing.has(LEGACY_TASK_DLQ_NAME)) {
    log(`[queues:cleanup] not found: ${LEGACY_TASK_DLQ_NAME}`);
    return { queueName: LEGACY_TASK_DLQ_NAME, exists: false, deleted: false, configPath };
  }

  if (cleanup.dryRun) {
    log(`[queues:cleanup] dry-run: would delete ${LEGACY_TASK_DLQ_NAME}`);
    return { queueName: LEGACY_TASK_DLQ_NAME, exists: true, deleted: false, dryRun: true, configPath };
  }

  log(`[queues:cleanup] deleting: ${LEGACY_TASK_DLQ_NAME}`);
  const result = await runner(
    ['queues', 'delete', LEGACY_TASK_DLQ_NAME, ...context.globalArgs],
    { cwd, capture: false },
  );
  if (result?.status !== 0) {
    throw new Error(`wrangler queues delete failed for '${LEGACY_TASK_DLQ_NAME}' (${commandStatus(result)}); cleanup was stopped`);
  }
  log(`[queues:cleanup] deleted: ${LEGACY_TASK_DLQ_NAME}`);
  return { queueName: LEGACY_TASK_DLQ_NAME, exists: true, deleted: true, configPath };
}

const invokedScript = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedScript === fileURLToPath(import.meta.url)) {
  cleanupLegacyQueue({ rootDir: process.cwd(), argv: process.argv.slice(2) }).catch(error => {
    console.error(`[queues:cleanup] ${error.message}`);
    process.exitCode = 1;
  });
}
