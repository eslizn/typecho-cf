import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { type SiteOptions } from '@/lib/options';
import { hasPermission } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { buildAuthorLink, buildCategoryLink, buildPermalink, buildTagLink, generateSlug } from '@/lib/content';
import { setActivatedPlugins, parseActivatedPlugins, applyFilter, doHook } from '@/lib/plugin';
import { bumpCacheVersion, purgeContentCache } from '@/lib/cache';
import { withWriteTransaction } from '@/lib/db-transaction';
import { eq, and, sql } from 'drizzle-orm';

// Typecho convention: visibility dropdown maps to db status column.
// 'password' visibility stores the password in a separate column, status falls back to 'publish'.
const VISIBILITY_TO_STATUS: Record<string, string> = {
  publish: 'publish',
  hidden: 'hidden',
  password: 'publish',
  private: 'private',
  waiting: 'waiting',
};

/**
 * Save custom fields for a content item.
 * Handles the field[name], fieldNames[], fieldTypes[] form pattern from Typecho.
 */
async function saveCustomFields(db: any, cid: number, formData: FormData) {
  // Delete existing fields first
  await db.delete(schema.fields).where(eq(schema.fields.cid, cid));

  const fieldNames = formData.getAll('fieldNames[]').map((v: any) => v.toString().trim()).filter(Boolean);
  for (const name of fieldNames) {
    const type = formData.get(`fieldTypes[${name}]`)?.toString() || 'str';
    const rawValue = formData.get(`fieldValues[${name}]`)?.toString() || '';

    const fieldData: any = { cid, name, type, str_value: null, int_value: 0, float_value: 0 };

    if (type === 'int') {
      fieldData.int_value = parseInt(rawValue, 10) || 0;
    } else if (type === 'float') {
      fieldData.float_value = parseFloat(rawValue) || 0;
    } else {
      fieldData.str_value = rawValue;
    }

    await db.insert(schema.fields).values(fieldData).onConflictDoUpdate({
      target: [schema.fields.cid, schema.fields.name],
      set: { type: fieldData.type, str_value: fieldData.str_value, int_value: fieldData.int_value, float_value: fieldData.float_value },
    });
  }
}

function parseTagNames(tags: string): string[] {
  return [...new Set(tags.split(',').map((t) => t.trim()).filter(Boolean))];
}

async function attachTags(db: any, cid: number, tags: string) {
  for (const tagName of parseTagNames(tags)) {
    const tagSlug = generateSlug(tagName) || tagName.toLowerCase().replace(/\s+/g, '-');
    let tagRow = await db.query.metas.findFirst({
      where: and(eq(schema.metas.slug, tagSlug), eq(schema.metas.type, 'tag')),
    });

    if (!tagRow) {
      const inserted = await db.insert(schema.metas).values({
        name: tagName,
        slug: tagSlug,
        type: 'tag',
        count: 0,
      }).returning({ mid: schema.metas.mid });
      tagRow = { mid: inserted[0].mid } as any;
    }

    if (!tagRow) continue;

    const existingRel = await db.query.relationships.findFirst({
      where: and(
        eq(schema.relationships.cid, cid),
        eq(schema.relationships.mid, tagRow.mid),
      ),
    });
    if (existingRel) continue;

    await db.insert(schema.relationships).values({ cid, mid: tagRow.mid });
    await db.update(schema.metas)
      .set({ count: sql`${schema.metas.count} + 1` })
      .where(eq(schema.metas.mid, tagRow.mid));
  }
}

