import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { type SiteOptions } from '@/lib/options';
import { canManageResource } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { normalizeSlug, readAdminFormOrError } from '@/lib/input';
import { resolveUniqueMetaSlug, writeWithUniqueContentSlug } from '@/lib/slug';
import { applyFilter, doHook } from '@/lib/plugin';
import { invalidateSiteCache } from '@/lib/cache';
import { jsonError, jsonOk } from '@/lib/http';
import { i18nMessage } from '@/lib/i18n';
import { eq, and, sql, inArray, type SQL } from 'drizzle-orm';
import { validateFilteredContent, WriteFilterError } from '@/lib/write-filter';

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
function buildCustomFieldStatements(db: any, cid: number | SQL, formData: FormData): any[] {
  const cidCondition = typeof cid === 'number'
    ? eq(schema.fields.cid, cid)
    : sql`${schema.fields.cid} = ${cid}`;
  const statements = [db.delete(schema.fields).where(cidCondition)];
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

    statements.push(db.insert(schema.fields).values(fieldData).onConflictDoUpdate({
      target: [schema.fields.cid, schema.fields.name],
      set: { type: fieldData.type, str_value: fieldData.str_value, int_value: fieldData.int_value, float_value: fieldData.float_value },
    }));
  }
  return statements;
}

function parseTagNames(tags: string): string[] {
  return [...new Set(tags.split(',').map((t) => t.trim()).filter(Boolean))];
}

interface TagPlan {
  name: string;
  slug: string;
}

async function prepareTagPlan(db: any, tags: string): Promise<TagPlan[]> {
  const desired = [...new Map(parseTagNames(tags).map((name) => {
    const slug = normalizeSlug(name, 'tag');
    return [slug, { name, slug }] as const;
  })).values()];
  if (desired.length === 0) return [];

  const slugs = desired.map((tag) => tag.slug);
  const existing = await db
    .select({ slug: schema.metas.slug })
    .from(schema.metas)
    .where(and(
      eq(schema.metas.type, 'tag'),
      sql`${schema.metas.slug} IN (${sql.join(slugs.map((slug) => sql`${slug}`), sql`, `)})`,
    ));
  const existingSlugs = new Set(existing.map((row: { slug: string | null }) => row.slug));

  const plan: TagPlan[] = [];
  for (const tag of desired) {
    plan.push({
      ...tag,
      slug: existingSlugs.has(tag.slug)
        ? tag.slug
        : await resolveUniqueMetaSlug(db, tag.slug, 'tag', 0, tag.name),
    });
  }
  return plan;
}

function buildTagMetaStatements(db: any, tagPlan: TagPlan[]): any[] {
  if (tagPlan.length === 0) return [];
  return [db.insert(schema.metas).values(tagPlan.map((tag) => ({
    name: tag.name,
    slug: tag.slug,
    type: 'tag',
    count: 0,
  }))).onConflictDoNothing()];
}

function buildTagRelationshipStatements(db: any, cid: number | SQL, tagPlan: TagPlan[]): any[] {
  if (tagPlan.length === 0) return [];
  return [db.insert(schema.relationships).values(tagPlan.map((tag) => ({
    cid,
    mid: sql<number>`(SELECT ${schema.metas.mid} FROM ${schema.metas} WHERE ${schema.metas.type} = 'tag' AND ${schema.metas.slug} = ${tag.slug})`,
  }))).onConflictDoNothing()];
}

/**
 * Recalculate counts for the live old relationship set plus the requested new
 * set. This runs before relationship replacement in the same atomic batch:
 * its correlated count excludes this content and adds its requested links,
 * avoiding any dependence on an earlier request snapshot.
 */
