import { and, eq, or, like } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import type { SiteOptions } from '@/lib/options';

const PLUGIN_OPTION_PREFIX = 'plugin:';
const ACTIVATED_PLUGINS_OPTION = 'activatedPlugins';

/**
 * Overlay the authoritative plugin activation/config rows onto cached
 * presentation options. Call with a Database backed by a `first-primary`
 * D1 session so a freshly disabled route/token cannot be honored from an old
 * read-replica or isolate options snapshot.
 */
export async function loadPluginSecurityOptions(
  db: Database,
  cachedOptions: SiteOptions,
): Promise<SiteOptions> {
  const rows = await db.select({ name: schema.options.name, value: schema.options.value })
    .from(schema.options)
    .where(and(
      eq(schema.options.user, 0),
      or(
        eq(schema.options.name, ACTIVATED_PLUGINS_OPTION),
        like(schema.options.name, `${PLUGIN_OPTION_PREFIX}%`),
      ),
    ));

  const current = { ...cachedOptions };
  for (const key of Object.keys(current)) {
    if (key.startsWith(PLUGIN_OPTION_PREFIX)) delete current[key];
  }
  // A missing activation row means no plugins are enabled. Do not inherit an
  // old non-empty activation value from the public options snapshot.
  current[ACTIVATED_PLUGINS_OPTION] = '';
  for (const row of rows) {
    current[row.name] = row.value;
  }
  return current as SiteOptions;
}
