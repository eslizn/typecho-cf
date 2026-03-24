/**
 * Theme management API
 * POST: Activate a theme
 */
import type { APIRoute } from 'astro';
import { getDb } from '@/db';
import { loadOptions, setOption } from '@/lib/options';
import { getAuthCookies, validateAuthToken, hasPermission } from '@/lib/auth';
import { themeExists } from '@/lib/theme';
import { env } from 'cloudflare:workers';

async function authenticate(request: Request) {
  const db = getDb(env.DB);
  const options = await loadOptions(db);
  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);

  if (!token || !options.secret) return null;

  const result = await validateAuthToken(token, options.secret, db);
  if (!result) return null;
  if (!hasPermission(result.user.group || 'visitor', 'administrator')) return null;

  return { db, user: result.user, options };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await authenticate(request);
  if (!auth) {
    return new Response(JSON.stringify({ error: '权限不足' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json() as { theme?: string };
    const themeId = body.theme;

    if (!themeId || typeof themeId !== 'string') {
      return new Response(JSON.stringify({ error: '请指定主题标识' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Verify the theme exists
    if (!themeExists(themeId)) {
      return new Response(JSON.stringify({ error: `主题 "${themeId}" 不存在，请先通过 npm 安装` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Save to options
    await setOption(auth.db, 'theme', themeId);

    return new Response(JSON.stringify({ 
      success: true, 
      message: `主题已切换为 "${themeId}"`,
      theme: themeId,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: '请求格式错误' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
