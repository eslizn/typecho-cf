/**
 * Astro integration: Theme Loader
 * 
 * Scans node_modules for packages whose package.json keywords contain
 * both "typecho" and "theme", reads their theme.json, copies CSS and
 * assets to public/themes/{id}/, and registers all themes at startup.
 *
 * NEW: Also scans for Astro template components in each theme's components/
 * directory and generates a Vite virtual module `virtual:theme-templates`
 * that maps theme IDs to their template components.
 */
import type { AstroIntegration } from 'astro';
import { readFileSync, existsSync, readdirSync, mkdirSync, cpSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

interface DiscoveredTheme {
  id: string;
  packageName: string;
  packageDir: string;
  manifest: Record<string, any>;
  cssFile: string;
  screenshotFile?: string;
  /** Astro component files found in components/ directory */
  components: Record<string, string>; // e.g. { Index: '/abs/path/Index.astro' }
}

const TEMPLATE_TYPES = ['Index', 'Post', 'Page', 'Archive', 'NotFound'] as const;

/**
 * Check if a package's keywords contain both "typecho" and "theme" (case-insensitive).
 */
function isTypechoTheme(keywords: unknown): boolean {
  if (!Array.isArray(keywords)) return false;
  const lower = keywords.map((k: unknown) => String(k).toLowerCase());
  return lower.includes('typecho') && lower.includes('theme');
}

/**
 * Derive theme ID from package name or manifest.
 * Uses the full package name as the theme ID (no prefix stripping).
 */
function deriveThemeId(packageName: string, manifest?: Record<string, any>): string {
  if (manifest?.id) return manifest.id;
  return packageName;
}

function discoverThemes(rootDir: string): DiscoveredTheme[] {
  const themes: DiscoveredTheme[] = [];
  const nodeModulesDir = join(rootDir, 'node_modules');

  if (!existsSync(nodeModulesDir)) return themes;

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
            const theme = tryLoadTheme(`${entry}/${scopedEntry}`, pkgDir);
            if (theme) themes.push(theme);
          } catch { continue; }
        }
      } catch { continue; }
    } else {
      try {
        const pkgDir = realpathSync(join(nodeModulesDir, entry));
        const theme = tryLoadTheme(entry, pkgDir);
        if (theme) themes.push(theme);
      } catch { continue; }
    }
  }

  return themes;
}

/**
 * Try to load a theme from a package directory.
 * First checks package.json keywords for ["typecho", "theme"],
 * then looks for theme.json or package.json.typecho.theme for manifest.
 */
function tryLoadTheme(packageName: string, packageDir: string): DiscoveredTheme | null {
  const pkgJsonPath = join(packageDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return null;

  let pkgJson: Record<string, any>;
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  } catch {
    return null;
  }

  // Gate: keywords must contain both "typecho" and "theme"
  if (!isTypechoTheme(pkgJson.keywords)) return null;

  // Try theme.json first
  const manifestPath = join(packageDir, 'theme.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      return buildTheme(packageName, packageDir, manifest);
    } catch (err) {
      console.warn(`[theme-loader] Failed to parse theme.json from ${packageName}:`, err);
      return null;
    }
  }

  // Fallback: package.json with typecho.theme field
  if (pkgJson.typecho?.theme) {
    const manifest = pkgJson.typecho.theme;
    return buildTheme(packageName, packageDir, manifest);
  }

  // Fallback: construct manifest from package.json fields
  const manifest: Record<string, any> = {
    name: pkgJson.name || packageName,
    description: pkgJson.description || '',
    author: typeof pkgJson.author === 'string' ? pkgJson.author : pkgJson.author?.name || '',
    version: pkgJson.version || '0.0.0',
  };
  return buildTheme(packageName, packageDir, manifest);
}

function buildTheme(packageName: string, packageDir: string, manifest: Record<string, any>): DiscoveredTheme | null {
  const id = deriveThemeId(packageName, manifest);
  const cssFile = manifest.stylesheet || 'style.css';
  const cssPath = join(packageDir, cssFile);

  if (!existsSync(cssPath)) {
    console.warn(`[theme-loader] Theme ${packageName}: CSS file ${cssFile} not found, skipping.`);
    return null;
  }

  // Scan for Astro template components
  const components = scanThemeComponents(packageDir);

  return {
    id,
    packageName,
    packageDir,
    manifest: { ...manifest, id },
    cssFile,
    screenshotFile: findScreenshot(packageDir, manifest.screenshot),
    components,
  };
}

/**
 * Scan a theme's components/ directory for Astro template files.
 * Returns a map like { Index: '/abs/path/to/Index.astro', Post: '...' }
 */
function scanThemeComponents(packageDir: string): Record<string, string> {
  const compsDir = join(packageDir, 'components');
  const result: Record<string, string> = {};

  if (!existsSync(compsDir) || !statSync(compsDir).isDirectory()) return result;

  for (const type of TEMPLATE_TYPES) {
    const filePath = join(compsDir, `${type}.astro`);
    if (existsSync(filePath)) {
      result[type] = filePath;
    }
  }

  return result;
}

