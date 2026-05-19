/**
 * G4-1 verifies that schema-sql emits the new compound + author/group
 * indexes that backfill from middleware bootstrap.
 */
import { describe, it, expect } from 'vitest';
import { generateCreateSQL, generateIndexSQL } from '@/lib/schema-sql';

describe('schema-sql index emission (G4-1)', () => {
  const create = generateCreateSQL().join('\n');
  const index = generateIndexSQL().join('\n');

  it('emits the new content compound index', () => {
    expect(create).toContain('typecho_contents_type_status');
    expect(index).toContain('typecho_contents_type_status');
  });

  it('emits the authorId scan helper', () => {
    expect(index).toContain('typecho_contents_authorId');
  });

  it('emits the relationships.mid index for category/tag walks', () => {
    expect(index).toContain('typecho_relationships_mid');
  });

  it('emits the comment status+owner composite', () => {
    expect(index).toContain('typecho_comments_status_owner');
  });

  it('emits the user.group index', () => {
    expect(index).toContain('typecho_users_group');
  });

  it('emits the meta type+slug composite', () => {
    expect(index).toContain('typecho_metas_type_slug');
  });

  it('every emitted index uses CREATE INDEX IF NOT EXISTS for idempotent backfill', () => {
    for (const stmt of generateIndexSQL()) {
      expect(stmt).toMatch(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/);
    }
  });

  it('generateIndexSQL is a strict subset of generateCreateSQL', () => {
    const all = new Set(generateCreateSQL());
    for (const stmt of generateIndexSQL()) {
      expect(all.has(stmt)).toBe(true);
    }
  });
});
