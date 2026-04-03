import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { setOption, getOption } from '@/lib/options';
import { hashPassword, generateRandomString } from '@/lib/auth';
import { env } from 'cloudflare:workers';
import { generateCreateSQL } from '@/lib/schema-sql';

/**
 * Create all tables and indexes from Drizzle schema definitions.
 * Source of truth: src/db/schema.ts (no migration files needed).
 */
async function ensureTables(d1: D1Database): Promise<void> {
  const statements = generateCreateSQL();
  // D1 batch() executes all statements in a single round-trip
  await d1.batch(statements.map(sql => d1.prepare(sql)));
}

export const POST: APIRoute = async ({ request, locals }) => {
  const d1 = env.DB;
  const db = getDb(d1);

  const formData = await request.formData();
  const siteTitle = formData.get('siteTitle')?.toString() || 'Hello World';
  const siteDescription = formData.get('siteDescription')?.toString() || '';
  const userName = formData.get('userName')?.toString()?.trim() || '';
  const userPassword = formData.get('userPassword')?.toString() || '';
  const userMail = formData.get('userMail')?.toString()?.trim() || '';

  if (!userName || !userPassword || !userMail) {
    return new Response('请填写完整信息', { status: 400 });
  }

  if (userPassword.length < 6) {
    return new Response('密码长度至少6位', { status: 400 });
  }

  try {
    // Auto-create tables if they don't exist
    await ensureTables(d1);

    // Check if already installed
    const installed = await getOption(db, 'installed');
    if (installed === '1') {
      return new Response(null, {
        status: 302,
        headers: { Location: '/admin/' },
      });
    }

    // Create admin user
    const hashedPassword = await hashPassword(userPassword);
    const authCode = generateRandomString(32);
    const now = Math.floor(Date.now() / 1000);

    await db.insert(schema.users).values({
      name: userName,
      password: hashedPassword,
      mail: userMail,
      url: new URL(request.url).origin,
      screenName: userName,
      created: now,
      activated: now,
      logged: now,
      group: 'administrator',
      authCode,
    });

    // Create default category
    await db.insert(schema.metas).values({
      name: '默认分类',
      slug: 'default',
      type: 'category',
      description: '只是一个默认分类',
      count: 1,
      order: 1,
    });

    // Create welcome post
    await db.insert(schema.contents).values({
      title: '欢迎使用 Typecho',
      slug: 'hello-world',
      created: now,
      modified: now,
      text: '<!--markdown-->欢迎使用 Typecho 博客系统。这是你的第一篇文章，你可以编辑或删除它，然后开始写作！\n\n## 关于 Typecho\n\nTypecho 是一个基于 **Astro + Cloudflare Workers + D1** 构建的现代博客系统。\n\n- 极速响应：基于 Cloudflare 边缘网络\n- Markdown 支持：使用 Markdown 撰写文章\n- 简洁高效：保持博客系统的简约之道',
      authorId: 1,
      type: 'post',
      status: 'publish',
      allowComment: '1',
      allowPing: '1',
      allowFeed: '1',
    });

    // Link post to default category
    await db.insert(schema.relationships).values({ cid: 1, mid: 1 });

    // Create about page
    await db.insert(schema.contents).values({
      title: '关于',
      slug: 'about',
      created: now,
      modified: now,
      text: '<!--markdown-->这是一个关于页面的示例。你可以在后台管理中编辑它。',
      authorId: 1,
      type: 'page',
      status: 'publish',
      allowComment: '1',
      allowPing: '0',
      allowFeed: '1',
      order: 0,
    });

    // Set default options
    const siteUrl = new URL(request.url).origin;
    const secret = generateRandomString(32);

    const defaultOptions: Record<string, string> = {
      theme: 'typecho-theme-minimal',
      timezone: '28800',
      lang: 'zh_CN',
      charset: 'UTF-8',
      contentType: 'text/html',
      title: siteTitle,
      description: siteDescription,
      keywords: 'blog',
      siteUrl,
      frontPage: 'recent',
      frontArchive: '0',
      pageSize: '5',
      postsListSize: '10',
      commentsListSize: '10',
      postDateFormat: 'Y-m-d',
      commentDateFormat: 'Y-m-d H:i',
      defaultCategory: '1',
      allowRegister: '0',
      defaultAllowComment: '1',
      defaultAllowPing: '1',
      defaultAllowFeed: '1',
      feedFullText: '1',
      markdown: '1',
      commentsRequireMail: '1',
      commentsRequireURL: '0',
      commentsRequireModeration: '0',
      commentsWhitelist: '0',
      commentsMaxNestingLevels: '5',
      commentsPostTimeout: String(24 * 3600 * 30),
      commentsUrlNofollow: '1',
      commentsShowUrl: '1',
      commentsMarkdown: '0',
      commentsPageBreak: '0',
      commentsThreaded: '1',
      commentsPageSize: '20',
      commentsPageDisplay: 'last',
      commentsOrder: 'ASC',
      commentsCheckReferer: '1',
      commentsAutoClose: '0',
      commentsPostIntervalEnable: '1',
      commentsPostInterval: '60',
      commentsShowCommentOnly: '0',
      commentsAvatar: '1',
      commentsAvatarRating: 'G',
      commentsAntiSpam: '1',
      attachmentTypes: '@image@',
      secret,
      installed: '1',
      allowXmlRpc: '2',
      editorSize: '350',
      autoSave: '0',
      xmlrpcMarkdown: '0',
    };

    for (const [key, value] of Object.entries(defaultOptions)) {
      await setOption(db, key, value);
    }

    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/login' },
    });
  } catch (error) {
    console.error('Installation error:', error);
    return new Response('安装失败，请检查数据库配置', {
      status: 500,
    });
  }
};