function findScreenshot(packageDir: string, configuredScreenshot?: string): string | undefined {
  if (configuredScreenshot) {
    const path = join(packageDir, configuredScreenshot);
    if (existsSync(path)) return configuredScreenshot;
  }

  // Try common screenshot filenames
  for (const name of ['screenshot.png', 'screenshot.jpg', 'screenshot.webp', 'preview.png', 'preview.jpg']) {
    if (existsSync(join(packageDir, name))) return name;
  }

  return undefined;
}

function copyThemeAssets(theme: DiscoveredTheme, publicDir: string): void {
  const themePublicDir = join(publicDir, 'themes', theme.id);
  mkdirSync(themePublicDir, { recursive: true });

  // Copy main CSS
  const srcCss = join(theme.packageDir, theme.cssFile);
  cpSync(srcCss, join(themePublicDir, 'style.css'));

  // Copy screenshot if exists
  if (theme.screenshotFile) {
    const srcScreenshot = join(theme.packageDir, theme.screenshotFile);
    const ext = theme.screenshotFile.split('.').pop() || 'png';
    cpSync(srcScreenshot, join(themePublicDir, `screenshot.${ext}`));
  }

  // Copy additional stylesheets if specified
  if (theme.manifest.stylesheets && Array.isArray(theme.manifest.stylesheets)) {
    for (const extra of theme.manifest.stylesheets) {
      const srcExtra = join(theme.packageDir, extra);
      if (existsSync(srcExtra)) {
        cpSync(srcExtra, join(themePublicDir, extra));
      }
    }
  }

  // Copy assets directory if exists
  const assetsDir = join(theme.packageDir, 'assets');
  if (existsSync(assetsDir) && statSync(assetsDir).isDirectory()) {
    cpSync(assetsDir, join(themePublicDir, 'assets'), { recursive: true });
  }
}

/**
 * Capitalize first letter of a string for use as a JS variable name.
 */
function capitalize(s: string): string {
  // Replace non-alphanumeric chars with underscores, then capitalize
  const safe = s.replace(/[^a-zA-Z0-9]/g, '_');
  return safe.charAt(0).toUpperCase() + safe.slice(1);
}

/**
 * Generate the virtual module source code for `virtual:theme-templates`.
 * This is a build-time generated module that maps theme IDs to their Astro components.
 */
function generateVirtualModule(discoveredThemes: DiscoveredTheme[]): string {
  const imports: string[] = [];
  const entries: string[] = [];

  // All themes (including default) are discovered via npm packages
  for (const theme of discoveredThemes) {
    const compEntries: string[] = [];
    for (const type of TEMPLATE_TYPES) {
      if (theme.components[type]) {
        const varName = `${capitalize(theme.id)}${type}`;
        // Use the npm package path so Vite can resolve it properly
        imports.push(`import ${varName} from '${theme.packageName}/components/${type}.astro';`);
        compEntries.push(`${type}: ${varName}`);
      }
    }
    if (compEntries.length > 0) {
      entries.push(`  '${theme.id}': { ${compEntries.join(', ')} }`);
    }
  }

  return `${imports.join('\n')}

export const themeTemplates = {
${entries.join(',\n')}
};
`;
}

export default function themeLoaderIntegration(): AstroIntegration {
  let discoveredThemes: DiscoveredTheme[] = [];

  return {
    name: 'typecho-theme-loader',
    hooks: {
      'astro:config:setup': ({ config, updateConfig, injectScript }) => {
        const rootDir = config.root ? config.root.pathname.replace(/^\/([A-Z]:)/, '$1') : process.cwd();
        const publicDir = join(rootDir, 'public');

        // Discover themes
        discoveredThemes = discoverThemes(rootDir);

        if (discoveredThemes.length > 0) {
          console.log(`[theme-loader] Discovered ${discoveredThemes.length} theme(s):`);
          for (const theme of discoveredThemes) {
            const compCount = Object.keys(theme.components).length;
            console.log(`  - ${theme.manifest.name || theme.id} (${theme.packageName}) [${compCount} component(s)]`);
            // Copy theme assets to public directory
            copyThemeAssets(theme, publicDir);
          }
        } else {
          console.log('[theme-loader] No npm themes found. Only the built-in default theme is available.');
        }

        // Generate virtual module source
        const virtualModuleCode = generateVirtualModule(discoveredThemes);

        // Add Vite plugin for the virtual module
        updateConfig({
          vite: {
            plugins: [{
              name: 'typecho-theme-templates',
              resolveId(id: string) {
                if (id === 'virtual:theme-templates') return '\0virtual:theme-templates';
              },
              load(id: string) {
                if (id === '\0virtual:theme-templates') return virtualModuleCode;
              },
            }],
          },
        });

        // Inject theme registration script that runs on server startup
        // This registers all discovered themes into the theme registry
        if (discoveredThemes.length > 0) {
          const registrations = discoveredThemes.map((theme) => {
            const manifest = JSON.stringify(theme.manifest);
            const cssPath = `/themes/${theme.id}/style.css`;
            return `registerTheme(${JSON.stringify(theme.packageName)}, ${manifest}, ${JSON.stringify(cssPath)});`;
          }).join('\n');

          injectScript(
            'page-ssr',
            `import { registerTheme } from '@/lib/theme';\n${registrations}`
          );
        }
      },

      'astro:build:done': () => {
        if (discoveredThemes.length > 0) {
          console.log(`[theme-loader] Build complete. ${discoveredThemes.length} theme(s) bundled.`);
        }
      },
    },
  };
}
