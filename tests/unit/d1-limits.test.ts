import { describe, expect, it } from 'vitest';
import {
  chunkArray,
  chunkInsertRows,
  D1_MAX_BOUND_PARAMS,
  D1_SAFE_IN_LIST_SIZE,
} from '@/lib/d1-limits';

describe('D1 parameter chunking', () => {
  it('exposes the documented D1 limit and a one-slot-safe IN size', () => {
    expect(D1_MAX_BOUND_PARAMS).toBe(100);
    expect(D1_SAFE_IN_LIST_SIZE).toBe(99);
  });

  it('chunks arrays in order without dropping items', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkArray([], 2)).toEqual([]);
    expect(() => chunkArray([1], 0)).toThrow(TypeError);
  });

  it('keeps the metas insert at or below 100 bound parameters', () => {
    // 17 tag rows would be 102 parameters with the six-value row shape.
    const rows = Array.from({ length: 17 }, (_, index) => index);
    const chunks = chunkInsertRows(rows, 6);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length * 6).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    }
    expect(chunks.flat()).toEqual(rows);
  });

  it('chunks relationship rows at 50 per statement', () => {
    const rows = Array.from({ length: 120 }, (_, index) => index);
    const chunks = chunkInsertRows(rows, 2);
    expect(chunks.map(chunk => chunk.length)).toEqual([50, 50, 20]);
  });
});
