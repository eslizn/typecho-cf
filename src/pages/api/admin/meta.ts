import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { getAuthCookies, validateAuthToken, hasPermission } from '@/lib/auth';
import { generateSlug } from '@/lib/content';
import { eq, and, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = handler;

// GET only for reading (JSON list for autocomplete), never for state changes
export const GET: APIRoute = async ({ request, locals, url }) => {
  const db = getDb(env.DB);
  const options = await loadOptions(db);

  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);
  if (!token || !options.secret) return new Response('Unauthorized', { status: 401 });

  const auth = await validateAuthToken(token, options.secret, db);
  if (!auth || !hasPermission(auth.user.group || 'visitor', 'editor')) {
    return new Response('Forbidden', { status: 403 });
  }

  const type = url.searchParams.get('type') || 'category';

  // Return JSON list of metas (used for tag autocomplete)
  const metas = await db.select({ mid: schema.metas.mid, name: schema.metas.name, slug: schema.metas.slug, count: schema.metas.count })
    .from(schema.metas)
    .where(eq(schema.metas.type, type))
    .orderBy(schema.metas.name);
  return new Response(JSON.stringify(metas), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const db = getDb(env.DB);
  const options = await loadOptions(db);

  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);
  if (!token || !options.secret) return new Response('Unauthorized', { status: 401 });

  const auth = await validateAuthToken(token, options.secret, db);
  if (!auth || !hasPermission(auth.user.group || 'visitor', 'editor')) {
    return new Response('Forbidden', { status: 403 });
  }

  const formData = await request.formData();
  const action = formData.get('action')?.toString() || url.searchParams.get('action') || '';
  const type = formData.get('type')?.toString() || url.searchParams.get('type') || 'category';
  const mid = parseInt(formData.get('mid')?.toString() || '0', 10);
  const name = formData.get('name')?.toString()?.trim() || '';
  const slug = formData.get('slug')?.toString()?.trim() || '';
  const description = formData.get('description')?.toString()?.trim() || '';
  const mids = formData.getAll('mid[]').map((v: any) => parseInt(v.toString(), 10)).filter(Boolean);

  const redirectTo = type === 'tag' ? '/admin/manage-tags' : '/admin/manage-categories';

  if (action === 'create') {
    if (!name) return new Response('名称不能为空', { status: 400 });
    const finalSlug = slug || generateSlug(name) || name.toLowerCase().replace(/\s+/g, '-');

    await db.insert(schema.metas).values({
      name,
      slug: finalSlug,
      type,
      description: description || null,
      count: 0,
      order: 0,
    });

    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }

  if (action === 'update' && mid) {
    if (!name) return new Response('名称不能为空', { status: 400 });
    const finalSlug = slug || generateSlug(name) || name.toLowerCase().replace(/\s+/g, '-');

    await db.update(schema.metas).set({
      name,
      slug: finalSlug,
      description: description || null,
    }).where(eq(schema.metas.mid, mid));

    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }

  if (action === 'delete') {
    // Support batch delete (mid[] from form) or single delete (mid from query)
    const deleteIds = mids.length > 0 ? mids : (mid ? [mid] : []);
    if (deleteIds.length === 0) {
      return new Response(null, { status: 302, headers: { Location: redirectTo } });
    }

    for (const id of deleteIds) {
      await db.delete(schema.relationships).where(eq(schema.relationships.mid, id));
      await db.delete(schema.metas).where(eq(schema.metas.mid, id));
    }

    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }

  if (action === 'default' && mid && type === 'category') {
    // Set as default category (save to options)
    const { setOption } = await import('@/lib/options');
    await setOption(db, 'defaultCategory', String(mid));
    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }

  if (action === 'refresh') {
    // Refresh meta counts by recalculating from relationships
    // If specific mids are provided (batch), only refresh those; otherwise refresh all of the type
    let metas;
    const refreshIds = mids.length > 0 ? mids : [];
    if (refreshIds.length > 0) {
      metas = await db.select().from(schema.metas)
        .where(sql`${schema.metas.mid} IN (${sql.join(refreshIds.map(id => sql`${id}`), sql`, `)})`);
    } else if (type) {
      metas = await db.select().from(schema.metas).where(eq(schema.metas.type, type));
    } else {
      metas = await db.select().from(schema.metas);
    }

    for (const meta of metas) {
      const countResult = await db.select({ count: sql<number>`count(*)` })
        .from(schema.relationships)
        .where(eq(schema.relationships.mid, meta.mid));
      const realCount = countResult[0]?.count || 0;

      await db.update(schema.metas)
        .set({ count: realCount })
        .where(eq(schema.metas.mid, meta.mid));
    }

    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }

  return new Response('Invalid action', { status: 400 });
}
