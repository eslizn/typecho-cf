/**
 * Request-scoped capability runtime construction.
 *
 * Every entry point that may reach a plugin capability (HTTP middleware, Astro
 * pages, and the API routes that bootstrap their own plugin context) builds the
 * runtime through this helper, so the owner-scoped config accessor and the env
 * snapshot cannot drift between call sites.
 */
import { env } from 'cloudflare:workers';
import type { Database } from '@/db';
import { createCapabilityRuntimeContext, type CapabilityRuntimeContext } from '@/lib/capability';
import type { SiteOptions } from '@/lib/options';
import { loadPluginConfig } from '@/lib/plugin';

export interface RequestCapabilityRuntimeInput {
  request: Request;
  db: Database;
  options: SiteOptions;
  activatedPlugins: ReadonlySet<string>;
  activationGeneration?: number;
}

export function createRequestCapabilityRuntime(
  input: RequestCapabilityRuntimeInput,
): CapabilityRuntimeContext {
  return createCapabilityRuntimeContext({
    request: input.request,
    db: input.db,
    options: input.options,
    env: env as unknown as Record<string, unknown>,
    activatedPlugins: input.activatedPlugins,
    activationGeneration: input.activationGeneration,
    getPluginConfig: pluginId => loadPluginConfig(input.options, pluginId),
  });
}
