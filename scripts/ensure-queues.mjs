import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, '..');
const WRANGLER_CLI = require.resolve('wrangler');
const WRANGLER_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_QUEUE_LIST_PAGES = 100;
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

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

/**
 * Keep only Wrangler's global options for `queues list/create`, while leaving
 * all original arguments available for the final `wrangler deploy` command.
 * `--cwd` is consumed here because the child process already receives the
 * resolved working directory separately; forwarding it would apply the
 * directory change twice when callers already supplied a relative path.
 * @param {string[]} [argv]
 */
export function extractWranglerContext(argv = []) {
  const globalArgs = [];
  let configPath;
  let environment;
  let cwd;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const name = optionName(arg);
    if (!GLOBAL_VALUE_FLAGS.has(name)) continue;

    const parsed = optionValue(arg, argv[index + 1], index);
    if (name !== '--cwd') {
      globalArgs.push(arg);
      if (parsed.nextIndex !== index) globalArgs.push(parsed.value);
    }

    if (name === '--config' || name === '-c') configPath = parsed.value;
    if (name === '--env' || name === '-e') environment = parsed.value;
    if (name === '--cwd') cwd = parsed.value;
    index = parsed.nextIndex;
  }

  return { globalArgs, configPath, environment, cwd };
}

function queueSectionForHeader(header) {
  const parts = header.split('.').map((part) => part.trim());
  const queuesIndex = parts.indexOf('queues');
  if (queuesIndex === -1) return null;

  const kind = parts[queuesIndex + 1];
  if (kind !== 'producers' && kind !== 'consumers') return null;

  if (queuesIndex === 0) return { environment: undefined };
  if (queuesIndex === 2 && parts[0] === 'env' && parts[1]) {
    return { environment: parts[1] };
  }
  return null;
}

function parseTomlHeader(line) {
  const match = line.match(/^\s*(\[\[|\[)([^\]]+)(\]\]|\])\s*(?:#.*)?$/);
  if (!match) return null;

  const isArrayTable = match[1] === '[[' && match[3] === ']]';
  const isTable = match[1] === '[' && match[3] === ']';
  if (!isArrayTable && !isTable) return null;
  return queueSectionForHeader(match[2]);
}

/**
 * Extract Queue references from the selected Wrangler TOML config.
 * The config remains the source of truth, so queue names cannot drift from
 * the bindings used by the Worker. This project intentionally does not
 * provision dead-letter queues.
 */
export function parseQueueNamesFromWranglerConfig(configText, environment) {
  const sections = [];
  let currentSection = null;

  for (const line of String(configText).split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      currentSection = parseTomlHeader(line);
      if (currentSection) {
        currentSection.names = [];
        sections.push(currentSection);
      }
      continue;
    }

    if (!currentSection) continue;
    const valueMatch = line.match(
      /^\s*queue\s*=\s*(?:"([^"]+)"|'([^']+)')\s*(?:#.*)?$/,
    );
    if (valueMatch) currentSection.names.push(valueMatch[1] ?? valueMatch[2]);
  }

  const environmentSections = environment
    ? sections.filter((section) => section.environment === environment)
    : [];
  const selectedSections = environment && environmentSections.length > 0
    ? environmentSections
    : sections.filter((section) => section.environment === undefined);

  const names = [];
  const seen = new Set();
  for (const section of selectedSections) {
    for (const name of section.names) {
      if (!name || /\s/.test(name) || name.length > 255) {
        throw new Error(`Invalid Queue name in Wrangler config: ${JSON.stringify(name)}`);
      }
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }

  if (names.length === 0) {
    const suffix = environment ? ` for environment '${environment}'` : '';
    throw new Error(`No Queue references found in the selected Wrangler config${suffix}`);
  }
  return names;
}

function stripAnsi(value) {
  return String(value ?? '').replace(ANSI_ESCAPE_PATTERN, '');
}

function splitTableCells(line) {
  if (!line.includes('│') && !line.includes('|')) return [];
  return line.split(/[│|]/).map((cell) => cell.trim());
}

function isTableBorderCell(cell) {
  return /^[\s\-─━═]+$/.test(cell);
}

function stripWranglerPreamble(text) {
  const lines = text.split(/\r?\n/);
  const firstContentIndex = lines.findIndex(line => line.trim() !== '');
  if (firstContentIndex === -1) return '';

  const versionLine = lines[firstContentIndex];
  const borderIndex = firstContentIndex + 1;
  if (
    !/\bwrangler\s+\d+(?:\.\d+){1,2}\b/i.test(versionLine)
    || borderIndex >= lines.length
    || !isTableBorderCell(lines[borderIndex])
  ) {
    return text;
  }

  return lines.slice(borderIndex + 1).join('\n');
}

/**
 * Parse the stable human-readable table emitted by `wrangler queues list`.
 * Wrangler 4.129.1 does not expose a JSON mode for this command, so parsing
 * is deliberately limited to the named `name` column and fails closed when
 * the output shape is unknown.
 */
