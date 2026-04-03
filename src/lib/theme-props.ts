/**
 * Theme template Props interfaces
 *
 * These interfaces define the data contract between page routes and theme components.
 * Theme authors implement Astro components that receive these Props.
 * Only frontend (blog) pages are covered — admin pages are not part of the theme system.
 */
import type { SiteOptions, computeUrls } from '@/lib/options';
import type { SidebarData } from '@/lib/sidebar';
import type { PaginationInfo } from '@/lib/pagination';
import type { UserRow } from '@/lib/context';

// ─── Base Props (shared by all theme components) ────────────────────────

export interface ThemeBaseProps {
  /** Site configuration */
  options: SiteOptions;
  /** Computed URL set (siteUrl, adminUrl, feedUrl, etc.) */
  urls: ReturnType<typeof computeUrls>;
  /** Currently logged-in user (null = anonymous) */
  user: UserRow | null;
  /** Whether a user is logged in */
  isLoggedIn: boolean;
  /** Navigation pages (published pages shown in header nav) */
  pages: Array<{ title: string; slug: string; permalink: string }>;
  /** Sidebar widget data */
  sidebarData: SidebarData;
  /** Current request path */
  currentPath: string;
}

// ─── Post list item (used by Index & Archive) ───────────────────────────

export interface PostListItem {
  cid: number;
  title: string;
  permalink: string;
  /** Rendered HTML excerpt (with <!--more--> support) */
  excerpt: string;
  created: number;
  commentsNum: number;
  author: { uid: number; name: string; screenName: string } | null;
  categories: Array<{ name: string; slug: string; permalink: string }>;
}

// ─── Index (home page) ──────────────────────────────────────────────────

export interface ThemeIndexProps extends ThemeBaseProps {
  posts: PostListItem[];
  pagination: PaginationInfo;
}

// ─── Post detail ────────────────────────────────────────────────────────

export interface ThemePostProps extends ThemeBaseProps {
  post: {
    cid: number;
    title: string;
    permalink: string;
    /** Rendered HTML content */
    content: string;
    created: number;
    modified: number | null;
    commentsNum: number;
    allowComment: boolean;
    /** Whether the post is password-protected */
    hasPassword: boolean;
    /** Whether the user has supplied the correct password */
    passwordVerified: boolean;
  };
  author: { uid: number; name: string; screenName: string } | null;
  categories: Array<{ name: string; slug: string; permalink: string }>;
  tags: Array<{ name: string; slug: string; permalink: string }>;
  comments: CommentNode[];
  commentOptions: CommentOptions;
  prevPost: { title: string; permalink: string } | null;
  nextPost: { title: string; permalink: string } | null;
  gravatarMap: Record<number, string>;
}

// ─── Independent page ───────────────────────────────────────────────────

export interface ThemePageProps extends ThemeBaseProps {
  page: {
    cid: number;
    title: string;
    slug: string;
    permalink: string;
    /** Rendered HTML content */
    content: string;
    created: number;
    allowComment: boolean;
    hasPassword: boolean;
    passwordVerified: boolean;
  };
  comments: CommentNode[];
  commentOptions: CommentOptions;
  gravatarMap: Record<number, string>;
}

// ─── Archive (category / tag / author / search) ─────────────────────────

export interface ThemeArchiveProps extends ThemeBaseProps {
  /** Display title, e.g. "分类 技术 下的文章" */
  archiveTitle: string;
  archiveType: 'category' | 'tag' | 'author' | 'search';
  posts: PostListItem[];
  pagination: PaginationInfo;
}

// ─── Shared sub-types ───────────────────────────────────────────────────

export interface CommentNode {
  coid: number;
  author: string;
  mail: string;
  url: string;
  /** Rendered HTML */
  text: string;
  created: number;
  children: CommentNode[];
}

export interface CommentOptions {
  allowComment: boolean;
  requireMail: boolean;
  showUrl: boolean;
  showAvatar: boolean;
  avatarRating: string;
  order: 'ASC' | 'DESC';
  /** Date format string for comments */
  dateFormat: string;
  /** Timezone offset in seconds */
  timezone: number;
}

// ─── 404 Not Found ──────────────────────────────────────────────────────

export interface ThemeNotFoundProps extends ThemeBaseProps {
  /** HTTP status code (404) */
  statusCode: number;
  /** Error title for display */
  errorTitle: string;
}

// ─── Theme template component map ───────────────────────────────────────

export interface ThemeTemplateMap {
  Index?: (_props: ThemeIndexProps) => any;
  Post?: (_props: ThemePostProps) => any;
  Page?: (_props: ThemePageProps) => any;
  Archive?: (_props: ThemeArchiveProps) => any;
  NotFound?: (_props: ThemeNotFoundProps) => any;
}
