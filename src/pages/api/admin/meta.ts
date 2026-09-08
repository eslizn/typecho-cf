import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { isAdminActionResponse, jsonAdminActionError, requireAdminAction } from '@/lib/admin-auth';
import { resolveUniqueMetaSlug } from '@/lib/slug';
import { bumpCacheVersion, purgeSiteCache } from '@/lib/cache';
import { readAdminFormOrError } from '@/lib/input';
import { i18nMessage } from '@/lib/i18n';
import { jsonError, textError } from '@/lib/http';
import { eq, and, sql } from 'drizzle-orm';

type MetaType = 'category' | 'tag';

function parseMetaType(raw: string | null | undefined): MetaType | null {
  if (raw === 'category' || raw === 'tag') return raw;
  return null;
}

export const POST: APIRoute = handler;

// GET only for reading (JSON list for autocomplete), never for state changes
export const GET: APIRoute = async ({ request, url }) => {
  const auth = await requireAdminAction(request, 'editor', { csrf: false });
  if (isAdminActionResponse(auth)) return jsonAdminActionError(request, auth);

  const type = parseMetaType(url.searchParams.get('type') || 'category');
  if (!type) {
    return jsonError(400, i18nMessage('admin.meta.invalidType', 'Invalid metadata type.'), undefined, auth.i18n);
  }

  const metas = await auth.db.select({
    mid: schema.metas.mid,
    name: schema.metas.name,
    slug: schema.metas.slug,
    count: schema.metas.count,
  })
    .from(schema.metas)
    .where(eq(schema.metas.type, type))
    .orderBy(schema.metas.name);
  return new Response(JSON.stringify(metas), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

async function handler({ request, url }: { request: Request; locals: App.Locals; url: URL }) {
  const auth = await requireAdminAction(request, 'editor');
  if (isAdminActionResponse(auth)) return auth;
  const db = auth.db;
  const options = auth.options;

  const formData = await readAdminFormOrError(request, undefined, auth.i18n);
  if (formData instanceof Response) return formData;

  const action = formData.get('action')?.toString() || url.searchParams.get('action') || '';
  const type = parseMetaType(
    formData.get('type')?.toString() || url.searchParams.get('type') || 'category',
  );
  if (!type) {
    return textError(400, i18nMessage('admin.meta.invalidType', 'Invalid metadata type.'), undefined, auth.i18n);
  }

  const error = (status: number, key: string, variables: Record<string, string | number> = {}, fallback = key) =>
    textError(status, i18nMessage(key, fallback, variables), undefined, auth.i18n);

  const mid = parseInt(formData.get('mid')?.toString() || url.searchParams.get('mid') || '0', 10);
  const name = formData.get('name')?.toString()?.trim() || '';
  const slug = formData.get('slug')?.toString()?.trim() || '';
  const description = formData.get('description')?.toString()?.trim() || '';
  const mids = formData.getAll('mid[]').map((v) => parseInt(v.toString(), 10)).filter(Boolean);

  const redirectTo = type === 'tag' ? '/admin/manage-tags' : '/admin/manage-categories';

  if (action === 'create') {
    if (!name) return error(400, 'admin.meta.nameRequired', {}, 'Name is required.');
    const finalSlug = await resolveUniqueMetaSlug(db, slug, type, 0, name);

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
    if (!name) return error(400, 'admin.meta.nameRequired', {}, 'Name is required.');
    const existing = await db.query.metas.findFirst({
      where: and(eq(schema.metas.mid, mid), eq(schema.metas.type, type)),
    });
    if (!existing) {
      return error(404, 'admin.meta.notFound', {}, 'The metadata does not exist or has a different type.');
    }
    const finalSlug = await resolveUniqueMetaSlug(db, slug, type, mid, name);

    await db.update(schema.metas).set({
      name,
      slug: finalSlug,
      description: description || null,
    }).where(and(eq(schema.metas.mid, mid), eq(schema.metas.type, type)));

    await bumpCacheVersion(db);
    await purgeSiteCache(options.siteUrl || '');
    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }

  if (action === 'delete') {
    const deleteIds = mids.length > 0 ? mids : (mid ? [mid] : []);
    if (deleteIds.length === 0) {
      return new Response(null, { status: 302, headers: { Location: redirectTo } });
    }

    if (type === 'category') {
      const defaultMid = parseInt(String(options.defaultCategory ?? '0'), 10);
      for (const id of deleteIds) {
        if (id === defaultMid) {
          return error(400, 'admin.meta.defaultCategoryProtected', {}, 'The default category cannot be deleted. Choose another default category first.');
        }
      }
      const used = await db.select({ mid: schema.relationships.mid })
        .from(schema.relationships)
        .where(sql`${schema.relationships.mid} IN (${sql.join(deleteIds.map(id => sql`${id}`), sql`, `)})`);
      if (used.length > 0) {
        const inUseSet = new Set(used.map(r => r.mid));
        const targets = deleteIds.filter(id => inUseSet.has(id));
        return error(400, 'admin.meta.categoryHasPosts', { ids: targets.join(', #') }, 'Category #{ids} still contains posts. Move the content first.');
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
    const existing = await db.query.metas.findFirst({
      where: and(eq(schema.metas.mid, mid), eq(schema.metas.type, 'category')),
    });
    if (!existing) {
      return error(404, 'admin.meta.categoryNotFound', {}, 'The category does not exist.');
    }
    const { setOption } = await import('@/lib/options');
    await setOption(db, 'defaultCategory', String(mid));
    await bumpCacheVersion(db);
    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }

  if (action === 'refresh') {
    let metas;
    const refreshIds = mids.length > 0 ? mids : [];
    if (refreshIds.length > 0) {
      metas = await db.select().from(schema.metas)
        .where(sql`${schema.metas.mid} IN (${sql.join(refreshIds.map(id => sql`${id}`), sql`, `)})`);
    } else {
      metas = await db.select().from(schema.metas).where(eq(schema.metas.type, type));
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
    await purgeSiteCache(options.siteUrl || '');
    return new Response(null, { status: 302, headers: { Location: redirectTo } });
  }

  return error(400, 'admin.error.invalidAction', {}, 'Invalid action.');
}
