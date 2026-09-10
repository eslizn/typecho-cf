import { getDb, type Database } from '@/db';
import { loadOptions, type SiteOptions } from '@/lib/options';
import {
  getPluginInitFailures,
  parseActivatedPlugins,
  setActivatedPlugins,
  type HookContext,
} from '@/lib/plugin';
import { dispatchTaskMessages, type TaskMessageBatchLike, type TaskMessageLike } from './dispatcher';

export interface PluginTaskInitFailure {
  error: string;
  attempts: number;
  failedAt: number;
}

export interface TaskRuntime {
  env: Cloudflare.Env;
  db: Database;
  options: SiteOptions;
  activatedPlugins: ReadonlySet<string>;
  initFailures: Readonly<Record<string, PluginTaskInitFailure>>;
}

/**
 * Build the per-consumer runtime snapshot. Plugin init is deliberately part
 * of this step so queue dispatch uses the same activation rules as requests.
 * No task state is persisted here; Queue remains the retry boundary. The
 * deployment intentionally has no DLQ, so exhausted messages are discarded.
 */
export async function createTaskRuntime(env: Cloudflare.Env): Promise<TaskRuntime> {
  const db = getDb(env.DB);
  const options = await loadOptions(db);
  const activePluginIds = parseActivatedPlugins(options.activatedPlugins as string | undefined);
  const pluginContext: HookContext = { activatedPlugins: new Set<string>() };

  await setActivatedPlugins(pluginContext, activePluginIds);

  return {
    env,
    db,
    options,
    activatedPlugins: new Set(pluginContext.activatedPlugins),
    initFailures: { ...getPluginInitFailures() },
  };
}

/**
 * Queue consumer entrypoint helper. Empty batches avoid an unnecessary D1
 * read and are valid no-ops.
 */
export async function consumeTaskBatch(
  batch: TaskMessageBatchLike,
  env: Cloudflare.Env,
): Promise<void> {
  if (!batch || !Array.isArray(batch.messages) || batch.messages.length === 0) return;
  const runtime = await createTaskRuntime(env);
  await dispatchTaskMessages(
    batch.messages as readonly TaskMessageLike[],
    runtime,
  );
}