function buildContentMetaCountStatement(
  db: any,
  cid: number,
  categoryIds: number[],
  tagPlan: TagPlan[],
  resultingType: string,
): any | null {
  const newTargets: SQL[] = [];
  if (categoryIds.length > 0) {
    newTargets.push(sql`${schema.metas.mid} IN (${sql.join(categoryIds.map((mid) => sql`${mid}`), sql`, `)})`);
  }
  if (tagPlan.length > 0) {
    newTargets.push(and(
      eq(schema.metas.type, 'tag'),
      inArray(schema.metas.slug, tagPlan.map((tag) => tag.slug)),
    )!);
  }
  const newTargetCondition = newTargets.length > 0
    ? sql`(${sql.join(newTargets, sql` OR `)})`
    : sql`0 = 1`;
  const oldTargetCondition = sql`${schema.metas.mid} IN (
    SELECT ${schema.relationships.mid}
    FROM ${schema.relationships}
    WHERE ${schema.relationships.cid} = ${cid}
  )`;
  const contributes = resultingType === 'revision'
    ? sql`0`
    : sql`CASE WHEN ${newTargetCondition} THEN 1 ELSE 0 END`;

  return db.update(schema.metas)
    .set({
      count: sql`(
        SELECT COUNT(*)
        FROM ${schema.relationships}
        INNER JOIN ${schema.contents} ON ${schema.relationships.cid} = ${schema.contents.cid}
        WHERE ${schema.relationships.mid} = ${schema.metas.mid}
          AND ${schema.relationships.cid} <> ${cid}
          AND ${schema.contents.type} <> 'revision'
      ) + ${contributes}`,
    })
    .where(and(
      inArray(schema.metas.type, ['category', 'tag']),
      sql`(${oldTargetCondition} OR ${newTargetCondition})`,
    ));
}

function isContentPrimaryKeyConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error && /unique constraint failed:\s*[`"']?typecho_contents\.cid\b/i.test(current.message)) {
      return true;
    }
    if (typeof current !== 'object') break;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function getNextContentId(db: any): Promise<number> {
  const [row] = await db
    .select({ nextId: sql<number>`max(
      coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'typecho_contents'), 0),
      coalesce(max(${schema.contents.cid}), 0)
    ) + 1` })
    .from(schema.contents);
  if (!row?.nextId) throw new Error('content-id-allocation-failed');
  return Number(row.nextId);
}

function hookNameForType(type: 'post' | 'page'): 'post:write' | 'page:write' {
  return type === 'page' ? 'page:write' : 'post:write';
}

async function purgeContentAndRelatedCache(
  db: any,
  _options: SiteOptions,
  _cid: number,
  fallbackContent?: typeof schema.contents.$inferSelect,
  /**
   * Extra category/tag URLs to purge — used when a piece of content is
   * being reassigned so the OLD categories/tags see their post lists
   * refresh alongside the new ones.
   */
  _extraUrls?: { categoryUrls?: string[]; tagUrls?: string[] },
) {
  const content = fallbackContent;

  // Skip cache work for drafts — they never appear on public pages, so
  // purging index/feed/category URLs is pure waste.
  const isDraft = content?.type?.endsWith('_draft') || content?.status === 'draft';
  if (isDraft) {
    return;
  }

  // Every public cache key embeds cacheVersion. A single version bump replaces
  // URL-by-URL purges and avoids loading relationships solely to build keys
  // that the Cache API no longer stores.
  await invalidateSiteCache(db);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const admin = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(admin)) return admin;
  const db = admin.db;
  const options = admin.options;
  const auth = { uid: admin.uid, user: admin.user };
  const pluginCtx = admin.pluginCtx;
  const error = (status: number, key: string, variables: Record<string, string | number> = {}, fallback = key) =>
    jsonError(status, i18nMessage(key, fallback, variables), undefined, admin.i18n);

  const formData = await readAdminFormOrError(request, undefined, admin.i18n);
  if (formData instanceof Response) return formData;
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
  const slugInput = normalizeSlug(formData.get('slug')?.toString() || '');
  const submitAction = formData.get('status')?.toString() || 'publish'; // 'draft' or 'publish' from submit button
  const isDraft = submitAction === 'draft';
  const status = VISIBILITY_TO_STATUS[formData.get('visibility')?.toString() || ''] || 'publish';
  const password = formData.get('password')?.toString()?.trim() || null;
  const allowComment = formData.get('allowComment') ? '1' : '0';
  const allowPing = formData.get('allowPing') ? '1' : '0';
  const allowFeed = formData.get('allowFeed') ? '1' : '0';
  const tags = formData.get('tags')?.toString()?.trim() || '';
  let categoryIds = [...new Set(formData.getAll('category[]').map((v) => parseInt(v.toString(), 10)).filter(Boolean))];
  const template = formData.get('template')?.toString()?.trim() || null;
  const order = parseInt(formData.get('order')?.toString() || '0', 10) || 0;

  const now = Math.floor(Date.now() / 1000);

  // ── Schedule: accept optional datetime from the editor ──
  const scheduleDate = formData.get('date')?.toString()?.trim();
  let created = now;
  if (scheduleDate) {
    const parsed = Math.floor(new Date(scheduleDate).getTime() / 1000);
    if (Number.isFinite(parsed) && parsed > 0) created = Math.max(parsed, 1);
  }

  // ── Autosave: only allowed for draft-mode content ──
  const isAutosave = formData.get('autosave') === '1';
  const contentType = isDraft ? `${type}_draft` : type;

  if (isAutosave) {
    // Autosave rejection: cannot autosave published content
    if (cid) {
      const existing = await db.query.contents.findFirst({ where: eq(schema.contents.cid, cid) });
      if (!existing) return error(404, 'admin.content.notFound', {}, 'Not Found');
      if (existing.status === 'publish') return error(400, 'admin.content.autosaveNotAllowed', {}, 'Autosave is not allowed for published content.');
      if (!canManageResource(auth.user, existing)) return error(403, 'core.error.forbidden', {}, 'Forbidden');
      await db.update(schema.contents).set({
        title: title || existing.title,
        text: text || existing.text,
        modified: now,
      } satisfies Record<string, unknown>).where(eq(schema.contents.cid, cid));
      return jsonOk({ cid, autosaved: true });
    }
    // New draft: create a post_draft row
    const inserted = await db.insert(schema.contents).values({
      title,
      slug: `autosave-${crypto.randomUUID()}`,
      created,
      modified: now,
      text,
      order: 0,
      authorId: auth.uid,
      type: type === 'page' ? 'page_draft' : 'post_draft',
      status: 'draft',
    } satisfies Record<string, unknown>).returning({ cid: schema.contents.cid });
    if (!inserted.length) return error(500, 'admin.content.createFailed', {}, 'Content could not be created.');
    const newCid = inserted[0].cid;
    return jsonOk({ cid: newCid, autosaved: true });
  }

  // Only real category rows may be attached. `category[]` is a user-supplied
  // form field (contributors can write content) and the statements below also
  // increment metas.count, so an unvalidated mid both fabricates relationships
  // and inflates unrelated counters.
  if (categoryIds.length > 0) {
    const writableCategories = await db
      .select({ mid: schema.metas.mid })
      .from(schema.metas)
      .where(and(eq(schema.metas.type, 'category'), inArray(schema.metas.mid, categoryIds)));
    categoryIds = writableCategories.map((row) => row.mid);
  }

  if (action === 'create') {
    const protectedContentData: Record<string, unknown> = {
      title,
      slug: slugInput,
      created,
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
    let contentData: Record<string, unknown>;
    try {
      const filtered = await applyFilter(pluginCtx, hookName, { ...protectedContentData }, {
        request, formData, db, options, user: auth.user, action, i18n: admin.i18n,
        capabilityRuntime: pluginCtx.capabilityRuntime,
      });
      contentData = validateFilteredContent(protectedContentData, filtered);
    } catch (error) {
      if (error instanceof WriteFilterError) return jsonError(400, error.message);
      throw error;
    }

    const tagPlan = await prepareTagPlan(db, tags);
    const desiredSlug = contentData.slug as string;
    let newCid = 0;
    let finalSlug = '';
    // CID is part of the established collision suffix (`slug-<cid>`), so
    // reserve the next candidate before preparing the complete write batch.
    // A concurrent creator can still win that CID; retry only that narrowly
    // identified primary-key collision with a fresh candidate.
    for (let idAttempt = 0; idAttempt < 4; idAttempt++) {
      const candidateCid = await getNextContentId(db);
      try {
        const created = await writeWithUniqueContentSlug(
          db,
          desiredSlug || String(candidateCid),
          candidateCid,
          async (resolvedSlug) => {
            const createStatements: any[] = [
              db.insert(schema.contents).values({
                ...contentData,
                cid: candidateCid,
                slug: resolvedSlug,
              } as any).returning({ cid: schema.contents.cid }),
              ...buildCustomFieldStatements(db, candidateCid, formData),
            ];
            if (tagPlan.length > 0) {
              createStatements.push(db.insert(schema.metas).values(tagPlan.map((tag) => ({
                name: tag.name,
                slug: tag.slug,
                type: 'tag',
                count: 0,
              }))).onConflictDoNothing());
            }
            if (categoryIds.length > 0) {
              createStatements.push(
                db.insert(schema.relationships).values(
                  categoryIds.map((mid) => ({ cid: candidateCid, mid })),
                ),
                db.update(schema.metas)
                  .set({ count: sql`${schema.metas.count} + 1` })
                  .where(inArray(schema.metas.mid, categoryIds)),
              );
            }
            if (tagPlan.length > 0) {
              createStatements.push(
                db.insert(schema.relationships).values(tagPlan.map((tag) => ({
                  cid: candidateCid,
                  mid: sql<number>`(SELECT ${schema.metas.mid} FROM ${schema.metas} WHERE ${schema.metas.type} = 'tag' AND ${schema.metas.slug} = ${tag.slug})`,
                }))).onConflictDoNothing(),
                db.update(schema.metas)
                  .set({ count: sql`${schema.metas.count} + 1` })
                  .where(and(
                    eq(schema.metas.type, 'tag'),
                    inArray(schema.metas.slug, tagPlan.map((tag) => tag.slug)),
                  )),
              );
            }

            const [inserted] = await db.batch(createStatements as [any, ...any[]]);
            const insertedCid = (inserted as Array<{ cid: number }> | undefined)?.[0]?.cid;
            if (!insertedCid) throw new Error('content-create-batch-returned-no-id');
            return { cid: insertedCid, slug: resolvedSlug };
          },
          String(candidateCid),
        );
        newCid = created.cid;
        finalSlug = created.slug;
        break;
      } catch (writeError) {
        if (!isContentPrimaryKeyConflict(writeError) || idAttempt === 3) throw writeError;
      }
    }
    if (!newCid) return error(500, 'admin.content.createFailed', {}, 'Content could not be created.');
    contentData.slug = finalSlug;

    // Trigger post/page finish hooks
    const finishData = { ...contentData, cid: newCid };
    if (!isDraft) {
      await doHook(pluginCtx, type === 'page' ? 'page:afterPublish' : 'post:afterPublish', finishData, {
        capabilityRuntime: pluginCtx.capabilityRuntime,
      });
    }
    await doHook(pluginCtx, type === 'page' ? 'page:afterSave' : 'post:afterSave', finishData, {
      capabilityRuntime: pluginCtx.capabilityRuntime,
    });

    await purgeContentAndRelatedCache(db, options, newCid, finishData as typeof schema.contents.$inferSelect);

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
    if (!existing) return error(404, 'admin.content.notFound', {}, 'Not Found');

    if (!canManageResource(auth.user, existing)) {
      return error(403, 'core.error.forbidden', {}, 'Forbidden');
    }

    const existingBaseType = existing.type?.startsWith('page') ? 'page' : 'post';
    const savingRevision = isDraft && (existing.type === existingBaseType);

    // Typecho keeps a published row immutable while editing and stores the
    // pending version as one revision child. A single revision per parent is
    // enough for the editor flow and mirrors Typecho's active draft lookup.
    if (savingRevision) {
      const revision = await db.query.contents.findFirst({
        where: and(eq(schema.contents.parent, cid), eq(schema.contents.type, 'revision')),
      });
      const revisionBaseline: Record<string, unknown> = {
        title,
        slug: slugInput || existing.slug || String(cid),
        created: existing.created || created,
        modified: now,
        text,
        order,
        authorId: existing.authorId,
        template,
        type: 'revision',
        status: 'draft',
        password,
        allowComment,
        allowPing,
        allowFeed,
        parent: cid,
      };
      let revisionData: Record<string, unknown>;
      try {
        const filtered = await applyFilter(pluginCtx, hookNameForType(existingBaseType), { ...revisionBaseline }, {
          request, formData, db, options, user: auth.user, action, existing, i18n: admin.i18n,
          capabilityRuntime: pluginCtx.capabilityRuntime,
        });
        revisionData = validateFilteredContent(revisionBaseline, filtered);
        revisionData.parent = cid;
        revisionData.type = 'revision';
        revisionData.status = 'draft';
      } catch (error) {
        if (error instanceof WriteFilterError) return jsonError(400, error.message);
        throw error;
      }
      const tagPlan = await prepareTagPlan(db, tags);
      const temporarySlug = revision ? null : `revision-${crypto.randomUUID()}`;
      const revisionCidRef: number | SQL = revision?.cid
        ?? sql<number>`(SELECT ${schema.contents.cid} FROM ${schema.contents} WHERE ${schema.contents.slug} = ${temporarySlug} AND ${schema.contents.type} = 'revision' AND ${schema.contents.parent} = ${cid})`;
      const revisionWriteData = temporarySlug
        ? { ...revisionData, slug: temporarySlug }
        : revisionData;
      const revisionStatements: any[] = [
        revision
          ? db.update(schema.contents).set(revisionWriteData as any)
            .where(eq(schema.contents.cid, revision.cid)).returning({ cid: schema.contents.cid })
          : db.insert(schema.contents).values(revisionWriteData as any)
            .returning({ cid: schema.contents.cid }),
        ...buildCustomFieldStatements(db, revisionCidRef, formData),
        ...buildTagMetaStatements(db, tagPlan),
        typeof revisionCidRef === 'number'
          ? db.delete(schema.relationships).where(eq(schema.relationships.cid, revisionCidRef))
          : db.delete(schema.relationships).where(sql`${schema.relationships.cid} = ${revisionCidRef}`),
      ];
      if (categoryIds.length) {
        revisionStatements.push(db.insert(schema.relationships).values(
          categoryIds.map(mid => ({ cid: revisionCidRef, mid }))));
      }
      revisionStatements.push(...buildTagRelationshipStatements(db, revisionCidRef, tagPlan));
      if (temporarySlug) {
        revisionStatements.push(db.update(schema.contents)
          .set({ slug: String(revisionData.slug || existing.slug || cid) })
          .where(eq(schema.contents.slug, temporarySlug)));
      }
      const [savedRevisionRows] = await db.batch(revisionStatements as [any, ...any[]]);
      const revisionCid = revision?.cid ?? (savedRevisionRows as Array<{ cid: number }> | undefined)?.[0]?.cid;
      if (!revisionCid) return error(500, 'admin.content.revisionSaveFailed', {}, 'The revision could not be saved.');
      await doHook(pluginCtx, existingBaseType === 'page' ? 'page:afterSave' : 'post:afterSave', {
        ...revisionData, cid: revisionCid, parent: cid,
      }, { capabilityRuntime: pluginCtx.capabilityRuntime });
      return new Response(null, { status: 302, headers: { Location: `/admin/write-${existingBaseType}?cid=${cid}` } });
    }
    const protectedType = isDraft ? `${existingBaseType}_draft` : existingBaseType;
    const protectedContentData: Record<string, unknown> = {
      title,
      slug: slugInput || existing.slug || String(cid),
      created,
      modified: now,
      text,
      order,
      authorId: existing.authorId,
      template,
      type: protectedType,
      status,
      password,
      allowComment,
      allowPing,
      allowFeed,
    };
    const hookName = existingBaseType === 'page' ? 'page:write' : 'post:write';
    let contentData: Record<string, unknown>;
    try {
      const filtered = await applyFilter(pluginCtx, hookName, { ...protectedContentData }, {
        request, formData, db, options, user: auth.user, action, existing, i18n: admin.i18n,
        capabilityRuntime: pluginCtx.capabilityRuntime,
      });
      contentData = validateFilteredContent(protectedContentData, filtered);
    } catch (error) {
      if (error instanceof WriteFilterError) return jsonError(400, error.message);
      throw error;
    }
    const tagPlan = await prepareTagPlan(db, tags);
    // Read the active revision before the main write. Its removal can then
    // share the same atomic publish batch as the parent update.
    const activeRevision = !isDraft
      ? await db.query.contents.findFirst({
        where: and(eq(schema.contents.parent, cid), eq(schema.contents.type, 'revision')),
      })
      : null;

    await writeWithUniqueContentSlug(db, contentData.slug as string || String(cid), cid, async (finalSlug) => {
      contentData.slug = finalSlug;
      const updateStatements: any[] = [
        db.update(schema.contents).set(contentData as any).where(eq(schema.contents.cid, cid)),
        ...buildCustomFieldStatements(db, cid, formData),
        ...buildTagMetaStatements(db, tagPlan),
      ];
      const countStatement = buildContentMetaCountStatement(
        db,
        cid,
        categoryIds,
        tagPlan,
        String(contentData.type || ''),
      );
      if (countStatement) updateStatements.push(countStatement);
      updateStatements.push(db.delete(schema.relationships).where(eq(schema.relationships.cid, cid)));

      if (categoryIds.length > 0) {
        updateStatements.push(db.insert(schema.relationships).values(
          categoryIds.map((mid) => ({ cid, mid })),
        ));
      }
      updateStatements.push(...buildTagRelationshipStatements(db, cid, tagPlan));
      if (activeRevision) {
        updateStatements.push(
          db.delete(schema.relationships).where(eq(schema.relationships.cid, activeRevision.cid)),
          db.delete(schema.fields).where(eq(schema.fields.cid, activeRevision.cid)),
          db.delete(schema.contents).where(eq(schema.contents.cid, activeRevision.cid)),
        );
      }
      await db.batch(updateStatements as [any, ...any[]]);
    });

    const finishData = { ...existing, ...contentData, cid };
    if (!isDraft) {
      await doHook(pluginCtx, existingBaseType === 'page' ? 'page:afterPublish' : 'post:afterPublish', finishData, {
        capabilityRuntime: pluginCtx.capabilityRuntime,
      });
    }
    await doHook(pluginCtx, existingBaseType === 'page' ? 'page:afterSave' : 'post:afterSave', finishData, {
      capabilityRuntime: pluginCtx.capabilityRuntime,
    });

    await purgeContentAndRelatedCache(db, options, cid, {
      ...existing,
      ...contentData,
    });

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
    if (!existing) return error(404, 'admin.content.notFound', {}, 'Not Found');

    if (!canManageResource(auth.user, existing)) {
      return error(403, 'core.error.forbidden', {}, 'Forbidden');
    }

    // Trigger pre-delete hook
    const isPage = existing.type?.startsWith('page');
    await doHook(pluginCtx, isPage ? 'page:beforeDelete' : 'post:beforeDelete', existing, {
      capabilityRuntime: pluginCtx.capabilityRuntime,
    });

    const revisions = await db.select({ cid: schema.contents.cid }).from(schema.contents)
      .where(and(eq(schema.contents.type, 'revision'), eq(schema.contents.parent, cid)));
    const deleteCids = [cid, ...revisions.map(revision => revision.cid)];
    const deleteStatements: any[] = [];
    // Compute final counters from current relationships, excluding the
    // content and revision rows this atomic batch removes. The affected-mid
    // subquery is live at execution time, so concurrent edits cannot leave a
    // stale preflight decrement behind.
    deleteStatements.push(db.update(schema.metas)
      .set({
        count: sql`(
          SELECT COUNT(*)
          FROM ${schema.relationships}
          INNER JOIN ${schema.contents} ON ${schema.relationships.cid} = ${schema.contents.cid}
          WHERE ${schema.relationships.mid} = ${schema.metas.mid}
            AND ${schema.relationships.cid} NOT IN (${sql.join(deleteCids.map(id => sql`${id}`), sql`, `)})
            AND ${schema.contents.type} <> 'revision'
        )`,
      })
      .where(and(
        inArray(schema.metas.type, ['category', 'tag']),
        sql`${schema.metas.mid} IN (
          SELECT ${schema.relationships.mid}
          FROM ${schema.relationships}
          WHERE ${schema.relationships.cid} IN (${sql.join(deleteCids.map(id => sql`${id}`), sql`, `)})
        )`,
      )));
    deleteStatements.push(
      db.delete(schema.relationships).where(inArray(schema.relationships.cid, deleteCids)),
      db.delete(schema.comments).where(inArray(schema.comments.cid, deleteCids)),
      db.delete(schema.fields).where(inArray(schema.fields.cid, deleteCids)),
      db.delete(schema.contents).where(inArray(schema.contents.cid, deleteCids)),
    );
    await db.batch(deleteStatements as [any, ...any[]]);

    // Purge cache AFTER the row is gone. If we bump cacheVersion before
    // the delete, a concurrent public GET between bump and delete would
    // re-read the still-present row from D1 and cache it under the
    // fresh version — that cached corpse would then serve forever.
    await purgeContentAndRelatedCache(db, options, cid, existing);

    // Trigger post-delete hook
    await doHook(pluginCtx, isPage ? 'page:afterDelete' : 'post:afterDelete', existing, {
      capabilityRuntime: pluginCtx.capabilityRuntime,
    });

    const redirectTo = isPage ? '/admin/manage-pages' : '/admin/manage-posts';
    return new Response(null, {
      status: 302,
      headers: { Location: redirectTo },
    });
  }

  return error(400, 'admin.error.invalidAction', {}, 'Invalid action.');
};
