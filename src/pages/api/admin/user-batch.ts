import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
import { eq, sql } from 'drizzle-orm';

export const POST: APIRoute = handler;

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) return auth;

  const action = url.searchParams.get('do') || '';
  if (action !== 'delete') return new Response('Invalid action', { status: 400 });

  // Get selected uids from form body
  let uids: number[] = [];
  if (request.method === 'POST') {
    const formData = await request.formData();
    uids = formData.getAll('uid[]').map(v => parseInt(v.toString(), 10)).filter(Boolean);
  }

  if (uids.length === 0) {
    const referer = safeAdminRedirectUrl(
      request.headers.get('referer'),
      auth.options.siteUrl || '',
      '/admin/manage-users',
    );
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

  if (action === 'delete') {
    // G4-2: collect all candidate users in one query, plus a single
    // administrator-count check; only then run the writes.
    const candidates = await auth.db.select().from(schema.users)
      .where(sql`${schema.users.uid} IN (${sql.join(uids.map(id => sql`${id}`), sql`, `)})`);

    const adminCountResult = await auth.db.select({ count: sql<number>`count(*)` })
      .from(schema.users)
      .where(eq(schema.users.group, 'administrator'));
    let remainingAdmins = adminCountResult[0]?.count || 0;

    const targets: number[] = [];
    for (const targetUser of candidates) {
      if (targetUser.uid === auth.uid) continue; // never delete self
      if (targetUser.group === 'administrator') {
        if (remainingAdmins <= 1) continue;
        remainingAdmins -= 1;
      }
      targets.push(targetUser.uid);
    }

    if (targets.length > 0) {
      const idList = sql.join(targets.map(id => sql`${id}`), sql`, `);
      await auth.db.update(schema.contents)
        .set({ authorId: auth.uid })
        .where(sql`${schema.contents.authorId} IN (${idList})`);
      await auth.db.update(schema.comments)
        .set({ authorId: auth.uid })
        .where(sql`${schema.comments.authorId} IN (${idList})`);
      await auth.db.delete(schema.users).where(sql`${schema.users.uid} IN (${idList})`);
    }
  }

  const referer = safeAdminRedirectUrl(
    request.headers.get('referer'),
    auth.options.siteUrl || '',
    '/admin/manage-users',
  );
  return new Response(null, { status: 302, headers: { Location: referer } });
}
