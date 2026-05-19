/**
 * Astro integration: Plugin Loader
 * 
 * Scans node_modules for packages whose package.json keywords contain
 * both "typecho" and "plugin", reads their typecho.plugin manifest, and registers
 * all plugins at startup via injectScript.
 * 
 * This follows the same pattern as theme-loader.ts for consistency.
 */
import type { AstroIntegration } from 'astro';
import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

interface DiscoveredPlugin {
  id: string;
  packageName: string;
  packageDir: string;
  manifest: Record<string, any>;
  entryFile: string;
  importPath: string;
}

/**
 * Check if a package's keywords contain both "typecho" and "plugin" (case-insensitive).
 */
function isTypechoPlugin(keywords: unknown): boolean {
  if (!Array.isArray(keywords)) return false;
  const lower = keywords.map((k: unknown) => String(k).toLowerCase());
  return lower.includes('typecho') && lower.includes('plugin');
}

/**
 * Derive plugin ID from package name or manifest.
 * Uses the full package name as the plugin ID (no prefix stripping).
 */
function derivePluginId(packageName: string, manifest?: Record<string, any>): string {
  if (manifest?.id) return manifest.id;
  return packageName;
}

/**
 * Find the plugin entry file (index.ts, index.js, or custom entry from manifest)
 */
function findEntryFile(packageDir: string, manifest?: Record<string, any>): string | null {
  // Check manifest-specified entry
  if (manifest?.entry) {
    const entryPath = join(packageDir, manifest.entry);
    if (existsSync(entryPath)) return manifest.entry;
  }

  // Try common entry files
  for (const name of ['index.ts', 'index.js', 'index.mjs', 'plugin.ts', 'plugin.js']) {
    if (existsSync(join(packageDir, name))) return name;
  }

  return null;
}

function toViteRootPath(rootDir: string, filePath: string): string {
  return `/${relative(rootDir, filePath).split(sep).join('/')}`;
}

function discoverLocalFilePlugins(rootDir: string): DiscoveredPlugin[] {
  const plugins: DiscoveredPlugin[] = [];
  const rootPkgPath = join(rootDir, 'package.json');
  if (!existsSync(rootPkgPath)) return plugins;

  let rootPkg: Record<string, any>;
  try {
    rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
  } catch {
    return plugins;
  }

  const deps = {
    ...(rootPkg.dependencies || {}),
    ...(rootPkg.devDependencies || {}),
  };
  for (const [packageName, specifier] of Object.entries(deps)) {
    if (typeof specifier !== 'string' || !specifier.startsWith('file:src/plugins/')) continue;
    const relativePackageDir = specifier.slice('file:'.length);
    try {
      const packageDir = realpathSync(join(rootDir, relativePackageDir));
      const importBase = toViteRootPath(rootDir, packageDir);
      const plugin = tryLoadPlugin(packageName, packageDir, importBase);
      if (plugin) plugins.push(plugin);
    } catch {
      continue;
    }
  }

  return plugins;
}

function discoverPlugins(rootDir: string): DiscoveredPlugin[] {
  const plugins: DiscoveredPlugin[] = [];
  const seenPackages = new Set<string>();
  for (const plugin of discoverLocalFilePlugins(rootDir)) {
    plugins.push(plugin);
    seenPackages.add(plugin.packageName);
  }

  const nodeModulesDir = join(rootDir, 'node_modules');

  if (!existsSync(nodeModulesDir)) return plugins;

  const entries = readdirSync(nodeModulesDir);
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;

    if (entry.startsWith('@')) {
      // Scoped packages
      const scopeDir = join(nodeModulesDir, entry);
      try {
        const realScopeDir = realpathSync(scopeDir);
        if (!statSync(realScopeDir).isDirectory()) continue;
        const scopedEntries = readdirSync(realScopeDir);
        for (const scopedEntry of scopedEntries) {
          if (scopedEntry.startsWith('.')) continue;
          try {
            const pkgDir = realpathSync(join(scopeDir, scopedEntry));
            if (seenPackages.has(`${entry}/${scopedEntry}`)) continue;
            const plugin = tryLoadPlugin(`${entry}/${scopedEntry}`, pkgDir);
            if (plugin) plugins.push(plugin);
          } catch { continue; }
        }
      } catch { continue; }
    } else {
      try {
        if (seenPackages.has(entry)) continue;
        const pkgDir = realpathSync(join(nodeModulesDir, entry));
        const plugin = tryLoadPlugin(entry, pkgDir);
        if (plugin) plugins.push(plugin);
      } catch { continue; }
    }
  }

  return plugins;
}

