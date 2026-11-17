/**
 * Vitest global setup — makes Cloudflare APIs available in test environment
 */

import { caches, _resetCaches } from './__mocks__/cloudflare-workers';
import { beforeEach } from 'vitest';
import { resetCacheVersionMemo } from '@/lib/cache';
import { resetOptionsSnapshot } from '@/lib/options';
import { resetOptionsSnapshotGeneration } from '@/lib/options-snapshot-generation';
import { resetSidebarSnapshots } from '@/lib/sidebar';
import { resetPluginInitState } from '@/lib/plugin';
import { resetCommentRootCountCache } from '@/lib/comment-page';
import { resetArchiveCountCache } from '@/lib/page-data';

// @ts-expect-error - Make caches global for tests
globalThis.caches = caches;

// Reset cache before each test to prevent cross-test pollution
beforeEach(() => {
  _resetCaches();
  resetCacheVersionMemo();
  resetOptionsSnapshot();
  resetOptionsSnapshotGeneration();
  resetSidebarSnapshots();
  resetPluginInitState();
  resetCommentRootCountCache();
  resetArchiveCountCache();
});
