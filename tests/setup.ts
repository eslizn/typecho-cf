/**
 * Vitest global setup — makes Cloudflare APIs available in test environment
 */

import { caches, _resetCaches } from './__mocks__/cloudflare-workers';
import { beforeEach } from 'vitest';

// @ts-ignore - Make caches global for tests
globalThis.caches = caches;

// Reset cache before each test to prevent cross-test pollution
beforeEach(() => {
  _resetCaches();
});