async function purgeContentAndRelatedCache(
  db: any,
  options: SiteOptions,
  cid: number,
  fallbackContent?: typeof schema.contents.$inferSelect,
) {
  await bumpCacheVersion(db);
  const content = fallbackContent || await db.query.contents.findFirst({
    where: eq(schema.contents.cid, cid),
  });
  if (!content) {
    await purgeContentCache(options.siteUrl || '', cid);
    return;
  }

  const relatedMetas = await db
    .select({ type: schema.metas.type, slug: schema.metas.slug })
    .from(schema.relationships)
    .innerJoin(schema.metas, eq(schema.relationships.mid, schema.metas.mid))
    .where(eq(schema.relationships.cid, cid));

  const categories = relatedMetas.filter((m: any) => m.type === 'category' && m.slug);
  const tags = relatedMetas.filter((m: any) => m.type === 'tag' && m.slug);
  const contentUrl = buildPermalink(
    {
      cid: content.cid,
      slug: content.slug,
      type: content.type,
      created: content.created,
      category: categories[0]?.slug || null,
    },
    options.siteUrl || '',
    options.permalinkPattern as string | undefined,
    options.pagePattern as string | undefined,
  );

  await purgeContentCache(options.siteUrl || '', cid, {
    contentUrl,
    categoryUrls: categories.map((m: any) => buildCategoryLink(m.slug, options.siteUrl || '', options.categoryPattern as string | undefined)),
    tagUrls: tags.map((m: any) => buildTagLink(m.slug, options.siteUrl || '')),
    authorUrl: content.authorId ? buildAuthorLink(content.authorId, options.siteUrl || '') : null,
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const admin = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(admin)) return admin;
  const db = admin.db;
  const options = admin.options;
  const auth = { uid: admin.uid, user: admin.user };

  // Load activated plugins
  const activatedIds = parseActivatedPlugins(options.activatedPlugins as string | undefined);
  setActivatedPlugins(activatedIds);

  const formData = await request.formData();
  const action = formData.get('do')?.toString() || 'create';
  const typeInput = formData.get('type')?.toString() || 'post';
  const VALID_TYPES = ['post', 'page'];
  const type = VALID_TYPES.includes(typeInput) ? typeInput : 'post';
  const cid = parseInt(formData.get('cid')?.toString() || '0', 10);
  const title = formData.get('title')?.toString()?.trim() || '';
  const isMarkdown = formData.get('markdown') === '1';
  let text = formData.get('text')?.toString() || '';
  // Follow Typecho convention: prepend <!--markdown--> prefix based on editor type
  if (isMarkdown && !text.startsWith('<!--markdown-->')) {
    text = '<!--markdown-->' + text;
  }
  // Slug: use provided value, otherwise leave empty and fill with cid after insert (Typecho convention)
  const slugInput = formData.get('slug')?.toString()?.trim() || '';
  const submitAction = formData.get('status')?.toString() || 'publish'; // 'draft' or 'publish' from submit button
  const isDraft = submitAction === 'draft';
  const status = VISIBILITY_TO_STATUS[formData.get('visibility')?.toString() || ''] || 'publish';
  const password = formData.get('password')?.toString()?.trim() || null;
  const allowComment = formData.get('allowComment') ? '1' : '0';
  const allowPing = formData.get('allowPing') ? '1' : '0';
  const allowFeed = formData.get('allowFeed') ? '1' : '0';
  const tags = formData.get('tags')?.toString()?.trim() || '';
  const categoryIds = [...new Set(formData.getAll('category[]').map((v) => parseInt(v.toString(), 10)).filter(Boolean))];
  const template = formData.get('template')?.toString()?.trim() || null;
  const order = parseInt(formData.get('order')?.toString() || '0', 10) || 0;

  const now = Math.floor(Date.now() / 1000);
  const contentType = isDraft ? `${type}_draft` : type;

  if (action === 'create') {
    return await withWriteTransaction(db, async (db) => {
    // Build content data — slug will be backfilled with cid if empty
    let contentData: Record<string, unknown> = {
      title,
      slug: slugInput || `temp-${Date.now().toString(36)}`,
      created: now,
      modified: now,
      text,
      order,
      authorId: auth.uid,
      template,
      type: contentType,
      status,
      password,
      allowComment,
      allowPing,
      allowFeed,
    };

    // Apply post:write or page:write filter
    const hookName = type === 'page' ? 'page:write' : 'post:write';
    contentData = await applyFilter(hookName, contentData);

    const result = await db.insert(schema.contents).values(contentData as any).returning({ cid: schema.contents.cid });

    const newCid = result[0]?.cid;
    if (!newCid) return new Response('创建失败', { status: 500 });

    // Backfill slug with cid if user didn't provide one (Typecho convention)
    if (!slugInput) {
      await db.update(schema.contents).set({ slug: String(newCid) }).where(eq(schema.contents.cid, newCid));
    } else {
      // Ensure unique slug — append cid if conflict
      const existing = await db.query.contents.findFirst({
        where: and(eq(schema.contents.slug, slugInput), sql`${schema.contents.cid} != ${newCid}`),
      });
      if (existing) {
        await db.update(schema.contents).set({ slug: `${slugInput}-${newCid}` }).where(eq(schema.contents.cid, newCid));
      } else {
        await db.update(schema.contents).set({ slug: slugInput }).where(eq(schema.contents.cid, newCid));
      }
    }

    // Save custom fields
    await saveCustomFields(db, newCid, formData);

    // Add categories
    if (categoryIds.length > 0) {
      await db.insert(schema.relationships).values(
        categoryIds.map((mid) => ({ cid: newCid, mid }))
      );
      // Update category count
      for (const mid of categoryIds) {
        await db.update(schema.metas)
          .set({ count: sql`${schema.metas.count} + 1` })
          .where(eq(schema.metas.mid, mid));
      }
    }

    // Add tags
    if (tags) {
      await attachTags(db, newCid, tags);
    }

    // Trigger post/page finish hooks
    const finishData = { ...contentData, cid: newCid };
    if (!isDraft) {
      await doHook(type === 'page' ? 'page:finishPublish' : 'post:finishPublish', finishData);
    }
    await doHook(type === 'page' ? 'page:finishSave' : 'post:finishSave', finishData);

    await purgeContentAndRelatedCache(db, options, newCid);

    const editUrl = type === 'page' ? `/admin/write-page?cid=${newCid}` : `/admin/write-post?cid=${newCid}`;
    return new Response(null, {
      status: 302,
      headers: { Location: editUrl },
    });
    });
  }

  if (action === 'update' && cid) {
    return await withWriteTransaction(db, async (db) => {
    // Check ownership
    const existing = await db.query.contents.findFirst({
      where: eq(schema.contents.cid, cid),
    });
    if (!existing) return new Response('Not Found', { status: 404 });

    const isAdmin = hasPermission(auth.user.group || 'visitor', 'administrator');
    if (!isAdmin && existing.authorId !== auth.uid) {
      return new Response('Forbidden', { status: 403 });
    }

    await db.update(schema.contents).set({
      title,
      slug: slugInput || String(cid),
      modified: now,
      text,
      order,
      template,
      type: contentType,
      status,
      password,
      allowComment,
      allowPing,
      allowFeed,
    }).where(eq(schema.contents.cid, cid));

    // Save custom fields
    await saveCustomFields(db, cid, formData);

    // Update categories: remove old, add new
    const oldRels = await db.select({ mid: schema.relationships.mid })
      .from(schema.relationships)
      .where(eq(schema.relationships.cid, cid));
    const oldMids = oldRels.map(r => r.mid);

    // Delete old relationships
    await db.delete(schema.relationships).where(eq(schema.relationships.cid, cid));

    // Decrement old category counts
    for (const mid of oldMids) {
      const meta = await db.query.metas.findFirst({ where: eq(schema.metas.mid, mid) });
      if (meta?.type === 'category' || meta?.type === 'tag') {
        await db.update(schema.metas)
          .set({ count: sql`MAX(0, ${schema.metas.count} - 1)` })
          .where(eq(schema.metas.mid, mid));
      }
    }

    // Add new categories
    if (categoryIds.length > 0) {
      await db.insert(schema.relationships).values(
        categoryIds.map((mid) => ({ cid, mid }))
      );
      for (const mid of categoryIds) {
        await db.update(schema.metas)
          .set({ count: sql`${schema.metas.count} + 1` })
          .where(eq(schema.metas.mid, mid));
      }
    }

    // Add tags
    if (tags) {
      await attachTags(db, cid, tags);
    }

    await purgeContentAndRelatedCache(db, options, cid);

    const editUrl = type === 'page' ? `/admin/write-page?cid=${cid}` : `/admin/write-post?cid=${cid}`;
    return new Response(null, {
      status: 302,
      headers: { Location: editUrl },
    });
    });
  }

  if (action === 'delete' && cid) {
    return await withWriteTransaction(db, async (db) => {
    const existing = await db.query.contents.findFirst({
      where: eq(schema.contents.cid, cid),
    });
    if (!existing) return new Response('Not Found', { status: 404 });

    const isAdmin = hasPermission(auth.user.group || 'visitor', 'administrator');
    if (!isAdmin && existing.authorId !== auth.uid) {
      return new Response('Forbidden', { status: 403 });
    }

    // Trigger pre-delete hook
    const isPage = existing.type?.startsWith('page');
    await doHook(isPage ? 'page:delete' : 'post:delete', existing);
    await purgeContentAndRelatedCache(db, options, cid, existing);

    // Decrement meta counts before deleting relationships
    const rels = await db.select({ mid: schema.relationships.mid })
      .from(schema.relationships)
      .where(eq(schema.relationships.cid, cid));
    for (const rel of rels) {
      await db.update(schema.metas)
        .set({ count: sql`MAX(0, ${schema.metas.count} - 1)` })
        .where(eq(schema.metas.mid, rel.mid));
    }
    // Delete relationships and comments
    await db.delete(schema.relationships).where(eq(schema.relationships.cid, cid));
    await db.delete(schema.comments).where(eq(schema.comments.cid, cid));
    await db.delete(schema.fields).where(eq(schema.fields.cid, cid));
    await db.delete(schema.contents).where(eq(schema.contents.cid, cid));

    // Trigger post-delete hook
    await doHook(isPage ? 'page:finishDelete' : 'post:finishDelete', existing);

    const redirectTo = isPage ? '/admin/manage-pages' : '/admin/manage-posts';
    return new Response(null, {
      status: 302,
      headers: { Location: redirectTo },
    });
    });
  }

  return new Response('Invalid action', { status: 400 });
};
