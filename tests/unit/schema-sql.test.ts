import { describe, expect, it } from 'vitest';
import { generateCreateSQL } from '@/lib/schema-sql';

describe('generateCreateSQL', () => {
  it('generates CREATE TABLE statements for all 7 tables', () => {
    const stmts = generateCreateSQL();

    const createTableStmts = stmts.filter(s => s.startsWith('CREATE TABLE IF NOT EXISTS'));
    expect(createTableStmts.length).toBe(7);

    const tableNames = createTableStmts.map(s => {
      const match = s.match(/`(typecho_\w+)`/);
      return match ? match[1] : '';
    });
    expect(tableNames).toContain('typecho_users');
    expect(tableNames).toContain('typecho_contents');
    expect(tableNames).toContain('typecho_comments');
    expect(tableNames).toContain('typecho_metas');
    expect(tableNames).toContain('typecho_relationships');
    expect(tableNames).toContain('typecho_options');
    expect(tableNames).toContain('typecho_fields');
  });

  it('generates CREATE INDEX statements for unique indexes', () => {
    const stmts = generateCreateSQL();

    const uniqueIndexes = stmts.filter(s => s.startsWith('CREATE UNIQUE INDEX'));
    // users_name, users_mail, contents_slug, relationships_cid_mid, options_name_user, fields_cid_name
    expect(uniqueIndexes.length).toBe(6);

    const indexNames = uniqueIndexes.map(s => {
      const match = s.match(/`(typecho_\w+)`/);
      return match ? match[1] : '';
    });
    expect(indexNames).toContain('typecho_users_name');
    expect(indexNames).toContain('typecho_users_mail');
    expect(indexNames).toContain('typecho_contents_slug');
    expect(indexNames).toContain('typecho_relationships_cid_mid');
    expect(indexNames).toContain('typecho_options_name_user');
    expect(indexNames).toContain('typecho_fields_cid_name');
  });

  it('generates plain CREATE INDEX statements', () => {
    const stmts = generateCreateSQL();
    const plainIndexes = stmts.filter(s => s.startsWith('CREATE INDEX IF NOT EXISTS'));
    expect(plainIndexes.length).toBeGreaterThan(0);
    expect(plainIndexes.some(s => s.includes('typecho_contents_created'))).toBe(true);
    expect(plainIndexes.some(s => s.includes('typecho_comments_cid'))).toBe(true);
  });

  it('does not generate duplicate statements', () => {
    const stmts = generateCreateSQL();
    const unique = new Set(stmts);
    expect(unique.size).toBe(stmts.length);
  });

  it('generates valid SQL syntax (no consecutive commas or missing keywords)', () => {
    const stmts = generateCreateSQL();
    for (const stmt of stmts) {
      expect(stmt).not.toMatch(/,\s*,/); // no consecutive commas
      expect(stmt).not.toMatch(/,\s*\)/); // no trailing comma before closing paren
      expect(stmt).toMatch(/^CREATE/); // starts with CREATE
      expect(stmt).toMatch(/\(/); // has opening paren for columns
    }
  });
});
