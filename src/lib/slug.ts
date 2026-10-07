import { and, eq, ne, or, isNull } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import { normalizeSlug } from '@/lib/input';

const CONTENT_SLUG_WRITE_ATTEMPTS = 8;

export async function resolveUniqueContentSlug(
  db: Database,
  desired: unknown,
  cid: number,
  fallback?: string,
): Promise<string> {
  const base = normalizeSlug(desired, fallback || String(cid)) || String(cid);
  let candidate = base;
  let suffix = 0;
  while (true) {
    const existing = await db.query.contents.findFirst({
      columns: { cid: true },
      where: and(
        eq(schema.contents.slug, candidate),
        ne(schema.contents.cid, cid),
        or(isNull(schema.contents.type), ne(schema.contents.type, 'revision')),
      ),
    });
    if (!existing) return candidate;
    suffix += 1;
    candidate = cid > 0
      ? (suffix === 1 ? `${base}-${cid}` : `${base}-${cid}-${suffix}`)
      : `${base}-${suffix + 1}`;
  }
}

/**
 * Resolve and persist a content slug, retrying only when another writer wins
 * the same slug between the availability read and the write.
 */
export async function writeWithUniqueContentSlug<T>(
  db: Database,
  desired: unknown,
  cid: number,
  write: (slug: string) => Promise<T>,
  fallback?: string,
): Promise<T> {
  for (let attempt = 0; attempt < CONTENT_SLUG_WRITE_ATTEMPTS; attempt++) {
    const slug = await resolveUniqueContentSlug(db, desired, cid, fallback);
    try {
      return await write(slug);
    } catch (error) {
      if (!isContentSlugUniqueConflict(error) || attempt === CONTENT_SLUG_WRITE_ATTEMPTS - 1) {
        throw error;
      }
    }
  }
  throw new Error('Content slug could not be made unique after bounded retries.');
}

/** Match only the partial unique constraint owned by content slug writes. */
export function isContentSlugUniqueConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error &&
      /unique constraint failed:\s*[`"']?typecho_contents\.slug\b/i.test(current.message)) {
      return true;
    }
    if (typeof current !== 'object') break;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function resolveUniqueMetaSlug(
  db: Database,
  desired: unknown,
  type: 'category' | 'tag',
  mid = 0,
  fallback = '',
): Promise<string> {
  const base = normalizeSlug(desired, fallback) || (mid ? String(mid) : type);
  let candidate = base;
  let suffix = 1;
  while (true) {
    const conditions = [eq(schema.metas.slug, candidate), eq(schema.metas.type, type)];
    if (mid) conditions.push(ne(schema.metas.mid, mid));
    const existing = await db.query.metas.findFirst({
      columns: { mid: true },
      where: and(...conditions),
    });
    if (!existing) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
}
