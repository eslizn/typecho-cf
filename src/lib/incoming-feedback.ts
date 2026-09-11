import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import { applyFilter, doHook, type HookContext } from '@/lib/plugin';
import type { SiteOptions } from '@/lib/options';
import { normalizeHttpUrl } from '@/lib/url';
import { buildPermalink } from '@/lib/content';
import { verifyFeedbackSource } from '@/lib/feedback-verification';

/**
 * Clamp a (possibly plugin-filtered) feedback status to the values the comment
 * moderation queue uses. `approved` is only ever set explicitly — by the
 * moderation switch being off, or by a plugin filter.
 */
function normalizeFeedbackStatus(value: unknown): 'approved' | 'waiting' {
  if (value === 'approved') return 'approved';
  return 'waiting';
}

/**
 * Per-IP cap for the public trackback / pingback endpoints. The counter is
 * in-isolate (see trackSlidingWindow), so it is best-effort abuse friction
 * rather than a global quota — the endpoints are unauthenticated and have no
 * other cost control.
 */
export const INCOMING_FEEDBACK_RATE_LIMIT = { windowSeconds: 60, maxRequests: 5 };

export async function saveIncomingFeedback(
  db: Database, pluginCtx: HookContext, options: SiteOptions,
  input: { cid: number; author: string; mail?: string; url: string; text: string; type: 'trackback' | 'pingback'; ip: string; agent: string },
): Promise<number | Response> {
  const content = await db.query.contents.findFirst({ where: eq(schema.contents.cid, input.cid) });
  if (!content || !['post', 'page'].includes(content.type || '') || content.status !== 'publish') {
    return new Response('not-found', { status: 404 });
  }
  if (content.allowPing !== '1') return new Response('pinging-not-allowed', { status: 403 });
  const sourceUrl = normalizeHttpUrl(input.url);
  if (!sourceUrl || !input.author.trim() || !input.text.trim()) return new Response('invalid-feedback', { status: 400 });
  // Confirm the source page actually links back to the target. Feedback that
  // cannot be verified is rejected outright (nothing is written): a pingback
  // is supposed to prove the backlink, and storing unverified rows would only
  // turn the comment table into a spam dump.
  //
  // Whether *verified* feedback needs review is decided solely by
  // `commentsRequireModeration` — `waiting` when it is on, `approved` when off.
  const targetUrl = buildPermalink(
    content,
    options.siteUrl || '',
    options.permalinkPattern as string | undefined,
    options.pagePattern as string | undefined,
  );
  const verified = await verifyFeedbackSource(sourceUrl, targetUrl);
  if (!verified) return new Response('source-not-verified', { status: 403 });

  const duplicate = await db.query.comments.findFirst({
    columns: { coid: true },
    where: (comments, { and, eq }) => and(
      eq(comments.cid, input.cid), eq(comments.type, input.type), eq(comments.url, sourceUrl),
    ),
  });
  if (duplicate) return new Response('duplicate-feedback', { status: 409 });
  const now = Math.floor(Date.now() / 1000);
  const baseline: Record<string, unknown> = {
    cid: input.cid, created: now, author: input.author.slice(0, 150), authorId: 0,
    ownerId: content.authorId || 0, mail: (input.mail || '').slice(0, 150), url: sourceUrl,
    ip: input.ip, agent: input.agent.slice(0, 255), text: input.text.slice(0, 10000), type: input.type,
    status: options.commentsRequireModeration ? 'waiting' : 'approved', parent: 0,
  };
  const filtered = await applyFilter(
    pluginCtx,
    input.type === 'trackback' ? 'feedback:trackback:before' : 'feedback:pingback:before',
    baseline,
    { db, options, content, capabilityRuntime: pluginCtx.capabilityRuntime },
  );
  const value = { ...baseline, ...(filtered as Record<string, unknown>) };
  const status = normalizeFeedbackStatus(value.status);
  // A plugin filter is trusted, but it must not lift the length caps the
  // baseline applies: every field here ultimately comes from an unauthenticated
  // remote peer.
  const text = String(value.text || '').slice(0, 10_000);
  const author = String(value.author || '').slice(0, 150);
  const mail = String(value.mail || '').slice(0, 150);
  const url = String(value.url || '').slice(0, 255);
  const inserted = await db.insert(schema.comments).values({
    cid: input.cid, created: now, author, authorId: 0,
    ownerId: content.authorId || 0, mail, url,
    ip: input.ip, agent: input.agent, text, type: input.type, status, parent: 0,
  }).returning({ coid: schema.comments.coid });
  if (status === 'approved') {
    await db.update(schema.contents).set({ commentsNum: sql`${schema.contents.commentsNum} + 1` }).where(eq(schema.contents.cid, input.cid));
  }
  const row = { ...value, author, mail, url, text, cid: input.cid, coid: inserted[0]?.coid };
  await doHook(
    pluginCtx,
    input.type === 'trackback' ? 'feedback:trackback:after' : 'feedback:pingback:after',
    row,
    { capabilityRuntime: pluginCtx.capabilityRuntime },
  );
  return inserted[0]?.coid || 0;
}
