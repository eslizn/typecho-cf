/**
 * Unit tests for src/lib/pagination.ts
 *
 * Tests pagination calculation, edge cases, and the pageSize <= 0 guard.
 */
import { describe, it, expect } from 'vitest';
import { paginate } from '@/lib/pagination';

describe('paginate()', () => {
  // ── Basic pagination ──
  it('calculates total pages correctly', () => {
    const result = paginate(50, 1, 10, '/');
    expect(result.totalPages).toBe(5);
    expect(result.totalItems).toBe(50);
    expect(result.pageSize).toBe(10);
  });

  it('returns correct current page', () => {
    const result = paginate(50, 3, 10, '/');
    expect(result.currentPage).toBe(3);
  });

  it('hasPrev is false on page 1', () => {
    const result = paginate(50, 1, 10, '/');
    expect(result.hasPrev).toBe(false);
    expect(result.prevUrl).toBeNull();
  });

  it('hasPrev is true on page 2+', () => {
    const result = paginate(50, 2, 10, '/');
    expect(result.hasPrev).toBe(true);
    expect(result.prevUrl).not.toBeNull();
  });

  it('hasNext is true when not on last page', () => {
    const result = paginate(50, 1, 10, '/');
    expect(result.hasNext).toBe(true);
    expect(result.nextUrl).not.toBeNull();
  });

  it('hasNext is false on last page', () => {
    const result = paginate(50, 5, 10, '/');
    expect(result.hasNext).toBe(false);
    expect(result.nextUrl).toBeNull();
  });

  // ── URL generation ──
  it('prevUrl points to base URL for page 1', () => {
    const result = paginate(50, 2, 10, '/blog/');
    expect(result.prevUrl).toBe('/blog/');
  });

  it('nextUrl includes page number', () => {
    const result = paginate(50, 1, 10, '/blog/');
    expect(result.nextUrl).toBe('/blog/page/2/');
  });

  it('handles base URL without trailing slash', () => {
    const result = paginate(50, 1, 10, '/blog');
    expect(result.nextUrl).toBe('/blog/page/2/');
  });

  // ── Edge cases ──
  it('clamps current page to valid range (too high)', () => {
    const result = paginate(50, 99, 10, '/');
    expect(result.currentPage).toBe(5); // max page
  });

  it('clamps current page to valid range (too low)', () => {
    const result = paginate(50, 0, 10, '/');
    expect(result.currentPage).toBe(1);
  });

  it('clamps current page to valid range (negative)', () => {
    const result = paginate(50, -5, 10, '/');
    expect(result.currentPage).toBe(1);
  });

  it('returns 1 total page when there are no items', () => {
    const result = paginate(0, 1, 10, '/');
    expect(result.totalPages).toBe(1);
    expect(result.hasNext).toBe(false);
    expect(result.hasPrev).toBe(false);
  });

  it('handles single item', () => {
    const result = paginate(1, 1, 10, '/');
    expect(result.totalPages).toBe(1);
    expect(result.pages).toEqual([1]);
  });

  // ── pageSize guard (division by zero fix) ──
  it('handles pageSize of 0 without crashing', () => {
    const result = paginate(50, 1, 0, '/');
    expect(result.totalPages).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(result.totalPages)).toBe(true);
  });

  it('handles negative pageSize without crashing', () => {
    const result = paginate(50, 1, -5, '/');
    expect(result.totalPages).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(result.totalPages)).toBe(true);
  });

  // ── Visible pages array ──
  it('generates correct visible pages for middle page', () => {
    const result = paginate(200, 10, 10, '/');
    expect(result.pages).toContain(10);
    expect(result.pages.length).toBeLessThanOrEqual(10);
  });

  it('visible pages start from 1 for early pages', () => {
    const result = paginate(200, 1, 10, '/');
    expect(result.pages[0]).toBe(1);
  });

  it('visible pages end at totalPages for late pages', () => {
    const result = paginate(200, 20, 10, '/');
    expect(result.pages[result.pages.length - 1]).toBe(20);
  });

  it('rounds up total pages for non-exact division', () => {
    const result = paginate(51, 1, 10, '/');
    expect(result.totalPages).toBe(6); // ceil(51/10) = 6
  });
});
