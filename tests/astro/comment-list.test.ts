/**
 * Render tests for the theme comment list depth/threading guards.
 *
 * Typecho hides reply links and child lists when threading is disabled and
 * once a comment reaches the configured nesting limit.
 */
import { describe, expect, it } from 'vitest';
import CommentList from '@/themes/typecho-theme-minimal/components/CommentList.astro';
import { renderComponent, testI18n } from './helpers';

const child = {
  coid: 2,
  author: 'Bob',
  mail: '',
  url: '',
  text: '<p>Reply</p>',
  created: 1_700_000_100,
  children: [],
};

const comment = {
  coid: 1,
  author: 'Alice',
  mail: '',
  url: '',
  text: '<p>Hello</p>',
  created: 1_700_000_000,
  children: [child],
};

function commentOptions(overrides: Record<string, unknown> = {}) {
  return {
    allowComment: true,
    requireMail: false,
    showUrl: true,
    showAvatar: false,
    avatarRating: 'G',
    order: 'ASC',
    dateFormat: 'Y-m-d',
    timezone: 'UTC',
    securityToken: '',
    showCommentOnly: false,
    markdown: false,
    urlNofollow: true,
    threaded: true,
    maxNestingLevels: 5,
    pageBreak: false,
    pageSize: 20,
    pageDisplay: 'first',
    htmlTagAllowed: '',
    ...overrides,
  } as any;
}

function render(depth: number, options: Record<string, unknown>) {
  return renderComponent(CommentList, {
    props: {
      comments: [comment],
      commentOptions: commentOptions(options),
      gravatarMap: {},
      permalink: 'https://example.com/post/',
      i18n: testI18n('en'),
      depth,
    },
  });
}

describe('theme comment list', () => {
  it('shows reply links and children below the nesting limit', async () => {
    const html = await render(0, {});
    expect(html).toContain('comment-reply-link');
    expect(html).toContain('comment-children');
  });

  it('hides reply links and children at the last allowed level', async () => {
    const html = await render(4, {});
    expect(html).toContain('Hello');
    expect(html).not.toContain('comment-reply-link');
    expect(html).not.toContain('comment-children');
  });

  it('hides reply links when comment threading is disabled', async () => {
    const html = await render(0, { threaded: false });
    expect(html).toContain('Hello');
    expect(html).not.toContain('comment-reply-link');
    expect(html).not.toContain('comment-children');
  });
});
