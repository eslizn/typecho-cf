import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const sharedAliases = {
  'typecho/plugin-sdk': resolve(__dirname, 'src/lib/plugin-sdk.ts'),
  'typecho/db': resolve(__dirname, 'src/db/index.ts'),
};
