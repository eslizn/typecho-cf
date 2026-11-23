import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import themeLoader from './src/integrations/theme-loader.ts';
import pluginLoader from './src/integrations/plugin-loader.ts';
import clientLoader from './src/integrations/client-loader.ts';
import { sharedAliases } from './vite.shared.mjs';
import { getQueueBuildConfigPath } from './scripts/queue-deployment.mjs';

const isBuild = process.argv.includes('build');
const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const configPath = getQueueBuildConfigPath(projectRoot);

export default defineConfig({
  session: false,
  output: 'server',
  adapter: cloudflare({
    configPath: configPath && relative(projectRoot, configPath),
    imageService: 'passthrough',
    inspectorPort: isBuild ? false : undefined,
  }),
  security: {
    checkOrigin: true,
  },
  integrations: [themeLoader(), pluginLoader(), clientLoader()],
  vite: {
    resolve: {
      alias: sharedAliases,
    },
  },
});
