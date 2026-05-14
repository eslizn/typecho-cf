import { fetchWithTimeout, parsePluginOption } from 'typecho/plugin-sdk';
import type { PluginInitContext } from 'typecho/plugin-sdk';

interface AkismetConfig {
  apiKey: string;
  siteUrl: string;
  mode: 'spam' | 'reject';
  isTest: boolean;
  checkLoggedIn: boolean;
}

interface AkismetCommentData {
  _rejected?: string;
  status?: string;
  [key: string]: unknown;
}

interface FeedbackCommentExtra {
  options?: Record<string, unknown>;
  request?: Request;
  formData?: FormData;
  isLoggedIn?: boolean;
}

interface CommentActionExtra {
  action: string;
  oldStatus: string;
  newStatus: string;
  options?: Record<string, unknown>;
}

type CommentRow = {
  coid: number;
  cid: number;
  author?: string | null;
  mail?: string | null;
  url?: string | null;
  ip?: string | null;
  agent?: string | null;
  text?: string | null;
  type?: string | null;
  status?: string | null;
};

const DEFAULTS: AkismetConfig = {
  apiKey: '',
  siteUrl: '',
  mode: 'spam',
  isTest: false,
  checkLoggedIn: false,
};

const PLUGIN_ID = 'typecho-plugin-akismet';
const AKISMET_VERSION = '1.1';

function getConfig(options?: Record<string, unknown>): AkismetConfig {
  const raw = parsePluginOption(options?.[`plugin:${PLUGIN_ID}`]);
  return {
    apiKey: String(raw.apiKey || DEFAULTS.apiKey),
    siteUrl: String(raw.siteUrl || DEFAULTS.siteUrl),
    mode: raw.mode === 'reject' ? 'reject' : DEFAULTS.mode,
    isTest: raw.isTest === '1' || raw.isTest === true,
    checkLoggedIn: raw.checkLoggedIn === '1' || raw.checkLoggedIn === true,
  };
}

function getSiteUrl(config: AkismetConfig, options?: Record<string, unknown>): string {
  return config.siteUrl || String(options?.siteUrl || '');
}

function buildAkismetBody(
  comment: CommentRow,
  siteUrl: string,
  isTest: boolean,
  referrer?: string,
): URLSearchParams {
  const body = new URLSearchParams();
  body.append('blog', siteUrl);
  body.append('user_ip', String(comment.ip || ''));
  body.append('user_agent', String(comment.agent || ''));
  body.append('referrer', referrer || '');
  body.append('permalink', `${siteUrl.replace(/\/$/, '')}/archives/${comment.cid}/`);
  body.append('comment_type', String(comment.type || 'comment'));
  body.append('comment_author', String(comment.author || ''));
  body.append('comment_author_email', String(comment.mail || ''));
  body.append('comment_author_url', String(comment.url || ''));
  body.append('comment_content', String(comment.text || ''));
  body.append('blog_charset', 'UTF-8');

  if (isTest) {
    body.append('is_test', 'true');
  }

  return body;
}

async function callAkismet(
  apiKey: string,
  endpoint: string,
  body: URLSearchParams,
): Promise<string> {
  const resp = await fetchWithTimeout(
    `https://${apiKey}.rest.akismet.com/${AKISMET_VERSION}/${endpoint}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    10_000,
    'Akismet API request timed out',
  );

  if (!resp.ok) {
    console.error(`[akismet] API error (${resp.status}):`, await resp.text().catch(() => ''));
    throw new Error(`Akismet API returned ${resp.status}`);
  }

  return (await resp.text()).trim();
}

async function verifyKey(apiKey: string, siteUrl: string): Promise<boolean> {
  const body = new URLSearchParams({ key: apiKey, blog: siteUrl });
  try {
    const resp = await fetchWithTimeout(
      `https://rest.akismet.com/${AKISMET_VERSION}/verify-key`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      10_000,
      'Akismet key verification timed out',
    );
    const result = (await resp.text()).trim();
    return result === 'valid';
  } catch (err) {
    console.error('[akismet] Key verification error:', err);
    return false;
  }
}

export default function init({ addHook, pluginId }: PluginInitContext): void {
  // Check comment against Akismet before save
  addHook('feedback:comment', pluginId, async (
    commentData: AkismetCommentData,
    extra?: FeedbackCommentExtra,
  ) => {
    if (!extra?.options) return commentData;

    const config = getConfig(extra.options);
    if (!config.apiKey) return commentData;

    if (!config.checkLoggedIn && extra.isLoggedIn) return commentData;

    const siteUrl = getSiteUrl(config, extra.options);
    if (!siteUrl) return commentData;

    const referrer = extra.request?.headers.get('referer') || '';

    try {
      const body = buildAkismetBody(commentData as unknown as CommentRow, siteUrl, config.isTest, referrer);
      const result = await callAkismet(config.apiKey, 'comment-check', body);

      if (result === 'true') {
        if (config.mode === 'reject') {
          commentData._rejected = '您的评论已被识别为垃圾评论';
        } else {
          commentData.status = 'spam';
        }
      } else if (result === 'false') {
        // Not spam, do nothing
      } else {
        // Akismet returned an error message (invalid key, etc.)
        console.warn('[akismet] Unexpected response:', result);
      }
    } catch (err) {
      console.error('[akismet] Comment check error:', err);
      // On error, allow the comment through to avoid blocking legitimate comments
    }

    return commentData;
  });

  // Submit spam/ham feedback when comment status changes (fire-and-forget)
  addHook('comment:action', pluginId, (
    comment: CommentRow,
    extra?: CommentActionExtra,
  ) => {
    if (!extra?.options) return;

    const config = getConfig(extra.options);
    if (!config.apiKey) return;

    const siteUrl = getSiteUrl(config, extra.options);
    if (!siteUrl) return;

    const { oldStatus, newStatus } = extra;

    if (newStatus === 'spam' && oldStatus !== 'spam') {
      const body = buildAkismetBody(comment, siteUrl, false);
      callAkismet(config.apiKey, 'submit-spam', body).catch(
        err => console.error('[akismet] Submit spam error:', err),
      );
    }

    if (newStatus === 'approved' && oldStatus === 'spam') {
      const body = buildAkismetBody(comment, siteUrl, false);
      callAkismet(config.apiKey, 'submit-ham', body).catch(
        err => console.error('[akismet] Submit ham error:', err),
      );
    }
  });

  interface BeforeSaveResult {
    success: boolean;
    settings?: Record<string, unknown>;
    error?: string;
  }
  interface BeforeSaveExtra {
    pluginId: string;
    settings: Record<string, unknown>;
    options?: Record<string, unknown>;
  }

  // Validate API key when config is saved
  addHook('plugin:config:beforeSave', pluginId,
    async (result: BeforeSaveResult, extra: BeforeSaveExtra) => {
      if (extra?.pluginId !== pluginId) return result;

      try {
        const settings = extra.settings || {};
        const apiKey = String(settings.apiKey || '');
        const rawSiteUrl = String(settings.siteUrl || '');

        if (!apiKey) {
          return { success: false, error: '请输入 Akismet API Key' };
        }

        // Use configured site URL or fall back to existing options
        const siteUrl = rawSiteUrl || String(extra.options?.siteUrl || '');
        if (!siteUrl) {
          return { success: false, error: '请先设置站点地址' };
        }

        const valid = await verifyKey(apiKey, siteUrl);
        if (!valid) {
          return { success: false, error: 'API Key 验证失败，请检查 Key 和站点地址是否正确' };
        }

        return { success: true, settings };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : '验证异常' };
      }
    }
  );
}
