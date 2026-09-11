/**
 * Astro integration: Plugin Loader
 * 
 * Scans packages declared by the root package.json whose package.json keywords
 * contain both "typecho" and "plugin", reads their typecho.plugin manifest,
 * and registers all plugins at startup via a generated virtual module.
 * 
 * This follows the same pattern as theme-loader.ts for consistency.
 */
import type { AstroIntegration } from 'astro';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { satisfies, valid, validRange } from 'semver';
import {
  discoverRuntimePackageDependencies,
  type RuntimePackageDependency,
} from './declared-packages';
import type { PluginDependency, PluginDependencyIssue } from '../lib/plugin-dependencies';

export interface DiscoveredPlugin {
  id: string;
  packageName: string;
  packageDir: string;
  manifest: Record<string, any>;
  entryFile: string;
  importPath: string;
  dependencies: PluginDependency[];
  issues: PluginDependencyIssue[];
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

export function discoverPlugins(rootDir: string): DiscoveredPlugin[] {
  const { packages, dependencies } = discoverRuntimePackageDependencies(rootDir);
  const pluginsByDirectory = new Map<string, DiscoveredPlugin>();
  for (const packageInfo of packages) {
    const plugin = tryLoadPlugin(
      packageInfo.packageName,
      packageInfo.packageDir,
      packageInfo.importBase,
    );
    if (plugin) pluginsByDirectory.set(packageInfo.packageDir, plugin);
  }

  const pluginsById = new Map<string, DiscoveredPlugin[]>();
  for (const plugin of pluginsByDirectory.values()) {
    const list = pluginsById.get(plugin.id) ?? [];
    list.push(plugin);
    pluginsById.set(plugin.id, list);
  }

  for (const [id, plugins] of pluginsById) {
    if (plugins.length <= 1) continue;
    for (const plugin of plugins) {
      plugin.issues.push({
        pluginId: id,
        code: 'duplicate-plugin-id',
        message: `Plugin ID ${id} is provided by multiple packages: ${plugins.map(item => item.packageName).join(', ')}.`,
      });
    }
  }

  for (const plugin of pluginsByDirectory.values()) {
    for (const dependency of dependencies) {
      if (dependency.parent.packageDir !== plugin.packageDir) continue;
      addPluginDependency(plugin, dependency, pluginsByDirectory);
    }
  }

  // A duplicate ID is not enableable. Keep the first package in discovery
  // order for deterministic imports and diagnostics, but never register two
  // implementations under one runtime ID.
  return [...pluginsById.values()].map(plugins => plugins[0]);
}

function addPluginDependency(
  plugin: DiscoveredPlugin,
  dependency: RuntimePackageDependency,
  pluginsByDirectory: ReadonlyMap<string, DiscoveredPlugin>,
): void {
  const targetPlugin = dependency.target
    ? pluginsByDirectory.get(dependency.target.packageDir)
    : undefined;

  if (!targetPlugin) {
    if (dependency.kind === 'required' && looksLikePluginPackage(dependency.packageName)) {
      plugin.issues.push({
        pluginId: plugin.id,
        dependencyId: dependency.packageName,
        code: 'missing-required-dependency',
        message: `Plugin ${plugin.id} requires missing plugin ${dependency.packageName}.`,
      });
    }
    return;
  }

  plugin.dependencies.push({
    pluginId: targetPlugin.id,
    packageName: dependency.packageName,
    range: dependency.specifier,
    kind: dependency.kind,
  });

  const targetVersion = typeof dependency.target?.packageJson.version === 'string'
    ? dependency.target.packageJson.version
    : targetPlugin.manifest.version || '0.0.0';
  const versionCheck = checkVersionRange(targetVersion, dependency.specifier);
  if (dependency.kind !== 'required' || versionCheck === 'satisfied') return;
  plugin.issues.push(versionCheck === 'unsatisfied'
    ? {
      pluginId: plugin.id,
      dependencyId: targetPlugin.id,
      code: 'unsatisfied-required-dependency',
      message: `Plugin ${plugin.id} requires ${targetPlugin.id}@${dependency.specifier}, but ${targetVersion} is installed.`,
    }
    : {
      pluginId: plugin.id,
      dependencyId: targetPlugin.id,
      code: 'unverifiable-dependency-range',
      message: `Plugin ${plugin.id} depends on ${targetPlugin.id}@${dependency.specifier}; that specifier is not a semver range, so the installed ${targetVersion} was accepted without a version check.`,
    });
}

function looksLikePluginPackage(packageName: string): boolean {
  return /(?:^|[-_/])plugin(?:[-_/]|$)/i.test(packageName) || packageName.startsWith('typecho-');
}

type VersionCheck = 'satisfied' | 'unsatisfied' | 'unverifiable';

/**
 * Compare an installed version against a package.json dependency specifier.
 *
 * `file:` and `workspace:` specs point at the workspace copy and carry no
 * comparable version. Non-semver specs (`latest`, `npm:` aliases, git URLs)
 * cannot be evaluated offline either, so they are reported as unverifiable
 * rather than silently blocking activation: the author still sees a
 * diagnostic, but the admin may enable the plugin.
 */
function checkVersionRange(version: string, range: string): VersionCheck {
  if (range.startsWith('file:') || range.startsWith('workspace:')) return 'satisfied';
  const options = { includePrerelease: true } as const;
  // `satisfies()` swallows an invalid range and returns false, so validity has
  // to be checked separately to tell "does not match" from "cannot verify".
  if (valid(version) === null) return 'unverifiable';
  const parsedRange = validRange(range, options);
  if (parsedRange === null) return 'unverifiable';
  return satisfies(version, parsedRange, options) ? 'satisfied' : 'unsatisfied';
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
    dependencies: [],
    issues: [],
  };
}

