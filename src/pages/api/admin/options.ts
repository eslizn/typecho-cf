import type { APIRoute } from 'astro';
import { setOption } from '@/lib/options';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { bumpCacheVersion, purgeSiteCache } from '@/lib/cache';

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) return auth;

  const formData = await request.formData();

  // Save each option
  const optionKeys = [
    'title', 'description', 'keywords', 'siteUrl', 'timezone',
    'allowRegister', 'pageSize', 'postsListSize', 'commentsListSize',
    'defaultAllowComment', 'defaultAllowPing', 'defaultAllowFeed',
    'feedFullText', 'markdown', 'postDateFormat', 'commentDateFormat',
    'commentsRequireMail', 'commentsRequireURL', 'commentsRequireModeration',
    'commentsWhitelist', 'commentsMaxNestingLevels',
    'commentsUrlNofollow', 'commentsShowUrl', 'commentsMarkdown',
    'commentsPageBreak', 'commentsThreaded', 'commentsPageSize',
    'commentsPageDisplay', 'commentsOrder', 'commentsCheckReferer',
    'commentsAutoClose', 'commentsPostIntervalEnable',
    'commentsAntiSpam', 'commentsHTMLTagAllowed', 'commentsAvatar',
    'commentsAvatarRating', 'commentsShowCommentOnly',
    'frontPage', 'frontArchive', 'attachmentTypes',
    'editorSize', 'cacheEnabled',
  ];

  // Handle permalinkPattern specially: if "custom" is selected, use customPattern value
  const permalinkValue = formData.get('permalinkPattern');
  if (permalinkValue !== null) {
    let pattern = permalinkValue.toString();
    if (pattern === 'custom') {
      const customPattern = formData.get('customPattern');
      pattern = customPattern?.toString().trim() || '/archives/{cid}/';
    }
    await setOption(auth.db, 'permalinkPattern', pattern);
  }

  // Handle pagePattern — direct text input, save as-is
  const pagePatternValue = formData.get('pagePattern');
  if (pagePatternValue !== null) {
    const pattern = pagePatternValue.toString().trim() || '/{slug}.html';
    await setOption(auth.db, 'pagePattern', pattern);
  }

  // Handle categoryPattern — direct text input, save as-is
  const categoryPatternValue = formData.get('categoryPattern');
  if (categoryPatternValue !== null) {
    const pattern = categoryPatternValue.toString().trim() || '/category/{slug}/';
    await setOption(auth.db, 'categoryPattern', pattern);
  }

  for (const key of optionKeys) {
    const value = formData.get(key);
    if (value !== null) {
      await setOption(auth.db, key, value.toString());
    }
  }

  // Handle commentsPostTimeout: form sends days, store as seconds (Typecho convention)
  const postTimeoutDays = formData.get('commentsPostTimeout');
  if (postTimeoutDays !== null) {
    const days = parseInt(postTimeoutDays.toString(), 10) || 14;
    await setOption(auth.db, 'commentsPostTimeout', String(days * 24 * 3600));
  }

  // Handle commentsPostInterval: form sends minutes, store as seconds (Typecho convention)
  const postIntervalMinutes = formData.get('commentsPostInterval');
  if (postIntervalMinutes !== null) {
    const minutes = parseInt(postIntervalMinutes.toString(), 10) || 1;
    await setOption(auth.db, 'commentsPostInterval', String(minutes * 60));
  }

  const referer = request.headers.get('referer') || '/admin/options-general';

  // Handle checkbox fields that may not be present (unchecked checkboxes aren't sent in form data)
  // IMPORTANT: Only process checkboxes belonging to the current page to avoid
  // clearing checkboxes from other settings pages (each page submits to this same endpoint)
  const refererPath = new URL(referer, 'http://localhost').pathname;

  const checkboxFieldsByPage: Record<string, string[]> = {
    '/admin/options-general': [
      'allowRegister', 'cacheEnabled',
    ],
    '/admin/options-discussion': [
      'commentsShowCommentOnly', 'commentsAvatar', 'commentsShowUrl',
      'commentsMarkdown', 'commentsUrlNofollow',
      'commentsRequireMail', 'commentsRequireURL', 'commentsCheckReferer', 'commentsAntiSpam',
      'commentsRequireModeration', 'commentsWhitelist', 'commentsAutoClose',
      'commentsThreaded', 'commentsPageBreak', 'commentsPostIntervalEnable',
    ],
    '/admin/options-reading': [
      'feedFullText', 'markdown',
    ],
  };

  // Determine which page this submission came from
  const pageCheckboxes = Object.entries(checkboxFieldsByPage)
    .find(([page]) => refererPath.startsWith(page));
  
  if (pageCheckboxes) {
    for (const key of pageCheckboxes[1]) {
      if (!formData.has(key)) {
        await setOption(auth.db, key, '0');
      }
    }
  }

  await bumpCacheVersion(auth.db);
  await purgeSiteCache(auth.options.siteUrl || '');

  return new Response(null, {
    status: 302,
    headers: { Location: referer },
  });
};
