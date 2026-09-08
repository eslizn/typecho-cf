/**
 * Astro integration: Client Loader
 *
 * Scans for TypeScript browser-side source files in:
 *   - src/client/*.ts          → compiled to public/js/
 *   - client/*.ts in a declared plugin package → compiled to
 *     public/plugin-assets/<id>/
 *
 * Uses esbuild to compile TypeScript to IIFE JavaScript, then copies
 * the output into public/ so Astro serves it as static files.
 *
 * Pattern matches theme-loader.ts: discover at build time, copy to public/,
 * no runtime overhead beyond <script src="...">.
 */
import type { AstroIntegration } from 'astro';
import { existsSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { discoverPlugins, type DiscoveredPlugin } from './plugin-loader';

interface ClientSource {
  sourcePath: string;
  outDir: string;
  /** URL path the browser will use, e.g. /js/typecho-editor.js */
  publicUrl: string;
}

/**
 * Discover core client sources under src/client/.
 */
function discoverCoreClients(rootDir: string): ClientSource[] {
  const srcDir = join(rootDir, 'src', 'client');
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) return [];

  const entries = readdirSync(srcDir);
  const sources: ClientSource[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.ts')) continue;
    const sourcePath = join(srcDir, entry);
    const jsName = entry.replace(/\.ts$/, '.js');
    sources.push({
      sourcePath,
      outDir: join(rootDir, 'public', 'js'),
      publicUrl: `/js/${jsName}`,
    });
  }
  return sources;
}

/**
 * Discover client sources only for plugins declared by the root package.json.
 */
export function discoverPluginClients(rootDir: string): ClientSource[] {
  const sources: ClientSource[] = [];
  const plugins: DiscoveredPlugin[] = discoverPlugins(rootDir);

  for (const plugin of plugins) {
    const clientDir = join(plugin.packageDir, 'client');
    if (!existsSync(clientDir) || !statSync(clientDir).isDirectory()) continue;

    const entries = readdirSync(clientDir);
    for (const entry of entries) {
      if (!entry.endsWith('.ts')) continue;
      const sourcePath = join(clientDir, entry);
      const jsName = entry.replace(/\.ts$/, '.js');
      const outDir = join(rootDir, 'public', 'plugin-assets', plugin.id);
      sources.push({
        sourcePath,
        outDir,
        publicUrl: `/plugin-assets/${plugin.id}/${jsName}`,
      });
    }
  }
  return sources;
}

async function compileAll(sources: ClientSource[], silent = false): Promise<void> {
  try {
    const esbuild = await import('esbuild');
    for (const src of sources) {
      mkdirSync(src.outDir, { recursive: true });
      const outfile = join(src.outDir, src.sourcePath.split('/').pop()!.replace(/\.ts$/, '.js'));
      await esbuild.build({
        entryPoints: [src.sourcePath],
        outfile,
        bundle: true,
        format: 'iife',
        target: 'es2020',
        minify: process.env.NODE_ENV === 'production',
        sourcemap: process.env.NODE_ENV !== 'production' ? 'inline' : false,
        logLevel: 'warning',
        // External: browser scripts must not bundle server-side modules
        external: ['cloudflare:*', 'typecho/*', '@/*', 'astro:*', 'node:*'],
      });
      if (!silent) {
        console.log(`[client-loader] ${src.sourcePath} → ${relative(process.cwd(), outfile)}`);
      }
    }
  } catch (err) {
    console.error('[client-loader] esbuild not available, skipping client compilation:', err);
  }
}

export default function clientLoaderIntegration(): AstroIntegration {
  let allSources: ClientSource[] = [];

  return {
    name: 'typecho-client-loader',
    hooks: {
      'astro:config:setup': async ({ config }) => {
        const rootDir = config.root
          ? config.root.pathname.replace(/^\/([A-Z]:)/, '$1')
          : process.cwd();

        allSources = [
          ...discoverCoreClients(rootDir),
          ...discoverPluginClients(rootDir),
        ];

        if (allSources.length > 0) {
          console.log(`[client-loader] Found ${allSources.length} client source(s)`);
          for (const src of allSources) {
            console.log(`  - ${relative(rootDir, src.sourcePath)} → ${src.publicUrl}`);
          }
          await compileAll(allSources);
        } else {
          console.log('[client-loader] No client sources found (src/client/ + declared plugin packages)');
        }
      },

      'astro:server:setup': async ({ server }) => {
        // Recompile on change in dev mode using Vite's existing watcher.
        const changed = new Set<string>();
        let timer: ReturnType<typeof setTimeout> | undefined;

        const schedule = () => {
          clearTimeout(timer);
          timer = setTimeout(async () => {
            const paths = [...changed];
            changed.clear();
            const affected = allSources.filter(s => paths.some(p => s.sourcePath === p));
            if (affected.length > 0) {
              console.log('[client-loader] Recompiling due to changes...');
              await compileAll(affected, true);
              console.log('[client-loader] Done. Refresh your browser.');
            }
          }, 300);
        };

        server.watcher.add(allSources.map(src => src.sourcePath));
        server.watcher.on('change', (path: string) => {
          if (allSources.some(src => src.sourcePath === path)) {
            changed.add(path);
            schedule();
          }
        });
      },

      'astro:build:done': async () => {
        if (allSources.length > 0) {
          console.log(`[client-loader] ${allSources.length} client file(s) bundled.`);
        }
      },
    },
  };
}
