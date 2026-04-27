import type { APIRoute } from 'astro';
import { getDb } from '@/db';
import { loadOptions, setOption } from '@/lib/options';
import { getAuthCookies, validateAuthToken, hasPermission, requireAdminCSRF } from '@/lib/auth';
import { purgeSiteCache } from '@/lib/cache';

import { env } from 'cloudflare:workers';

export const POST: APIRoute = async ({ request, locals }) => {
  const db = getDb(env.DB);
  const options = await loadOptions(db);

  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);
  if (!token || !options.secret) return new Response('Unauthorized', { status: 401 });

  const auth = await validateAuthToken(token, options.secret, db);
  if (!auth || !hasPermission(auth.user.group || 'visitor', 'administrator')) {
    return new Response('Forbidden', { status: 403 });
  }

  const csrfError = await requireAdminCSRF(request, options.secret as string, auth.user.authCode!, auth.uid);
  if (csrfError) return csrfError;

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
    await setOption(db, 'permalinkPattern', pattern);
  }

  // Handle pagePattern — direct text input, save as-is
  const pagePatternValue = formData.get('pagePattern');
  if (pagePatternValue !== null) {
    const pattern = pagePatternValue.toString().trim() || '/{slug}.html';
    await setOption(db, 'pagePattern', pattern);
  }

  // Handle categoryPattern — direct text input, save as-is
  const categoryPatternValue = formData.get('categoryPattern');
  if (categoryPatternValue !== null) {
    const pattern = categoryPatternValue.toString().trim() || '/category/{slug}/';
    await setOption(db, 'categoryPattern', pattern);
  }

  for (const key of optionKeys) {
    const value = formData.get(key);
    if (value !== null) {
      await setOption(db, key, value.toString());
    }
  }

  // Handle commentsPostTimeout: form sends days, store as seconds (Typecho convention)
  const postTimeoutDays = formData.get('commentsPostTimeout');
  if (postTimeoutDays !== null) {
    const days = parseInt(postTimeoutDays.toString(), 10) || 14;
    await setOption(db, 'commentsPostTimeout', String(days * 24 * 3600));
  }

  // Handle commentsPostInterval: form sends minutes, store as seconds (Typecho convention)
  const postIntervalMinutes = formData.get('commentsPostInterval');
  if (postIntervalMinutes !== null) {
    const minutes = parseInt(postIntervalMinutes.toString(), 10) || 1;
    await setOption(db, 'commentsPostInterval', String(minutes * 60));
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
        await setOption(db, key, '0');
      }
    }
  }

  await purgeSiteCache(options.siteUrl || '');

  return new Response(null, {
    status: 302,
    headers: { Location: referer },
  });
};
