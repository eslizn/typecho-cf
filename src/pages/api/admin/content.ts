import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { getAuthCookies, validateAuthToken, hasPermission } from '@/lib/auth';
import { generateSlug } from '@/lib/content';
import { setActivatedPlugins, parseActivatedPlugins, applyFilter, doHook } from '@/lib/plugin';
import { eq, and, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

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

export const POST: APIRoute = async ({ request, locals }) => {
  const db = getDb(env.DB);
  const options = await loadOptions(db);

  // Load activated plugins
  const activatedIds = parseActivatedPlugins(options.activatedPlugins as string | undefined);
  setActivatedPlugins(activatedIds);

  // Auth check
  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);
  if (!token || !options.secret) return new Response('Unauthorized', { status: 401 });

  const auth = await validateAuthToken(token, options.secret, db);
  if (!auth) return new Response('Unauthorized', { status: 401 });
  if (!hasPermission(auth.user.group || 'visitor', 'contributor')) {
    return new Response('Forbidden', { status: 403 });
  }

  const formData = await request.formData();
  const action = formData.get('do')?.toString() || 'create';
  const type = formData.get('type')?.toString() || 'post';
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
  const status = formData.get('status')?.toString() || 'publish';
  const password = formData.get('password')?.toString()?.trim() || null;
  const allowComment = formData.get('allowComment') ? '1' : '0';
  const allowPing = formData.get('allowPing') ? '1' : '0';
  const allowFeed = formData.get('allowFeed') ? '1' : '0';
  const tags = formData.get('tags')?.toString()?.trim() || '';
  const categoryIds = formData.getAll('category[]').map((v) => parseInt(v.toString(), 10)).filter(Boolean);
  const template = formData.get('template')?.toString()?.trim() || null;
  const order = parseInt(formData.get('order')?.toString() || '0', 10) || 0;

  const now = Math.floor(Date.now() / 1000);
  const contentType = status === 'draft' ? `${type}_draft` : type;

  if (action === 'create') {
    // Build content data — slug will be backfilled with cid if empty
    let contentData: Record<string, any> = {
      title,
      slug: slugInput || `temp-${Date.now().toString(36)}`,
      created: now,
      modified: now,
      text,
      order,
      authorId: auth.uid,
      template,
      type: contentType,
      status: status === 'draft' ? 'publish' : status,
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
      const tagNames = tags.split(',').map((t) => t.trim()).filter(Boolean);
      for (const tagName of tagNames) {
        let tagSlug = generateSlug(tagName) || tagName.toLowerCase().replace(/\s+/g, '-');
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

        if (tagRow) {
          await db.insert(schema.relationships).values({ cid: newCid, mid: tagRow.mid })
            .onConflictDoNothing();
          await db.update(schema.metas)
            .set({ count: sql`${schema.metas.count} + 1` })
            .where(eq(schema.metas.mid, tagRow.mid));
        }
      }
    }

    // Trigger post/page finish hooks
    const finishData = { ...contentData, cid: newCid };
    if (status !== 'draft') {
      await doHook(type === 'page' ? 'page:finishPublish' : 'post:finishPublish', finishData);
    }
    await doHook(type === 'page' ? 'page:finishSave' : 'post:finishSave', finishData);

    const editUrl = type === 'page' ? `/admin/write-page?cid=${newCid}` : `/admin/write-post?cid=${newCid}`;
    return new Response(null, {
      status: 302,
      headers: { Location: editUrl },
    });
  }

  if (action === 'update' && cid) {
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
      status: status === 'draft' ? 'publish' : status,
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
      const tagNames = tags.split(',').map((t) => t.trim()).filter(Boolean);
      for (const tagName of tagNames) {
        let tagSlug = generateSlug(tagName) || tagName.toLowerCase().replace(/\s+/g, '-');
        let tagRow = await db.query.metas.findFirst({
          where: and(eq(schema.metas.slug, tagSlug), eq(schema.metas.type, 'tag')),
        });

        if (!tagRow) {
          const inserted = await db.insert(schema.metas).values({
            name: tagName, slug: tagSlug, type: 'tag', count: 0,
          }).returning({ mid: schema.metas.mid });
          tagRow = { mid: inserted[0].mid } as any;
        }

        if (tagRow) {
          await db.insert(schema.relationships).values({ cid, mid: tagRow.mid }).onConflictDoNothing();
          await db.update(schema.metas)
            .set({ count: sql`${schema.metas.count} + 1` })
            .where(eq(schema.metas.mid, tagRow.mid));
        }
      }
    }

    const editUrl = type === 'page' ? `/admin/write-page?cid=${cid}` : `/admin/write-post?cid=${cid}`;
    return new Response(null, {
      status: 302,
      headers: { Location: editUrl },
    });
  }

  if (action === 'delete' && cid) {
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
  }

  return new Response('Invalid action', { status: 400 });
};
