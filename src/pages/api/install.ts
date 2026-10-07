import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { getOption } from '@/lib/options';
import { resetCacheVersionMemo } from '@/lib/cache';
import { hashPassword, generateRandomString, timeSafeEqual } from '@/lib/auth';
import { env } from 'cloudflare:workers';
import { generateCreateSQL } from '@/lib/schema-sql';
import { PASSWORD_MIN_LENGTH, REQUEST_BODY_LIMITS } from '@/lib/constants';
import { InputError, inputErrorMessage, readBoundedFormData } from '@/lib/input';
import { resolveUniqueContentSlug } from '@/lib/slug';
import { createCoreRequestI18n } from '@/lib/i18n-runtime';
import { i18nMessage } from '@/lib/i18n';
import { textError } from '@/lib/http';
import { sql } from 'drizzle-orm';

const INSTALL_LOCK_TTL_SECONDS = 5 * 60;

/**
 * Create all tables and indexes from Drizzle schema definitions.
 * Source of truth: src/db/schema.ts (no migration files needed).
 */
async function ensureTables(d1: D1Database): Promise<void> {
  const statements = generateCreateSQL();
  // D1 batch() executes all statements in a single round-trip
  await d1.batch(statements.map(sql => d1.prepare(sql)));
}

function prepareStatement(d1: D1Database, statement: { toSQL(): { sql: string; params: unknown[] } }): D1PreparedStatement {
  const query = statement.toSQL();
  const prepared = d1.prepare(query.sql);
  return query.params.length ? prepared.bind(...query.params as (string | number | null | ArrayBuffer | Uint8Array | boolean)[]) : prepared;
}

async function claimInstallLock(d1: D1Database, lockValue: string, now: number): Promise<boolean> {
  // The lease allows a later installer to recover after a worker is stopped
  // between claiming the lock and committing its final batch. The unique
  // (name, user) key makes claiming and stale-lease replacement atomic.
  const result = await d1.prepare(`
    INSERT INTO typecho_options (name, user, value)
    VALUES ('installing', 0, ?)
    ON CONFLICT(name, user) DO UPDATE SET value = excluded.value
    WHERE CAST(substr(typecho_options.value, 1, instr(typecho_options.value, ':') - 1) AS INTEGER) <= ?
  `).bind(lockValue, now - INSTALL_LOCK_TTL_SECONDS).run();
  return result.meta.changes === 1;
}

async function releaseInstallLock(d1: D1Database, lockValue: string): Promise<void> {
  await d1.prepare("DELETE FROM typecho_options WHERE name = 'installing' AND user = 0 AND value = ?")
    .bind(lockValue)
    .run();
}

function rowsFromBatchResult(result: unknown): Array<Record<string, unknown>> {
  if (!result || typeof result !== 'object') return [];
  const d1Rows = (result as { results?: unknown }).results;
  if (Array.isArray(d1Rows)) return d1Rows as Array<Record<string, unknown>>;
  const sqliteRows = (result as { rows?: unknown }).rows;
  return Array.isArray(sqliteRows) ? sqliteRows as Array<Record<string, unknown>> : [];
}

function requiredReturnedId(result: unknown, column: 'uid' | 'mid' | 'cid', event: string): number {
  const row = rowsFromBatchResult(result)[0];
  const id = Number(row?.[column]);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`install-${event}-id-missing`);
  return id;
}

/**
 * The install window is open from "tables don't exist" until installed=1.
 * If `INSTALL_TOKEN` is configured as a Cloudflare secret, the form must
 * present it to proceed — this closes the race where the very first
 * visitor of a freshly-deployed worker becomes admin. When unset (most
 * deployments today), we keep the legacy "first visitor wins" behaviour
 * but log a warning to nudge operators toward setting the secret.
 */
function expectedInstallToken(): string {
  const e = env as unknown as { INSTALL_TOKEN?: string };
  return typeof e.INSTALL_TOKEN === 'string' ? e.INSTALL_TOKEN : '';
}

