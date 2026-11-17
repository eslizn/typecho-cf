import { describe, expect, it } from 'vitest';
import { buildCommentTree } from '@/lib/page-data/comments';
import type { CommentNode } from '@/lib/theme-props';
import type { SiteOptions } from '@/lib/options';
import type { CommentRow } from '@/lib/page-data/common';

function chain(length: number): CommentRow[] {
  return Array.from({ length }, (_, index) => ({
    coid: index + 1,
    cid: 1,
    parent: index === 0 ? 0 : index,
    created: index + 1,
    author: `author-${index}`,
    authorId: 0,
    ownerId: 0,
    mail: '',
    url: '',
    ip: '',
    agent: '',
    text: `comment-${index}`,
    type: 'comment',
    status: 'approved',
  }));
}

function maxDepth(nodes: readonly CommentNode[]): number {
  return nodes.reduce((depth, node) => Math.max(depth, 1 + maxDepth(node.children)), 0);
}

const options = {
  commentsThreaded: 1,
  commentsMaxNestingLevels: 5,
  commentsMarkdown: 0,
  commentsHTMLTagAllowed: null,
} as SiteOptions;

const ctx = { activatedPlugins: new Set<string>() } as any;

describe('buildCommentTree nesting limit', () => {
  it('flattens comments beyond commentsMaxNestingLevels like Typecho', async () => {
    const tree = await buildCommentTree(ctx, chain(12), options);

    expect(tree).toHaveLength(1);
    expect(maxDepth(tree)).toBe(5);

    const level4 = tree[0].children[0].children[0].children[0];
    expect(level4.coid).toBe(4);
    expect(level4.children.map(node => node.coid)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('returns a flat list when threading is disabled', async () => {
    const tree = await buildCommentTree(ctx, chain(4), {
      ...options,
      commentsThreaded: 0,
    } as SiteOptions);
    expect(tree.map(node => node.coid)).toEqual([1, 2, 3, 4]);
    expect(tree.every(node => node.children.length === 0)).toBe(true);
  });

  it('treats a missing parent as a root', async () => {
    const orphan: CommentRow = {
      ...chain(1)[0],
      coid: 99,
      parent: 12345,
    };
    const tree = await buildCommentTree(ctx, [orphan], options);
    expect(tree.map(node => node.coid)).toEqual([99]);
  });
});