/**
 * Try to load a plugin from a package directory.
 * First checks package.json keywords for ["typecho", "plugin"],
 * then reads typecho.plugin in package.json (or plugin.json as fallback) for manifest.
 */
function tryLoadPlugin(packageName: string, packageDir: string, importBase?: string): DiscoveredPlugin | null {
  const pkgJsonPath = join(packageDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return null;

  let pkgJson: Record<string, any>;
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  } catch {
    return null;
  }

  // Gate: keywords must contain both "typecho" and "plugin"
  if (!isTypechoPlugin(pkgJson.keywords)) return null;

  let manifest: Record<string, any> = {};

  if (pkgJson.typecho?.plugin) {
    manifest = { ...pkgJson.typecho.plugin };
  } else {
    const manifestPath = join(packageDir, 'plugin.json');
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      } catch (err) {
        console.warn(`[plugin-loader] Failed to parse plugin.json from ${packageName}:`, err);
        return null;
      }
    }
  }

  if (!manifest.id) {
    // Construct manifest from package.json fields
    manifest = {
      name: pkgJson.name || packageName,
      description: pkgJson.description || '',
      author: typeof pkgJson.author === 'string' ? pkgJson.author : pkgJson.author?.name || '',
      version: pkgJson.version || '0.0.0',
    };
  }

  const id = derivePluginId(packageName, manifest);
  manifest.id = id;

  // Find entry file
  const entryFile = findEntryFile(packageDir, manifest);
  if (!entryFile) {
    console.warn(`[plugin-loader] Plugin ${packageName}: no entry file found, skipping.`);
    return null;
  }

  return {
    id,
    packageName,
    packageDir,
    manifest,
    entryFile,
    importPath: importBase
      ? `${importBase}/${entryFile.replace(/\\/g, '/')}`
      : `${packageName}/${entryFile}`,
  };
}

export default function pluginLoaderIntegration(): AstroIntegration {
  let discoveredPlugins: DiscoveredPlugin[] = [];

  return {
    name: 'typecho-plugin-loader',
    hooks: {
      'astro:config:setup': ({ config, injectScript }) => {
        const rootDir = config.root ? config.root.pathname.replace(/^\/([A-Z]:)/, '$1') : process.cwd();

        // Discover plugins
        discoveredPlugins = discoverPlugins(rootDir);

        if (discoveredPlugins.length > 0) {
          console.log(`[plugin-loader] Discovered ${discoveredPlugins.length} plugin(s):`);
          for (const plugin of discoveredPlugins) {
            console.log(`  - ${plugin.manifest.name || plugin.id} (${plugin.packageName})`);
          }
        } else {
          console.log('[plugin-loader] No npm plugins found.');
        }

        // Inject plugin registration + lazy initializer table.
        //
        // G6-3: instead of eagerly executing every plugin's init() on
        // every page SSR, we expose a __typechoPluginInits map keyed
        // by plugin id. The runtime (context.ts via setActivatedPlugins)
        // calls each entry once per isolate, so disabled plugins never
        // touch hookRegistry and modules whose init has side effects
        // (e.g. webdav's module-scope authFailureStates) never get
        // constructed unless the plugin is actually activated.
        if (discoveredPlugins.length > 0) {
          const registrations = discoveredPlugins.map((plugin) => {
            const manifest = JSON.stringify(plugin.manifest);
            return `registerPlugin(${JSON.stringify(plugin.packageName)}, ${manifest});`;
          }).join('\n');

          const pluginImports = discoveredPlugins.map((plugin, idx) => {
            return `import pluginInit_${idx} from ${JSON.stringify(plugin.importPath)};`;
          }).join('\n');

          const pluginEntries = discoveredPlugins.map((plugin, idx) => {
            return `  ${JSON.stringify(plugin.id)}: pluginInit_${idx},`;
          }).join('\n');

          injectScript(
            'page-ssr',
            `import { registerPlugin, registerPluginInit, addHook, HookPoints } from '@/lib/plugin';\n${pluginImports}\n${registrations}\nregisterPluginInit({\n${pluginEntries}\n}, { addHook, HookPoints });`,
          );
        }
      },

      'astro:build:done': () => {
        if (discoveredPlugins.length > 0) {
          console.log(`[plugin-loader] Build complete. ${discoveredPlugins.length} plugin(s) bundled.`);
        }
      },
    },
  };
}
