import type { APIRoute } from 'astro';
import { schema, type Database } from '@/db';
import { type SiteOptions } from '@/lib/options';
import { canManageResource, hasPermission } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { normalizeSlug, readAdminFormOrError } from '@/lib/input';
import { writeWithUniqueContentSlug } from '@/lib/slug';
import { applyFilter, doHook } from '@/lib/plugin';
import { invalidateSiteCache } from '@/lib/cache';
import { jsonError, jsonOk } from '@/lib/http';
import { i18nMessage } from '@/lib/i18n';
import { chunkArray, chunkInsertRows, D1_INSERT_ROW_PARAMS, D1_SAFE_IN_LIST_SIZE } from '@/lib/d1-limits';
import { resolveContentWritePolicy } from '@/lib/content-status';
import { formatDateTimeLocal, parseDateTimeLocalToTimestamp } from '@/lib/timezone';
import { eq, and, sql, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { validateFilteredContent, WriteFilterError } from '@/lib/write-filter';

const WRITABLE_CONTENT_TYPES = new Set(['post', 'post_draft', 'page', 'page_draft']);

function isWritableContentType(type: string | null | undefined): boolean {
  return !!type && WRITABLE_CONTENT_TYPES.has(type);
}

function isPageContentType(type: string | null | undefined): boolean {
  return type === 'page' || type === 'page_draft';
}

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

async function prepareTagPlan(db: Database, tags: string, contentId?: number): Promise<TagPlan[]> {
  const desired = parseTagNames(tags);
  const slugsByName = new Map<string, string[]>();
  const attachedNames = new Set<string>();
  for (const names of chunkArray(desired, D1_SAFE_IN_LIST_SIZE - 1)) {
    const rows = await db.select({
      name: schema.metas.name,
      slug: schema.metas.slug,
      attached: schema.relationships.cid,
    })
      .from(schema.metas)
      .leftJoin(schema.relationships, contentId
        ? and(eq(schema.relationships.mid, schema.metas.mid), eq(schema.relationships.cid, contentId))
        : sql`0`)
      .where(and(eq(schema.metas.type, 'tag'), inArray(schema.metas.name, names)))
      .orderBy(schema.metas.mid);
    for (const row of rows) {
      if (!row.name || !row.slug) continue;
      if (!slugsByName.has(row.name) || (row.attached && !attachedNames.has(row.name))) {
        slugsByName.set(row.name, [row.slug]);
      } else if (row.attached) {
        slugsByName.get(row.name)!.push(row.slug);
      }
      if (row.attached) attachedNames.add(row.name);
    }
  }
  return [...new Map(desired.flatMap(name => (slugsByName.get(name) ?? [normalizeSlug(name, 'tag')])
    .map(slug => [slug, { name, slug }] as const))).values()];
}

function buildAttachmentClaimStatements(db: Database, parent: number, authorId: number, ids: number[]) {
  return chunkArray(ids, D1_SAFE_IN_LIST_SIZE - 3).map(chunk => db.update(schema.contents)
    .set({ parent })
    .where(and(
      inArray(schema.contents.cid, chunk),
      eq(schema.contents.type, 'attachment'),
      eq(schema.contents.authorId, authorId),
      or(eq(schema.contents.parent, 0), isNull(schema.contents.parent)),
    )));
}

function buildTagMetaStatements(db: any, tagPlan: TagPlan[]): any[] {
  return chunkInsertRows(tagPlan, D1_INSERT_ROW_PARAMS.metas).map((chunk) =>
    db.insert(schema.metas).values(chunk.map((tag) => ({
      name: tag.name,
      slug: tag.slug,
      type: 'tag',
      count: 0,
    }))).onConflictDoNothing()
  );
}

// A relationship row normally binds `cid` plus the mid (or the tag-slug
// lookup). When cid is a correlated subquery — the new-revision path — that
// subquery binds two values in every row, so the per-row budget grows by one.
function relationshipRowParams(cid: number | SQL): number {
  return D1_INSERT_ROW_PARAMS.relationships + (typeof cid === 'number' ? 0 : 1);
}

function buildTagRelationshipStatements(db: any, cid: number | SQL, tagPlan: TagPlan[]): any[] {
  return chunkInsertRows(tagPlan, relationshipRowParams(cid)).map((chunk) =>
    db.insert(schema.relationships).values(chunk.map((tag) => ({
      cid,
      mid: sql<number>`(SELECT ${schema.metas.mid} FROM ${schema.metas} WHERE ${schema.metas.type} = 'tag' AND ${schema.metas.slug} = ${tag.slug})`,
    }))).onConflictDoNothing()
  );
}

function buildContentCategoryStatements(db: any, cid: number | SQL, categoryIds: number[]): any[] {
  return chunkInsertRows(categoryIds, relationshipRowParams(cid)).map((chunk) =>
    db.insert(schema.relationships).values(chunk.map((mid) => ({ cid, mid }))),
  );
}

/**
 * Recalculate counts for the live old relationship set plus the requested new
 * set. This runs before relationship replacement in the same atomic batch:
 * its correlated count excludes this content and adds its requested links,
 * avoiding any dependence on an earlier request snapshot.
 *
 * D1 caps a statement at 100 bound parameters, so the update is split by meta
 * type and into chunks. The first chunk of each type also covers the live old
 * relationship set; a type whose new set is empty still gets a cleanup
 * statement so removed links are recounted.
 */
function buildContentMetaCountStatements(
  db: any,
  cid: number,
  categoryIds: number[],
  tagPlan: TagPlan[],
  resultingType: string,
): any[] {
  if (resultingType === 'revision') return [];

  const countExpression = sql`(
    SELECT COUNT(*)
    FROM ${schema.relationships}
    INNER JOIN ${schema.contents} ON ${schema.relationships.cid} = ${schema.contents.cid}
    WHERE ${schema.relationships.mid} = ${schema.metas.mid}
      AND ${schema.relationships.cid} <> ${cid}
      AND ${schema.contents.type} <> 'revision'
  )`;
  const oldTargetCondition = sql`${schema.metas.mid} IN (
    SELECT ${schema.relationships.mid}
    FROM ${schema.relationships}
    WHERE ${schema.relationships.cid} = ${cid}
  )`;

  const buildUpdate = (
    type: 'category' | 'tag',
    newTargetCondition: SQL | null,
    includeOldTargets: boolean,
  ) => {
    const contributes = newTargetCondition
      ? sql`CASE WHEN ${newTargetCondition} THEN 1 ELSE 0 END`
      : sql`0`;
    const conditions: SQL[] = [eq(schema.metas.type, type)];
    if (includeOldTargets && newTargetCondition) {
      conditions.push(sql`(${oldTargetCondition} OR ${newTargetCondition})`);
    } else if (includeOldTargets) {
      conditions.push(oldTargetCondition);
    } else if (newTargetCondition) {
      conditions.push(newTargetCondition);
    }
    return db.update(schema.metas)
      .set({ count: sql`${countExpression} + ${contributes}` })
      .where(and(...conditions));
  };

  const statements: any[] = [];
  const countChunkSize = 45;

  const categoryChunks = chunkArray(categoryIds, countChunkSize);
  if (categoryChunks.length === 0) {
    statements.push(buildUpdate('category', null, true));
  } else {
    categoryChunks.forEach((chunk, index) => {
      const condition = sql`${schema.metas.mid} IN (${sql.join(chunk.map((mid) => sql`${mid}`), sql`, `)})`;
      statements.push(buildUpdate('category', condition, index === 0));
    });
  }

  const tagChunks = chunkArray(tagPlan.map((tag) => tag.slug), countChunkSize);
  if (tagChunks.length === 0) {
    statements.push(buildUpdate('tag', null, true));
  } else {
    tagChunks.forEach((chunk, index) => {
      const condition = sql`${schema.metas.slug} IN (${sql.join(chunk.map((slug) => sql`${slug}`), sql`, `)})`;
      statements.push(buildUpdate('tag', condition, index === 0));
    });
  }

  return statements;
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

export const POST: APIRoute = async ({ request }) => {
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
  const type = (VALID_TYPES.includes(typeInput) ? typeInput : 'post') as 'post' | 'page';
  const isEditor = hasPermission(auth.user.group || 'visitor', 'editor');
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
  const visibilityInput = formData.get('visibility')?.toString() || '';
  // `undefined` means the form did not carry the field: an update must keep
  // the existing value (pages do not render date/password inputs).
  const passwordInput = formData.has('password')
    ? (formData.get('password')?.toString()?.trim() || null)
    : undefined;
  const createdInput = formData.has('date')
    ? formData.get('date')?.toString()?.trim() ?? ''
    : undefined;
  const allowComment = formData.get('allowComment') ? '1' : '0';
  const allowPing = formData.get('allowPing') ? '1' : '0';
  const allowFeed = formData.get('allowFeed') ? '1' : '0';
  const tags = formData.get('tags')?.toString()?.trim() || '';
  const attachmentIds = [...new Set(formData.getAll('attachment[]').map(Number)
    .filter(id => Number.isSafeInteger(id) && id > 0))];
  let categoryIds = [...new Set(formData.getAll('category[]').map((v) => parseInt(v.toString(), 10)).filter(Boolean))];
  const template = formData.get('template')?.toString()?.trim() || null;
  const order = parseInt(formData.get('order')?.toString() || '0', 10) || 0;

  const now = Math.floor(Date.now() / 1000);

  // Pages are editor-only in Typecho (menu, write-page and Page\Edit all
  // require editor). Enforce it at the API boundary too.
  if (type === 'page' && !isEditor) {
    return error(403, 'core.error.forbidden', {}, 'Forbidden');
  }

  // ── Schedule: accept optional datetime from the editor ──
  const createCreated = createdInput === undefined || createdInput === ''
    ? now
    : (parseDateTimeLocalToTimestamp(createdInput, options.timezone) ?? now);

  // ── Autosave: only allowed for draft-mode content ──
  const isAutosave = formData.get('autosave') === '1';
  const contentType = isDraft ? `${type}_draft` : type;

  if (isAutosave) {
    // Autosave rejection: cannot autosave published content
    if (cid) {
      const existing = await db.query.contents.findFirst({ where: eq(schema.contents.cid, cid) });
      if (!existing) return error(404, 'admin.content.notFound', {}, 'Not Found');
      if (!isWritableContentType(existing.type)) {
        return error(404, 'admin.content.notFound', {}, 'Not Found');
      }
      if (isPageContentType(existing.type) && !isEditor) {
        return error(403, 'core.error.forbidden', {}, 'Forbidden');
      }
      if (existing.status === 'publish') return error(400, 'admin.content.autosaveNotAllowed', {}, 'Autosave is not allowed for published content.');
      if (!canManageResource(auth.user, existing)) return error(403, 'core.error.forbidden', {}, 'Forbidden');
      const patch: Record<string, unknown> = {
        title: title || existing.title,
        text: text || existing.text,
        modified: now,
      };
      if (!isEditor && !isPageContentType(existing.type)) {
        // Typecho forces contributor saves to the review queue.
        patch.status = 'waiting';
        patch.password = null;
      }
      await db.update(schema.contents).set(patch).where(eq(schema.contents.cid, cid));
      // `hidden` is publicly viewable, so changing its title/text or moving a
      // contributor's row to `waiting` must retire the cached public copy.
      if (existing.status === 'hidden') {
        await purgeContentAndRelatedCache(
          db,
          options,
          cid,
          { ...existing, ...patch } as typeof schema.contents.$inferSelect,
        );
      }
      return jsonOk({ cid, autosaved: true });
    }
    // New draft: create a post_draft row
    const inserted = await db.insert(schema.contents).values({
      title,
      slug: `autosave-${crypto.randomUUID()}`,
      created: createCreated,
      modified: now,
      text,
      order: 0,
      authorId: auth.uid,
      type: type === 'page' ? 'page_draft' : 'post_draft',
      status: isEditor ? 'draft' : 'waiting',
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
    const writable: number[] = [];
    for (const chunk of chunkArray(categoryIds, D1_SAFE_IN_LIST_SIZE)) {
      const rows = await db
        .select({ mid: schema.metas.mid })
        .from(schema.metas)
        .where(and(eq(schema.metas.type, 'category'), inArray(schema.metas.mid, chunk)));
      writable.push(...rows.map((row: { mid: number }) => row.mid));
    }
    categoryIds = [...new Set(writable)];
  }

  if (action === 'create') {
    const initialPassword = passwordInput ?? null;
    const policy = resolveContentWritePolicy({
      kind: type,
      isEditor,
      isDraft,
      visibility: visibilityInput,
      password: initialPassword,
    });
    const protectedContentData: Record<string, unknown> = {
      title,
      slug: slugInput,
      created: createCreated,
      modified: now,
      text,
      order,
      authorId: auth.uid,
      template,
      type: contentType,
      status: policy.status,
      password: policy.password,
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
    const finalPolicy = resolveContentWritePolicy({
      kind: type,
      isEditor,
      isDraft,
      visibility: visibilityInput,
      password: contentData.password as string | null,
    });
    contentData.status = finalPolicy.status;
    contentData.password = finalPolicy.password;

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
              ...buildAttachmentClaimStatements(db, candidateCid, auth.uid, attachmentIds),
            ];
            if (tagPlan.length > 0) {
              createStatements.push(...buildTagMetaStatements(db, tagPlan));
            }
            if (categoryIds.length > 0) {
              createStatements.push(...buildContentCategoryStatements(db, candidateCid, categoryIds));
              for (const chunk of chunkArray(categoryIds, D1_SAFE_IN_LIST_SIZE)) {
                createStatements.push(
                  db.update(schema.metas)
                    .set({ count: sql`${schema.metas.count} + 1` })
                    .where(inArray(schema.metas.mid, chunk)),
                );
              }
            }
            if (tagPlan.length > 0) {
              createStatements.push(...buildTagRelationshipStatements(db, candidateCid, tagPlan));
              for (const chunk of chunkArray(tagPlan.map((tag) => tag.slug), D1_SAFE_IN_LIST_SIZE)) {
                createStatements.push(
                  db.update(schema.metas)
                    .set({ count: sql`${schema.metas.count} + 1` })
                    .where(and(
                      eq(schema.metas.type, 'tag'),
                      inArray(schema.metas.slug, chunk),
                    )),
                );
              }
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

    // Attachments and revisions are not editable through the post/page editor.
    if (!isWritableContentType(existing.type)) {
      return error(404, 'admin.content.notFound', {}, 'Not Found');
    }

    if (!canManageResource(auth.user, existing)) {
      return error(403, 'core.error.forbidden', {}, 'Forbidden');
    }

    const existingBaseType = isPageContentType(existing.type) ? 'page' : 'post';
    if (existingBaseType === 'page' && !isEditor) {
      return error(403, 'core.error.forbidden', {}, 'Forbidden');
    }
    const existingCreated = existing.created || now;
    const updateCreated = createdInput === undefined
      ? existingCreated
      : createdInput === ''
        ? now
        // The editor renders the stored instant at minute precision. Keep the
        // exact original when the field was not changed: an ambiguous DST
        // fall-back wall time cannot be uniquely round-tripped.
        : createdInput === formatDateTimeLocal(existingCreated, options.timezone)
          ? existingCreated
          : (parseDateTimeLocalToTimestamp(createdInput, options.timezone) ?? now);
    const updatePassword = passwordInput !== undefined
      ? passwordInput
      : (existing.password ?? null);
    const savingRevision = isDraft && (existing.type === existingBaseType);

    // Typecho keeps a published row immutable while editing and stores the
    // pending version as one revision child. A single revision per parent is
    // enough for the editor flow and mirrors Typecho's active draft lookup.
    if (savingRevision) {
      const revisionCidRef = sql<number>`(
        SELECT cid FROM typecho_contents
        WHERE parent = ${cid} AND type = 'revision'
        ORDER BY modified DESC, cid DESC LIMIT 1
      )`;
      const revisionInitialPolicy = resolveContentWritePolicy({
        kind: existingBaseType,
        isEditor,
        isDraft: true,
        visibility: visibilityInput,
        password: updatePassword,
      });
      const revisionBaseline: Record<string, unknown> = {
        title,
        slug: slugInput || existing.slug || String(cid),
        created: existing.created || updateCreated,
        modified: now,
        text,
        order,
        authorId: existing.authorId,
        template,
        type: 'revision',
        status: revisionInitialPolicy.status,
        password: revisionInitialPolicy.password,
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
        const revisionPolicy = resolveContentWritePolicy({
          kind: existingBaseType,
          isEditor,
          isDraft: true,
          visibility: visibilityInput,
          password: revisionData.password as string | null,
        });
        revisionData.parent = cid;
        revisionData.type = 'revision';
        revisionData.status = revisionPolicy.status;
        revisionData.password = revisionPolicy.password;
      } catch (error) {
        if (error instanceof WriteFilterError) return jsonError(400, error.message);
        throw error;
      }
      const tagPlan = await prepareTagPlan(db, tags, cid);
      // D1 serializes these write batches. The existence check and insertion
      // share one statement, so concurrent first saves reuse the same row.
      const revisionStatements = [
        db.insert(schema.contents).select(sql`
          SELECT NULL, NULL, NULL, 0, 0, NULL, 0, 0, NULL, 'revision', 'draft',
            NULL, 0, '0', '0', '0', ${cid}
          WHERE ${revisionCidRef} IS NULL
            AND EXISTS (SELECT 1 FROM typecho_contents WHERE cid = ${cid} AND type = ${existingBaseType})
        `),
        db.update(schema.contents).set(revisionData as typeof schema.contents.$inferInsert)
          .where(sql`cid = ${revisionCidRef}`).returning({ cid: schema.contents.cid }),
        ...buildCustomFieldStatements(db, revisionCidRef, formData),
        ...buildAttachmentClaimStatements(db, cid, auth.uid, attachmentIds),
        ...buildTagMetaStatements(db, tagPlan),
        db.delete(schema.relationships).where(sql`${schema.relationships.cid} = ${revisionCidRef}`),
        ...buildContentCategoryStatements(db, revisionCidRef, categoryIds),
        ...buildTagRelationshipStatements(db, revisionCidRef, tagPlan),
      ];
      const [, savedRevisionRows] = await db.batch(revisionStatements as [any, ...any[]]);
      const revisionCid = (savedRevisionRows as Array<{ cid: number }>)[0]?.cid;
      if (!revisionCid) return error(500, 'admin.content.revisionSaveFailed', {}, 'The revision could not be saved.');
      await doHook(pluginCtx, existingBaseType === 'page' ? 'page:afterSave' : 'post:afterSave', {
        ...revisionData, cid: revisionCid, parent: cid,
      }, { capabilityRuntime: pluginCtx.capabilityRuntime });
      return new Response(null, { status: 302, headers: { Location: `/admin/write-${existingBaseType}?cid=${cid}` } });
    }
    const protectedType = isDraft ? `${existingBaseType}_draft` : existingBaseType;
    // Give the write filter the same status/password the create path exposes,
    // so plugins branching on visibility see the submitted hidden/private/
    // waiting state rather than a placeholder. The final policy below still
    // overrides whatever the filter returns.
    const initialPolicy = resolveContentWritePolicy({
      kind: existingBaseType,
      isEditor,
      isDraft,
      visibility: visibilityInput,
      password: updatePassword,
    });
    const protectedContentData: Record<string, unknown> = {
      title,
      slug: slugInput || existing.slug || String(cid),
      created: updateCreated,
      modified: now,
      text,
      order,
      authorId: existing.authorId,
      template,
      type: protectedType,
      status: initialPolicy.status,
      password: initialPolicy.password,
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
    const finalPolicy = resolveContentWritePolicy({
      kind: existingBaseType,
      isEditor,
      isDraft,
      visibility: visibilityInput,
      password: contentData.password as string | null,
    });
    contentData.status = finalPolicy.status;
    contentData.password = finalPolicy.password;
    const tagPlan = await prepareTagPlan(db, tags, cid);
    const revisionIds = db.select({ cid: schema.contents.cid }).from(schema.contents)
      .where(and(eq(schema.contents.parent, cid), eq(schema.contents.type, 'revision')));

    await writeWithUniqueContentSlug(db, contentData.slug as string || String(cid), cid, async (finalSlug) => {
      contentData.slug = finalSlug;
      const updateStatements: any[] = [
        db.update(schema.contents).set(contentData as any).where(eq(schema.contents.cid, cid)),
        ...buildCustomFieldStatements(db, cid, formData),
        ...buildAttachmentClaimStatements(db, cid, auth.uid, attachmentIds),
        ...buildTagMetaStatements(db, tagPlan),
        ...buildContentMetaCountStatements(
          db,
          cid,
          categoryIds,
          tagPlan,
          String(contentData.type || ''),
        ),
      ];
      updateStatements.push(db.delete(schema.relationships).where(eq(schema.relationships.cid, cid)));

      if (categoryIds.length > 0) {
        updateStatements.push(...buildContentCategoryStatements(db, cid, categoryIds));
      }
      updateStatements.push(...buildTagRelationshipStatements(db, cid, tagPlan));
      if (!isDraft) {
        updateStatements.push(
          db.delete(schema.relationships).where(inArray(schema.relationships.cid, revisionIds)),
          db.delete(schema.fields).where(inArray(schema.fields.cid, revisionIds)),
          db.delete(schema.contents).where(and(eq(schema.contents.parent, cid), eq(schema.contents.type, 'revision'))),
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
    if (!isWritableContentType(existing.type)) {
      return error(404, 'admin.content.notFound', {}, 'Not Found');
    }

    if (!canManageResource(auth.user, existing)) {
      return error(403, 'core.error.forbidden', {}, 'Forbidden');
    }

    const isPage = isPageContentType(existing.type);
    if (isPage && !isEditor) {
      return error(403, 'core.error.forbidden', {}, 'Forbidden');
    }

    // Trigger pre-delete hook
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
