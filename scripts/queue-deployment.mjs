import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { experimental_readRawConfig } from 'wrangler';

const QUEUE_MODE_ENABLED = 'with-queue';
export const QUEUE_MODE_DISABLED = 'no-queue';
const QUEUE_MODE_ENV = 'TYPECHO_QUEUE_MODE';

export function readQueueDeploymentMode(value = process.env[QUEUE_MODE_ENV]) {
  if (value === undefined || value === QUEUE_MODE_ENABLED) return QUEUE_MODE_ENABLED;
  if (value === QUEUE_MODE_DISABLED) return QUEUE_MODE_DISABLED;
  throw new Error(`${QUEUE_MODE_ENV} must be "${QUEUE_MODE_ENABLED}" or "${QUEUE_MODE_DISABLED}"`);
}

export function readSourceWranglerConfig(cwd, configPath) {
  // Anchor Wrangler discovery to the project directory and ignore any prior
  // Astro build's redirected deploy config.
  const source = experimental_readRawConfig({
    config: configPath ? resolve(cwd, configPath) : undefined,
    script: resolve(cwd, 'worker.js'),
  });
  if (!source.configPath) throw new Error(`No Wrangler config found in ${cwd} or its parent directories`);
  return source;
}

function omitTaskQueue(environment) {
  const config = { ...environment };
  delete config.queues;
  // An empty list clears deployed Cron triggers. An omitted list leaves them
  // in place when switching an existing Worker to this mode.
  config.triggers = { ...config.triggers, crons: [] };
  return config;
}

function createQueueDisabledConfig(source) {
  const config = omitTaskQueue(source);
  if (source.env) {
    config.env = Object.fromEntries(Object.entries(source.env).map(([name, environment]) => [
      name, omitTaskQueue(environment),
    ]));
  }
  return config;
}

export function getQueueBuildConfigPath(cwd, mode) {
  if (readQueueDeploymentMode(mode) === QUEUE_MODE_ENABLED) return undefined;
  const source = readSourceWranglerConfig(cwd);
  // Keep the generated config beside its source so relative paths retain
  // their meaning in the adapter, Wrangler, and local development.
  const path = join(dirname(source.configPath), '.typecho-wrangler-no-queue.json');
  const serialized = `${JSON.stringify(createQueueDisabledConfig(source.rawConfig), null, 2)}\n`;
  if (!existsSync(path) || readFileSync(path, 'utf8') !== serialized) {
    writeFileSync(path, serialized, { mode: 0o600 });
  }
  return path;
}
