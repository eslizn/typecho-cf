import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/lib/**/*.ts', 'src/pages/api/**/*.ts', 'src/plugins/**/*.ts'],
    },
    // Clear cache between tests to avoid cross-test pollution
    env: {
      VITEST: 'true',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Stub Cloudflare-specific modules not available in Node.js test env
      'cloudflare:workers': path.resolve(__dirname, './tests/__mocks__/cloudflare-workers.ts'),
    },
  },
});
