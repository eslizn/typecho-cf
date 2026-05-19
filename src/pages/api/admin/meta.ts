import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { generateSlug } from '@/lib/content';
import { bumpCacheVersion, purgeSiteCache } from '@/lib/cache';
import { eq, and, sql } from 'drizzle-orm';

export const POST: APIRoute = handler;

// GET only for reading (JSON list for autocomplete), never for state changes
export const GET: APIRoute = async ({ request, locals, url }) => {
  const auth = await requireAdminAction(request, 'editor', { csrf: false });
  if (isAdminActionResponse(auth)) return auth;

  const type = url.searchParams.get('type') || 'category';

  // Return JSON list of metas (used for tag autocomplete)
  const metas = await auth.db.select({ mid: schema.metas.mid, name: schema.metas.name, slug: schema.metas.slug, count: schema.metas.count })
    .from(schema.metas)
    .where(eq(schema.metas.type, type))
    .orderBy(schema.metas.name);
  return new Response(JSON.stringify(metas), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const auth = await requireAdminAction(request, 'editor');
  if (isAdminActionResponse(auth)) return auth;
  const db = auth.db;
  const options = auth.options;

  const formData = await request.formData();
  const action = formData.get('action')?.toString() || url.searchParams.get('action') || '';
  const type = formData.get('type')?.toString() || url.searchParams.get('type') || 'category';
  const mid = parseInt(formData.get('mid')?.toString() || '0', 10);
  const name = formData.get('name')?.toString()?.trim() || '';
  const slug = formData.get('slug')?.toString()?.trim() || '';
  const description = formData.get('description')?.toString()?.trim() || '';
  const mids = formData.getAll('mid[]').map((v: any) => parseInt(v.toString(), 10)).filter(Boolean);

  if (type !== 'category' && type !== 'tag') {
    return new Response('Invalid meta type', { status: 400 });
  }

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

    await bumpCacheVersion(db);
    await purgeSiteCache(options.siteUrl || '');
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

    await bumpCacheVersion(db);
    await purgeSiteCache(options.siteUrl || '');
    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }

  if (action === 'delete') {
    // Support batch delete (mid[] from form) or single delete (mid from query)
    const deleteIds = mids.length > 0 ? mids : (mid ? [mid] : []);
    if (deleteIds.length === 0) {
      return new Response(null, { status: 302, headers: { Location: redirectTo } });
    }

    // G7-1: refuse to delete the default category or any category that
    // still has posts attached. Tags are unrestricted (no defaultTag,
    // and dropping a tag merely orphans relationships).
    if (type === 'category') {
      const defaultMid = parseInt(String(options.defaultCategory ?? '0'), 10);
      for (const id of deleteIds) {
        if (id === defaultMid) {
          return new Response('不能删除默认分类，请先指定其他分类为默认', { status: 400 });
        }
      }
      const used = await db.select({ mid: schema.relationships.mid })
        .from(schema.relationships)
        .where(sql`${schema.relationships.mid} IN (${sql.join(deleteIds.map(id => sql`${id}`), sql`, `)})`);
      if (used.length > 0) {
        const inUseSet = new Set(used.map(r => r.mid));
        const targets = deleteIds.filter(id => inUseSet.has(id));
        return new Response(`分类 #${targets.join(', #')} 下仍有文章，请先迁移内容`, { status: 400 });
      }
    }

    for (const id of deleteIds) {
      await db.delete(schema.relationships).where(eq(schema.relationships.mid, id));
      await db.delete(schema.metas).where(eq(schema.metas.mid, id));
    }

    await bumpCacheVersion(db);
    await purgeSiteCache(options.siteUrl || '');
    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }

  if (action === 'default' && mid && type === 'category') {
    // Set as default category (save to options)
    const { setOption } = await import('@/lib/options');
    await setOption(db, 'defaultCategory', String(mid));
    await bumpCacheVersion(db);
    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }

  if (action === 'refresh') {
    // G4-2: refresh meta counts using GROUP BY relationships in one query
    // rather than N+1 SELECT count(*) calls per meta row.
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

    if (metas.length > 0) {
      const midList = sql.join(metas.map(m => sql`${m.mid}`), sql`, `);
      const counts = await db
        .select({ mid: schema.relationships.mid, count: sql<number>`count(*)` })
        .from(schema.relationships)
        .where(sql`${schema.relationships.mid} IN (${midList})`)
        .groupBy(schema.relationships.mid);

      const countMap = new Map<number, number>();
      for (const row of counts) countMap.set(row.mid, row.count);

      for (const meta of metas) {
        const realCount = countMap.get(meta.mid) || 0;
        await db.update(schema.metas)
          .set({ count: realCount })
          .where(eq(schema.metas.mid, meta.mid));
      }
    }

    await bumpCacheVersion(db);
    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }

  return new Response('Invalid action', { status: 400 });
}
