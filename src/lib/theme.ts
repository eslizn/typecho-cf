/**
 * Theme system - discovers and manages themes from npm packages
 * 
 * Theme packages are identified by their package.json keywords
 * containing both "typecho" and "theme".
 * 
 * Theme package structure:
 *   typecho-theme-example/
 *     theme.json        - Theme metadata (required)
 *     style.css         - Main stylesheet (required)
 *     screenshot.png    - Theme preview image (optional)
 *     assets/           - Additional assets (optional)
 */

export interface ThemeManifest {
  /** Unique theme identifier */
  id: string;
  /** Display name */
  name: string;
  /** Theme description */
  description?: string;
  /** Author name */
  author?: string;
  /** Author URL */
  authorUrl?: string;
  /** Theme version */
  version?: string;
  /** Screenshot filename (relative to package root) */
  screenshot?: string;
  /** Main CSS file (relative to package root), defaults to 'style.css' */
  stylesheet?: string;
  /** Additional CSS files */
  stylesheets?: string[];
  /** Theme homepage / repository URL */
  homepage?: string;
  /** License */
  license?: string;
  /** Tags for categorization */
  tags?: string[];
}

export interface ThemeInfo {
  /** Theme ID (slug) */
  id: string;
  /** npm package name */
  packageName: string;
  /** Theme manifest from theme.json */
  manifest: ThemeManifest;
  /** Whether this is the built-in default theme */
  isDefault: boolean;
  /** Whether this theme is currently active */
  isActive: boolean;
  /** Resolved CSS content (for serving) */
  cssPath: string;
}

/** Built-in fallback theme definition (when no themes are discovered) */
const FALLBACK_THEME: ThemeManifest = {
  id: 'typecho-theme-minimal',
  name: 'Typecho Minimal',
  description: '经典的 Typecho 默认主题，简洁优雅。',
  author: 'Typecho Team',
  authorUrl: 'https://typecho.org/',
  version: '1.0.0',
  stylesheet: '/themes/typecho-theme-minimal/style.css',
  license: 'GPL-2.0',
};

/**
 * Registry of all discovered themes
 * Key: theme ID (slug), Value: ThemeInfo
 * 
 * This is populated at build time by the theme-loader integration.
 * Themes are npm packages whose keywords contain both "typecho" and "theme".
 * The default theme is also discovered this way (typecho-theme-minimal package).
 */
const themeRegistry = new Map<string, ThemeInfo>();

/**
 * Discover and register themes from npm packages.
 * 
 * Theme discovery happens at BUILD TIME via the theme-loader integration.
 * The discovered themes are compiled into the bundle as a static registry.
 * In Cloudflare Workers runtime, we can't access the filesystem.
 */

// Theme CSS is served from /themes/{id}/style.css
// We use a virtual module pattern to bundle theme CSS at build time.

/**
 * Get all available themes (including the built-in default)
 */
export function getAvailableThemes(activeThemeId: string): ThemeInfo[] {
  const themes: ThemeInfo[] = [];

  // All themes come from the registry (including default)
  for (const [id, info] of themeRegistry) {
    themes.push({
      ...info,
      isActive: activeThemeId === id,
    });
  }

  // If no themes were discovered, add a fallback
  if (themes.length === 0) {
    themes.push({
      id: 'typecho-theme-minimal',
      packageName: 'built-in',
      manifest: FALLBACK_THEME,
      isDefault: true,
      isActive: true,
      cssPath: '/themes/typecho-theme-minimal/style.css',
    });
  }

  return themes;
}

/**
 * Get the active theme info
 */
export function getActiveTheme(activeThemeId: string): ThemeInfo {
  const theme = themeRegistry.get(activeThemeId);
  if (theme) {
    return { ...theme, isActive: true };
  }

  // Fallback to default theme from registry
  const defaultTheme = themeRegistry.get('typecho-theme-minimal');
  if (defaultTheme) {
    return { ...defaultTheme, isActive: true };
  }

  // Ultimate fallback if no themes discovered at all
  return {
    id: 'typecho-theme-minimal',
    packageName: 'built-in',
    manifest: FALLBACK_THEME,
    isDefault: true,
    isActive: true,
    cssPath: '/themes/typecho-theme-minimal/style.css',
  };
}

/**
 * Register an npm theme into the registry.
 * Called by the theme loader integration at build time.
 */
export function registerTheme(
  packageName: string,
  manifest: ThemeManifest,
  cssPath: string,
): void {
  const id = manifest.id || packageName;
  themeRegistry.set(id, {
    id,
    packageName,
    manifest: { ...manifest, id },
    isDefault: false,
    isActive: false,
    cssPath,
  });
}

/**
 * Get the CSS path(s) for a theme
 * Order: stylesheets (base CSS like normalize/grid) → main stylesheet
 */
export function getThemeStylesheets(activeThemeId: string): string[] {
  const theme = getActiveTheme(activeThemeId);
  const sheets: string[] = [];

  // Additional stylesheets first (e.g. normalize.css, grid.css)
  if (theme.manifest.stylesheets) {
    for (const extra of theme.manifest.stylesheets) {
      sheets.push(extra.startsWith('/') ? extra : `/themes/${theme.id}/${extra}`);
    }
  }

  // Main stylesheet last
  sheets.push(theme.cssPath);

  return sheets;
}

/**
 * Check if a theme exists
 */
export function themeExists(themeId: string): boolean {
  return themeRegistry.has(themeId);
}

/**
 * Get theme count
 */
export function getThemeCount(): number {
  return themeRegistry.size;
}
