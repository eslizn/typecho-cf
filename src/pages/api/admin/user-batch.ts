import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
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
    const referer = request.headers.get('referer') || '/admin/manage-users';
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

  if (action === 'delete') {
    for (const uid of uids) {
      // Never allow deleting self
      if (uid === auth.uid) continue;

      const targetUser = await auth.db.query.users.findFirst({
        where: eq(schema.users.uid, uid),
      });
      if (!targetUser) continue;
      if (targetUser.group === 'administrator') {
        const adminCount = await auth.db.select({ count: sql<number>`count(*)` })
          .from(schema.users)
          .where(eq(schema.users.group, 'administrator'));
        if ((adminCount[0]?.count || 0) <= 1) continue;
      }

      // Re-assign content and comments to current admin user
      await auth.db.update(schema.contents)
        .set({ authorId: auth.uid })
        .where(eq(schema.contents.authorId, uid));
      await auth.db.update(schema.comments)
        .set({ authorId: auth.uid })
        .where(eq(schema.comments.authorId, uid));

      // Delete user
      await auth.db.delete(schema.users).where(eq(schema.users.uid, uid));
    }
  }

  const referer = request.headers.get('referer') || '/admin/manage-users';
  return new Response(null, { status: 302, headers: { Location: referer } });
}
