import { getViteConfig } from 'astro/config';
import path from 'node:path';

/**
 * Render tests for `.astro` templates.
 *
 * The default Vitest project (vitest.config.ts) runs plain TypeScript with no
 * Astro pipeline, so it cannot import `.astro` files. This project loads the
 * Astro Vite plugins (thus the project's aliases, virtual theme/plugin
 * registries and `cloudflare:workers` mock) and renders components through the
 * Container API instead of grepping their source.
 *
 * Run with `pnpm run test:astro`; CI runs both projects.
 */
export default getViteConfig(
  {
    test: {
      name: 'astro-templates',
      environment: 'node',
      globals: true,
      include: ['tests/astro/**/*.test.ts'],
    },
    resolve: {
      alias: {
        // The same stubs the unit tests use, so templates that touch the Workers
        // runtime (R2 bindings, caches) can render in Node.
        'cloudflare:workers': path.resolve(__dirname, './tests/__mocks__/cloudflare-workers.ts'),
        'astro:middleware': path.resolve(__dirname, './tests/__mocks__/astro-middleware.ts'),
        'virtual:typecho-plugin-registry': path.resolve(__dirname, './tests/__mocks__/plugin-registry.ts'),
        'virtual:typecho-theme-registry': path.resolve(__dirname, './tests/__mocks__/theme-registry.ts'),
        'virtual:theme-templates': path.resolve(__dirname, './tests/__mocks__/theme-templates.ts'),
      },
    },
  },
  {
    // Deliberately not the project's astro.config.mjs: its Cloudflare adapter
    // boots workerd, which a Node render test neither needs nor supports. The
    // build-time integrations are replaced by the module aliases above.
    configFile: false,
    output: 'server',
  },
);
