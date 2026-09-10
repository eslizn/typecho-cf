import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import {
  ensureQueues,
  extractWranglerContext,
  runWrangler,
} from './ensure-queues.mjs';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, '..');

export function effectiveRoot(argv, rootDir = ROOT_DIR) {
  const { cwd } = extractWranglerContext(argv);
  return cwd ? (isAbsolute(cwd) ? resolve(cwd) : resolve(rootDir, cwd)) : rootDir;
}

export function runBuild(cwd) {
  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(pnpmCommand, ['run', 'build'], {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  return result.error ? 1 : result.status ?? 1;
}

export function isHelpOrVersion(argv) {
  return argv.includes('--help') || argv.includes('-h') || argv.includes('--version');
}

/**
 * Workers Builds runs the build command before the deploy command and
 * Deploy to Cloudflare provisions declared resources before the first build.
 * Keep the local deploy path self-contained, but avoid repeating those steps
 * when this wrapper is invoked by Workers Builds.
 * @param {{ WORKERS_CI?: string }} [env]
 */
export function isWorkersBuild(env = process.env) {
  return env.WORKERS_CI === '1';
}

/**
 * Parse Wrangler's boolean dry-run flag without treating `--dry-run=false`
 * as enabled. Unknown values fail closed and let Wrangler report the invalid
 * CLI input without creating account-level resources first.
 */
export function isDryRun(argv = []) {
  let enabled = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-dry-run') {
      enabled = false;
      continue;
    }
    if (arg === '--dry-run') {
      const next = argv[index + 1]?.toLowerCase();
      if (next === 'true' || next === 'false') {
        enabled = next === 'true';
        index += 1;
      } else {
        enabled = true;
      }
      continue;
    }
    if (arg.startsWith('--dry-run=')) {
      enabled = arg.slice('--dry-run='.length).toLowerCase() !== 'false';
    }
  }
  return enabled;
}

export async function deploy(argv, {
  rootDir = ROOT_DIR,
  ensureQueuesFn = ensureQueues,
  runBuildFn = runBuild,
  runWranglerFn = runWrangler,
  workersBuild = isWorkersBuild(),
} = {}) {
  const cwd = effectiveRoot(argv, rootDir);

  if (isHelpOrVersion(argv)) {
    return runWranglerFn(['deploy', ...argv], { cwd: rootDir, capture: false }).status ?? 1;
  }

  // A dry run must not create account-level resources. Deploy to Cloudflare
  // already provisions declared resources before Workers Builds starts, so
  // the CI path intentionally has no account-level preflight.
  if (!workersBuild && !isDryRun(argv)) {
    // `ensureQueues` resolves --cwd relative to rootDir itself. Passing the
    // already-resolved cwd here would resolve a relative --cwd twice.
    await ensureQueuesFn({ rootDir, argv });
  }

  // Workers Builds has already executed the configured build command. The
  // local path remains a complete build-and-deploy workflow.
  if (!workersBuild) {
    const buildStatus = runBuildFn(cwd);
    if (buildStatus !== 0) return buildStatus;
  }

  // Leave --cwd in the final argument list and run from rootDir so Wrangler
  // itself applies that option exactly once.
  return runWranglerFn(['deploy', ...argv], { cwd: rootDir, capture: false }).status ?? 1;
}

const invokedScript = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedScript === fileURLToPath(import.meta.url)) {
  deploy(process.argv.slice(2))
    .then(status => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(`[deploy] ${error.message}`);
      process.exitCode = 1;
    });
}
