import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { hashPassword, generateRandomString } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { normalizeHttpUrl } from '@/lib/url';
import { and, eq, ne, sql } from 'drizzle-orm';

async function countAdministrators(db: ReturnType<typeof getDb>): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)` })
    .from(schema.users)
    .where(eq(schema.users.group, 'administrator'));
  return rows[0]?.count || 0;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) return auth;
  const db = auth.db;

  const formData = await request.formData();
  const action = formData.get('do')?.toString() || 'create';
  const uid = parseInt(formData.get('uid')?.toString() || '0', 10);
  const name = formData.get('name')?.toString()?.trim() || '';
  const mail = formData.get('mail')?.toString()?.trim() || '';
  const screenName = formData.get('screenName')?.toString()?.trim() || '';
  const url = formData.get('url')?.toString()?.trim() || '';
  const groupInput = formData.get('group')?.toString() || 'subscriber';
  const VALID_GROUPS = ['administrator', 'editor', 'contributor', 'subscriber'];
  const group = VALID_GROUPS.includes(groupInput) ? groupInput : 'subscriber';
  const password = formData.get('password')?.toString() || '';
  const confirm = formData.get('confirm')?.toString() || '';

  if (action === 'create') {
    if (!name || !mail || !password) {
      return new Response('请填写完整信息', { status: 400 });
    }
    if (password.length < 6) {
      return new Response('密码长度至少6位', { status: 400 });
    }
    if (password !== confirm) {
      return new Response('两次输入的密码不一致', { status: 400 });
    }

    // Check if name exists
    const existingName = await db.query.users.findFirst({
      where: eq(schema.users.name, name),
    });
    if (existingName) {
      return new Response('用户名已被使用', { status: 409 });
    }

    // Check if mail exists
    const existingMail = await db.query.users.findFirst({
      where: eq(schema.users.mail, mail),
    });
    if (existingMail) {
      return new Response('邮箱已被使用', { status: 409 });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      return new Response('邮箱格式不正确', { status: 400 });
    }

    let normalizedUrl: string | null = null;
    if (url) {
      const parsed = normalizeHttpUrl(url);
      if (parsed === null) return new Response('个人主页地址格式不正确', { status: 400 });
      normalizedUrl = parsed;
    }

    const hashedPassword = await hashPassword(password);
    const authCode = generateRandomString(32);
    const now = Math.floor(Date.now() / 1000);

    await db.insert(schema.users).values({
      name,
      password: hashedPassword,
      mail,
      url: normalizedUrl,
      screenName: screenName || name,
      created: now,
      activated: now,
      logged: 0,
      group,
      authCode,
    });

    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/manage-users' },
    });
  }

  if (action === 'update' && uid) {
    const existing = await db.query.users.findFirst({
      where: eq(schema.users.uid, uid),
    });
    if (!existing) {
      return new Response('用户不存在', { status: 404 });
    }

    if (!mail) {
      return new Response('邮箱不能为空', { status: 400 });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      return new Response('邮箱格式不正确', { status: 400 });
    }

    const existingMail = await db.query.users.findFirst({
      where: and(eq(schema.users.mail, mail), ne(schema.users.uid, uid)),
    });
    if (existingMail) {
      return new Response('邮箱已被使用', { status: 409 });
    }

    if (existing.group === 'administrator' && group !== 'administrator' && await countAdministrators(db) <= 1) {
      return new Response('不能降级最后一个管理员', { status: 400 });
    }

    let normalizedUrl: string | null = null;
    if (url) {
      const parsed = normalizeHttpUrl(url);
      if (parsed === null) return new Response('个人主页地址格式不正确', { status: 400 });
      normalizedUrl = parsed;
    }

    const updateData: Record<string, unknown> = {
      mail,
      screenName: screenName || existing.name,
      url: normalizedUrl,
      group,
    };

    if (password) {
      if (password.length < 6) {
        return new Response('密码长度至少6位', { status: 400 });
      }
      if (password !== confirm) {
        return new Response('两次输入的密码不一致', { status: 400 });
      }
      updateData.password = await hashPassword(password);
    }

    await db.update(schema.users).set(updateData).where(eq(schema.users.uid, uid));

    return new Response(null, {
      status: 302,
      headers: { Location: `/admin/user?uid=${uid}` },
    });
  }

  return new Response('Invalid action', { status: 400 });
};