/**
 * Generate the plugin registration + lazy loader table source for the
 * `virtual:typecho-plugin-registry` module imported by the middleware.
 *
 * Keeping this as the only registration path prevents the complete manifest
 * and loader table from being copied into every Astro page chunk. The static
 * middleware import guarantees that the loader table exists before the first
 * request of a cold isolate runs `setActivatedPlugins`.
 */
function buildRegistryCode(discoveredPlugins: DiscoveredPlugin[]): string {
  const registrations = discoveredPlugins.map((plugin) => {
    const manifest = JSON.stringify(plugin.manifest);
    const dependencyMetadata = JSON.stringify({
      dependencies: plugin.dependencies,
      issues: plugin.issues,
    });
    return `registerPlugin(${JSON.stringify(plugin.packageName)}, ${manifest}, ${dependencyMetadata});`;
  }).join('\n');

  const pluginEntries = discoveredPlugins.map((plugin) => {
    return `  ${JSON.stringify(plugin.id)}: () => import(${JSON.stringify(plugin.importPath)}).then((module) => module.default),`;
  }).join('\n');

  return `import { registerPlugin, registerPluginLoaders, addHook, HookPoints } from '@/lib/plugin';\n${registrations}\nregisterPluginLoaders({\n${pluginEntries}\n}, { addHook, HookPoints });`;
}

export default function pluginLoaderIntegration(): AstroIntegration {
  let discoveredPlugins: DiscoveredPlugin[] = [];

  return {
    name: 'typecho-plugin-loader',
    hooks: {
      'astro:config:setup': ({ config, updateConfig }) => {
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

        const registryCode = buildRegistryCode(discoveredPlugins);

        // Expose the generated registry as a Vite virtual module that
        // src/middleware.ts imports statically. This ensures a cold isolate's
        // FIRST request — e.g. a WebDAV client hitting /webdav directly —
        // runs setActivatedPlugins only after the loader table is registered.
        updateConfig({
          vite: {
            plugins: [{
              name: 'typecho-plugin-registry',
              resolveId(id: string) {
                if (id === 'virtual:typecho-plugin-registry') return '\0virtual:typecho-plugin-registry';
              },
              load(id: string) {
                if (id === '\0virtual:typecho-plugin-registry') return registryCode;
              },
            }],
          },
        });

      },

      'astro:build:done': () => {
        if (discoveredPlugins.length > 0) {
          console.log(`[plugin-loader] Build complete. ${discoveredPlugins.length} plugin(s) bundled.`);
        }
      },
    },
  };
}