export const POST: APIRoute = async ({ request }) => {
  const d1 = env.DB;
  const db = getDb(d1);
  const i18n = createCoreRequestI18n(request).i18n;
  const error = (status: number, key: string, variables: Record<string, string | number> = {}, fallback = key, headers?: HeadersInit) =>
    textError(status, i18nMessage(key, fallback, variables), headers, i18n);

  // Refuse the install endpoint outright once installed=1. The 302 to /admin/
  // that used to sit further down would let an attacker at least confirm the
  // site was already provisioned; a flat 403 gives them nothing to work with.
  //
  // We probe options before touching formData so a hostile POST can't force
  // table creation to fail early and mask the check.
  try {
    const installed = await getOption(db, 'installed');
    if (installed === '1') {
      return error(403, 'install.alreadyInstalled', {}, 'Site is already installed.');
    }
  } catch {
    // Tables not yet created → the install window is still open, fall through.
  }

  let formData: FormData;
  try {
    formData = await readBoundedFormData(request, REQUEST_BODY_LIMITS.publicForm);
  } catch (error) {
    if (error instanceof InputError) return textError(error.status, inputErrorMessage(error), undefined, i18n);
    throw error;
  }
  const siteTitle = formData.get('siteTitle')?.toString() || 'Hello World';
  const siteDescription = formData.get('siteDescription')?.toString() || '';
  const userName = formData.get('userName')?.toString()?.trim() || '';
  const userPassword = formData.get('userPassword')?.toString() || '';
  const userMail = formData.get('userMail')?.toString()?.trim() || '';
  const installToken = formData.get('installToken')?.toString() || '';

  // Gate the install window with a deploy-time secret if configured.
  const expected = expectedInstallToken();
  if (expected) {
    if (!timeSafeEqual(installToken, expected)) {
      return error(403, 'install.tokenInvalid', {}, 'The installation token is invalid.');
    }
  } else {
    console.warn({ event: 'install_token_missing', installWindowOpen: true });
  }

  if (!userName || !userPassword || !userMail) {
    return error(400, 'install.incomplete', {}, 'Please complete all required fields.');
  }

  if (userPassword.length < PASSWORD_MIN_LENGTH) {
    return error(400, 'install.passwordTooShort', { count: PASSWORD_MIN_LENGTH }, `The password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }

  try {
    // Auto-create tables if they don't exist
    await ensureTables(d1);

    // Re-check after table creation in case another concurrent install races us.
    const installed = await getOption(db, 'installed');
    if (installed === '1') {
      return error(403, 'install.alreadyInstalled', {}, 'Site is already installed.');
    }

    // Hash before taking the lease so expensive crypto does not extend the
    // period during which another installer must wait.
    const hashedPassword = await hashPassword(userPassword);
    const authCode = generateRandomString(32);
    const now = Math.floor(Date.now() / 1000);
    const lockValue = `${now}:${generateRandomString(24)}`;
    const lockClaimed = await claimInstallLock(d1, lockValue, now);
    if (!lockClaimed) {
      return error(409, 'install.inProgress', {}, 'Site installation is already in progress.');
    }

    try {
      // Slug lookup remains a preflight read; the unique index is the final
      // arbiter if another writer claims a slug before this batch commits.
      const helloSlug = await resolveUniqueContentSlug(db, 'hello-world', 0, 'hello-world');
      const aboutSlug = await resolveUniqueContentSlug(db, 'about', 0, 'about');

      const siteUrl = new URL(request.url).origin;
      const secret = generateRandomString(32);
      const statements: D1PreparedStatement[] = [];

      statements.push(prepareStatement(d1, db.insert(schema.users).values({
        name: userName,
        password: hashedPassword,
        mail: userMail,
        url: siteUrl,
        screenName: userName,
        created: now,
        activated: now,
        logged: now,
        group: 'administrator',
        authCode,
      }).returning({ uid: schema.users.uid })));

      statements.push(prepareStatement(d1, db.insert(schema.metas).values({
        name: '默认分类',
        slug: 'default',
        type: 'category',
        description: '只是一个默认分类',
        count: 1,
        order: 1,
      }).returning({ mid: schema.metas.mid })));

      statements.push(prepareStatement(d1, db.insert(schema.contents).values({
        title: '欢迎使用 Typecho',
        slug: helloSlug,
        created: now,
        modified: now,
        text: '<!--markdown-->欢迎使用 Typecho 博客系统。这是你的第一篇文章，你可以编辑或删除它，然后开始写作！\n\n## 关于 Typecho\n\nTypecho 是一个基于 **Astro + Cloudflare Workers + D1** 构建的现代博客系统。\n\n- 极速响应：基于 Cloudflare 边缘网络\n- Markdown 支持：使用 Markdown 撰写文章\n- 简洁高效：保持博客系统的简约之道',
        authorId: sql<number>`(SELECT ${schema.users.uid} FROM ${schema.users} WHERE ${schema.users.name} = ${userName})`,
        type: 'post',
        status: 'publish',
        allowComment: '1',
        allowPing: '1',
        allowFeed: '1',
      }).returning({ cid: schema.contents.cid })));

      // Dependent IDs are resolved from the unique keys inside the same
      // atomic batch; the D1 RETURNING rows below remain the authoritative IDs.
      statements.push(prepareStatement(d1, db.insert(schema.relationships).values({
        cid: sql<number>`(SELECT ${schema.contents.cid} FROM ${schema.contents} WHERE ${schema.contents.slug} = ${helloSlug} AND ${schema.contents.type} = 'post')`,
        mid: sql<number>`(SELECT ${schema.metas.mid} FROM ${schema.metas} WHERE ${schema.metas.slug} = 'default' AND ${schema.metas.type} = 'category')`,
      })));

      statements.push(prepareStatement(d1, db.insert(schema.contents).values({
        title: '关于',
        slug: aboutSlug,
        created: now,
        modified: now,
        text: '<!--markdown-->这是一个关于页面的示例。你可以在后台管理中编辑它。',
        authorId: sql<number>`(SELECT ${schema.users.uid} FROM ${schema.users} WHERE ${schema.users.name} = ${userName})`,
        type: 'page',
        status: 'publish',
        allowComment: '1',
        allowPing: '0',
        allowFeed: '1',
        order: 0,
      }).returning({ cid: schema.contents.cid })));

      // Set default options, excluding `installed`, which is committed last.
      const defaultOptions: Record<string, string> = {
        theme: 'typecho-theme-minimal',
        timezone: 'Asia/Shanghai',
        lang: '',
        charset: 'UTF-8',
        contentType: 'text/html',
        title: siteTitle,
        description: siteDescription,
        keywords: 'blog',
        siteUrl,
        frontPage: 'recent',
        frontArchive: '0',
        pageSize: '5',
        postsListSize: '10',
        commentsListSize: '10',
        postDateFormat: 'Y-m-d',
        commentDateFormat: 'Y-m-d H:i',
        defaultCategory: '',
        allowRegister: '0',
        defaultAllowComment: '1',
        defaultAllowPing: '1',
        defaultAllowFeed: '1',
        feedFullText: '1',
        markdown: '1',
        commentsRequireMail: '1',
        commentsRequireURL: '0',
        // Left off by default: whether comments need review is the operator's
        // call (admin → 讨论设置 →「评论需审核」), and inbound feedback is only
        // accepted when its source backlink verifies.
        commentsRequireModeration: '0',
        commentsWhitelist: '0',
        commentsMaxNestingLevels: '5',
        commentsPostTimeout: String(24 * 3600 * 30),
        commentsUrlNofollow: '1',
        commentsShowUrl: '1',
        commentsMarkdown: '0',
        commentsPageBreak: '0',
        commentsThreaded: '1',
        commentsPageSize: '20',
        commentsPageDisplay: 'last',
        commentsOrder: 'ASC',
        commentsCheckReferer: '1',
        commentsAutoClose: '0',
        commentsPostIntervalEnable: '1',
        commentsPostInterval: '60',
        commentsShowCommentOnly: '0',
        commentsAvatar: '1',
        commentsAvatarRating: 'G',
        commentsAntiSpam: '1',
        attachmentTypes: '@image@',
        secret,
        editorSize: '350',
        autoSave: '0',
      };

      statements.push(prepareStatement(d1, db.insert(schema.options)
        .values(Object.entries(defaultOptions).map(([name, value]) => ({
          name,
          user: 0,
          value: name === 'defaultCategory'
            ? sql<string>`CAST((SELECT ${schema.metas.mid} FROM ${schema.metas} WHERE ${schema.metas.slug} = 'default' AND ${schema.metas.type} = 'category') AS TEXT)`
            : value,
        })))
        .onConflictDoUpdate({
          target: [schema.options.user, schema.options.name],
          set: { value: sql`excluded.value` },
        })));
      statements.push(prepareStatement(d1, db.insert(schema.options)
        .values({ name: 'cacheVersion', user: 0, value: '1' })
        .onConflictDoUpdate({
          target: [schema.options.user, schema.options.name],
          set: { value: sql`cast(coalesce(${schema.options.value}, '0') as integer) + 1` },
        })));

      // Release the owned lease in the same batch. `installed=1` is last so
      // every site row and option is present whenever middleware observes it.
      statements.push(d1.prepare("DELETE FROM typecho_options WHERE name = 'installing' AND user = 0 AND value = ?").bind(lockValue));
      statements.push(prepareStatement(d1, db.insert(schema.options)
        .values({ name: 'installed', user: 0, value: '1' })
        .onConflictDoUpdate({
          target: [schema.options.user, schema.options.name],
          set: { value: '1' },
        })));

      const results = await d1.batch(statements);
      requiredReturnedId(results[0], 'uid', 'admin');
      requiredReturnedId(results[1], 'mid', 'category');
      requiredReturnedId(results[2], 'cid', 'welcome-post');
      requiredReturnedId(results[4], 'cid', 'about-page');
      // The cacheVersion update is already committed; clear the isolate's
      // memo so the next options read observes it immediately.
      resetCacheVersionMemo();
    } catch (caught) {
      // D1 batch is atomic, so the only committed row from this attempt is
      // its lease. Release it best-effort; if D1 is unavailable, the lease
      // expires and the next installer can safely reclaim it.
      try {
        await releaseInstallLock(d1, lockValue);
      } catch {
        // Lease expiry is the recovery path when D1 cannot accept cleanup.
      }
      throw caught;
    }

    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/login' },
    });
  } catch (caught) {
    console.error({
      event: 'installation_failed',
      errorType: caught instanceof Error ? caught.name : 'UnknownError',
    });
    return error(500, 'install.failed', {}, 'Installation failed. Check the database configuration.');
  }
};
