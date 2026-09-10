/**
 * Unit tests for the runtime FTS5 search index helpers (src/lib/fulltext.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTENTS_FTS_TABLE,
  FTS_MIN_CHARS,
  buildFtsMatchExpression,
  contentsFtsSql,
  ftsRebuildStatement,
  isFtsAvailable,
  resetFtsAvailability,
  setFtsAvailable,
} from '@/lib/fulltext';

afterEach(() => {
  resetFtsAvailability();
});

describe('fulltext FTS5 helpers', () => {
  it('requires at least 3 characters for the trigram tokenizer', () => {
    expect(FTS_MIN_CHARS).toBe(3);
    expect(CONTENTS_FTS_TABLE).toBe('typecho_contents_fts');
  });

  it('emits idempotent virtual-table DDL with trigram tokenizer and sync triggers', () => {
    const sql = contentsFtsSql().join('\n');
    expect(sql).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS `typecho_contents_fts` USING fts5');
    expect(sql).toContain("tokenize='trigram'");
    expect(sql).toContain("content='typecho_contents'");
    expect(sql).toContain("content_rowid='cid'");
    for (const trigger of ['typecho_contents_fts_ai', 'typecho_contents_fts_ad', 'typecho_contents_fts_au']) {
      expect(sql).toContain(`CREATE TRIGGER IF NOT EXISTS ${trigger}`);
    }
  });

  it('emits a rebuild statement for external-content backfill', () => {
    expect(ftsRebuildStatement()).toBe(
      "INSERT INTO `typecho_contents_fts`(`typecho_contents_fts`) VALUES ('rebuild')",
    );
  });

  it('builds an AND-combined quoted MATCH expression per whitespace term', () => {
    expect(buildFtsMatchExpression('  hello   world ')).toBe('"hello" "world"');
  });

  it('doubles embedded double quotes per FTS5 escaping rules', () => {
    expect(buildFtsMatchExpression('say "hi" now')).toBe('"say" """hi""" "now"');
  });

  it('treats the pre-boot state as unavailable and flips on setFtsAvailable', () => {
    // Before bootstrap confirms the virtual table exists, search must fall back
    // to LIKE: isolate-boot defers FTS creation to waitUntil() on upgrades.
    expect(isFtsAvailable()).toBe(false);
    setFtsAvailable(true);
    expect(isFtsAvailable()).toBe(true);
    setFtsAvailable(false);
    expect(isFtsAvailable()).toBe(false);
    resetFtsAvailability();
    expect(isFtsAvailable()).toBe(false);
  });
});
