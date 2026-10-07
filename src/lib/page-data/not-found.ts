import type { RequestContext } from '@/lib/context';
import type { ThemeNotFoundProps } from '@/lib/theme-props';
import { getRequestI18n, loadCommon } from './common';

// ─── 404 Not Found ──────────────────────────────────────────────────────

export async function prepareNotFoundData(
  ctx: RequestContext,
  requestUrl: string,
): Promise<ThemeNotFoundProps> {
  // 404 responses skip the sidebar widget queries (recent posts/comments,
  // categories, monthly archives) — error pages render chrome from the nav
  // pages only, so bot storms on dead URLs don't rebuild sidebar snapshots.
  const common = await loadCommon(ctx, requestUrl, false);
  return {
    ...common,
    statusCode: 404,
    errorTitle: getRequestI18n(ctx).t('core.error.notFoundTitle', {}, '404 - Page not found'),
  };
}
