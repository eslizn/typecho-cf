import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import themeLoader from './src/integrations/theme-loader.ts';
import pluginLoader from './src/integrations/plugin-loader.ts';
import { sharedAliases } from './vite.shared.mjs';

const isBuild = process.argv.includes('build');

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    imageService: 'passthrough',
    inspectorPort: isBuild ? false : undefined,
  }),
  security: {
    checkOrigin: true,
  },
  integrations: [themeLoader(), pluginLoader()],
  vite: {
    resolve: {
      alias: sharedAliases,
    },
  },
});
