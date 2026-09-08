import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import { applyFilter, doHook, type HookContext } from '@/lib/plugin';
import type { SiteOptions } from '@/lib/options';
import { normalizeHttpUrl } from '@/lib/url';

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
    { db, options, content },
  );
  const value = { ...baseline, ...(filtered as Record<string, unknown>) };
  const status = value.status === 'approved' ? 'approved' : 'waiting';
  const inserted = await db.insert(schema.comments).values({
    cid: input.cid, created: now, author: String(value.author || ''), authorId: 0,
    ownerId: content.authorId || 0, mail: String(value.mail || ''), url: String(value.url || ''),
    ip: input.ip, agent: input.agent, text: String(value.text || ''), type: input.type, status, parent: 0,
  }).returning({ coid: schema.comments.coid });
  if (status === 'approved') {
    await db.update(schema.contents).set({ commentsNum: sql`${schema.contents.commentsNum} + 1` }).where(eq(schema.contents.cid, input.cid));
  }
  const row = { ...value, cid: input.cid, coid: inserted[0]?.coid };
  await doHook(
    pluginCtx,
    input.type === 'trackback' ? 'feedback:trackback:after' : 'feedback:pingback:after',
    row,
  );
  return inserted[0]?.coid || 0;
}
