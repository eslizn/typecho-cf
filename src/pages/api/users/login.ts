import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { verifyPassword, generateAuthToken, setAuthCookieHeaders, generateRandomString } from '@/lib/auth';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const db = getDb(env.DB);
  const options = await loadOptions(db);

  const formData = await request.formData();
  const name = formData.get('name')?.toString() || '';
  const password = formData.get('password')?.toString() || '';
  // Prevent open redirect: only allow relative paths starting with /
  let referer = formData.get('referer')?.toString() || '/admin/';
  if (!referer.startsWith('/') || referer.startsWith('//')) {
    referer = '/admin/';
  }
  const remember = formData.get('remember')?.toString() === '1';

  if (!name) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/login?error=' + encodeURIComponent('请输入用户名') },
    });
  }

  if (!password) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/login?error=' + encodeURIComponent('请输入密码') },
    });
  }

  // Find user by name
  const user = await db.query.users.findFirst({
    where: eq(schema.users.name, name),
  });

  if (!user) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/login?error=' + encodeURIComponent('用户名或密码无效') },
    });
  }

  // Verify password
  const valid = await verifyPassword(password, user.password || '');
  if (valid === 'needs_reset') {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/login?error=' + encodeURIComponent('密码格式已升级，请使用忘记密码功能重置密码') },
    });
  }
  if (valid !== true) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/login?error=' + encodeURIComponent('用户名或密码无效') },
    });
  }

  // Update authCode
  const newAuthCode = generateRandomString(32);
  await db
    .update(schema.users)
    .set({
      authCode: newAuthCode,
      logged: Math.floor(Date.now() / 1000),
    })
    .where(eq(schema.users.uid, user.uid));

  // Generate auth token
  const hash = await generateAuthToken(user.uid, newAuthCode, options.secret);
  const token = hash.split(':')[1]; // Just the hash part
  // remember: 30 days; otherwise session cookie (maxAge=0 means no Max-Age → session)
  const cookieHeaders = setAuthCookieHeaders(user.uid, token, remember ? 30 * 24 * 3600 : 0);

  const headers = new Headers();
  headers.set('Location', referer);
  for (const cookie of cookieHeaders) {
    headers.append('Set-Cookie', cookie);
  }

  return new Response(null, {
    status: 302,
    headers,
  });
};