export function parseQueueListOutput(output) {
  const text = stripWranglerPreamble(stripAnsi(output));
  const lines = text.split(/\r?\n/);
  const rows = lines.map(splitTableCells);
  const headerIndex = rows.findIndex((cells) =>
    cells.some((cell) => cell.toLowerCase() === 'name'),
  );

  if (headerIndex === -1) {
    const trimmed = text.trim();
    if (!trimmed || /^no queues?(?: found| available)?\.?$/i.test(trimmed)) {
      return { recognized: true, hasRows: false, names: new Set() };
    }
    return { recognized: false, hasRows: false, names: new Set() };
  }

  const nameIndex = rows[headerIndex].findIndex((cell) => cell.toLowerCase() === 'name');
  const names = new Set();
  let hasRows = false;
  for (const cells of rows.slice(headerIndex + 1)) {
    if (cells.length <= nameIndex || cells.every(isTableBorderCell)) continue;
    const name = cells[nameIndex];
    if (!name || name.toLowerCase() === 'name' || isTableBorderCell(name)) continue;
    hasRows = true;
    names.add(name);
  }

  return { recognized: true, hasRows, names };
}

function commandStatus(result) {
  if (typeof result?.status === 'number') return String(result.status);
  if (result?.signal) return `signal ${result.signal}`;
  if (result?.error?.code) return String(result.error.code);
  return 'unknown failure';
}

function assertWranglerSuccess(result, operation) {
  if (result?.status === 0) return;
  throw new Error(`wrangler ${operation} failed (${commandStatus(result)}); deployment was stopped`);
}

/**
 * Invoke the repository's pinned Wrangler package directly, avoiding shell
 * interpolation of config paths, environment names, or profile arguments.
 */
export function runWrangler(args, { cwd = ROOT_DIR, capture = true } = {}) {
  const result = spawnSync(process.execPath, [WRANGLER_CLI, ...args], {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    timeout: WRANGLER_TIMEOUT_MS,
    windowsHide: true,
  });

  return {
    status: result.error ? null : result.status,
    signal: result.signal,
    error: result.error,
    stdout: capture ? result.stdout ?? '' : '',
    stderr: capture ? result.stderr ?? '' : '',
  };
}

export async function listExistingQueueNames({ runner, cwd, globalArgs }) {
  const names = new Set();
  for (let page = 1; page <= MAX_QUEUE_LIST_PAGES; page += 1) {
    const args = ['queues', 'list', ...globalArgs, '--page', String(page)];
    const result = await runner(args, { cwd, capture: true });
    assertWranglerSuccess(result, 'queues list');

    const parsed = parseQueueListOutput(result.stdout);
    if (!parsed.recognized) {
      throw new Error('Unable to parse `wrangler queues list` output; deployment was stopped');
    }
    for (const name of parsed.names) names.add(name);
    if (!parsed.hasRows) return names;
  }
  throw new Error(`Unable to finish listing Queues after ${MAX_QUEUE_LIST_PAGES} pages`);
}

export function resolvedWorkingDirectory(rootDir, cwd) {
  if (!cwd) return rootDir;
  return isAbsolute(cwd) ? resolve(cwd) : resolve(rootDir, cwd);
}

/**
 * Ensure every queue referenced by the selected Wrangler config exists. A
 * second list after a failed create makes concurrent deploys safe without
 * hiding authentication, permission, or network failures.
 * @param {{ rootDir?: string, argv?: string[], runner?: Function, logger?: Console }} [options]
 */
export async function ensureQueues({
  rootDir = ROOT_DIR,
  argv = [],
  runner = runWrangler,
  logger = console,
} = {}) {
  const context = extractWranglerContext(argv);
  const cwd = resolvedWorkingDirectory(rootDir, context.cwd);
  const configPath = resolve(cwd, context.configPath ?? 'wrangler.toml');
  const configText = readFileSync(configPath, 'utf8');
  const queueNames = parseQueueNamesFromWranglerConfig(configText, context.environment);
  const log = typeof logger?.log === 'function' ? logger.log.bind(logger) : () => {};

  log(`[queues:ensure] checking ${queueNames.length} Queue resource(s)`);
  let existing = await listExistingQueueNames({ runner, cwd, globalArgs: context.globalArgs });
  const created = [];

  for (const queueName of queueNames) {
    if (existing.has(queueName)) {
      log(`[queues:ensure] exists: ${queueName}`);
      continue;
    }

    log(`[queues:ensure] creating: ${queueName}`);
    const createArgs = ['queues', 'create', queueName, ...context.globalArgs];
    const result = await runner(createArgs, { cwd, capture: true });
    if (result?.status === 0) {
      existing.add(queueName);
      created.push(queueName);
      log(`[queues:ensure] created: ${queueName}`);
      continue;
    }

    try {
      existing = await listExistingQueueNames({ runner, cwd, globalArgs: context.globalArgs });
    } catch {
      throw new Error(`wrangler queues create failed for '${queueName}' (${commandStatus(result)}); deployment was stopped`);
    }
    if (existing.has(queueName)) {
      log(`[queues:ensure] exists after concurrent create: ${queueName}`);
      continue;
    }
    throw new Error(`wrangler queues create failed for '${queueName}' (${commandStatus(result)}); deployment was stopped`);
  }

  return { queueNames, created, configPath, environment: context.environment };
}

const invokedScript = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedScript === fileURLToPath(import.meta.url)) {
  ensureQueues({ rootDir: process.cwd(), argv: process.argv.slice(2) }).catch((error) => {
    console.error(`[queues:ensure] ${error.message}`);
    process.exitCode = 1;
  });
}
