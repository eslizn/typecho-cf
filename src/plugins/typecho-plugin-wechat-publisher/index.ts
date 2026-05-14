import { buildPermalink, escapeAttr, escapeHtml, fetchWithTimeout, getOption, hasPermission, normalizeHttpUrl, parseAttachmentMeta, parsePluginOption, renderMarkdown, setOption, stripHtmlTags, stripTypechoMarkers } from 'typecho/plugin-sdk';
import type { PluginInitContext } from 'typecho/plugin-sdk';
import type { Database } from 'typecho/db';
import { schema } from 'typecho/db';
import { and, eq } from 'drizzle-orm';
import sanitizeHtml from 'sanitize-html';

const PLUGIN_ID = 'typecho-plugin-wechat-publisher';
const WECHAT_API_BASE = 'https://api.weixin.qq.com';

interface WeChatMpConfig {
  appId: string;
  appSecret: string;
  author: string;
  defaultCoverUrl: string;
  sourceUrlMode: 'permalink' | 'empty';
  needOpenComment: '0' | '1';
  onlyFansCanComment: '0' | '1';
}

interface PluginActionResult {
  handled?: boolean;
  success?: boolean;
  error?: string;
  mediaId?: string;
  mode?: 'created' | 'updated';
  uploadedImages?: number;
}

interface SyncPayload {
  cid?: number | string;
}

interface WeChatJson {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  media_id?: string;
  url?: string;
}

interface WeChatArticle {
  title: string;
  author: string;
  digest: string;
  content: string;
  content_source_url: string;
  thumb_media_id: string;
  need_open_comment: number;
  only_fans_can_comment: number;
}

interface SyncState {
  mediaId: string;
  updatedAt: number;
}

class WeChatApiError extends Error {
  errcode?: number;

  constructor(label: string, message: string, errcode?: number) {
    super(`${label}失败：${message}`);
    this.name = 'WeChatApiError';
    this.errcode = errcode;
  }
}

const DEFAULTS: WeChatMpConfig = {
  appId: '',
  appSecret: '',
  author: '',
  defaultCoverUrl: '',
  sourceUrlMode: 'permalink',
  needOpenComment: '0',
  onlyFansCanComment: '0',
};

const WECHAT_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'pre', 'code',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'img', 'a', 'hr', 'span', 'section',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    '*': ['style'],
  },
  allowedSchemes: ['http', 'https', 'data'],
};

function getConfig(options?: Record<string, unknown>): WeChatMpConfig {
  const config = {
    ...DEFAULTS,
    ...parsePluginOption(options?.[`plugin:${PLUGIN_ID}`]),
  };
  return {
    appId: String(config.appId || '').trim(),
    appSecret: String(config.appSecret || '').trim(),
    author: String(config.author || '').trim(),
    defaultCoverUrl: String(config.defaultCoverUrl || '').trim(),
    sourceUrlMode: config.sourceUrlMode === 'empty' ? 'empty' : 'permalink',
    needOpenComment: config.needOpenComment === '1' ? '1' : '0',
    onlyFansCanComment: config.onlyFansCanComment === '1' ? '1' : '0',
  };
}

export function normalizeConfig(settings?: Record<string, unknown>): WeChatMpConfig {
  const config = getConfig({ [`plugin:${PLUGIN_ID}`]: settings || {} });
  if (!config.appId || !config.appSecret) {
    throw new Error('请填写微信公众号 AppID 和 AppSecret');
  }
  if (config.defaultCoverUrl && !normalizeHttpUrl(config.defaultCoverUrl)) {
    throw new Error('默认封面图片 URL 格式不正确，必须使用 http 或 https');
  }
  return config;
}

function autopEscaped(text: string): string {
  return text
    .replace(/\r\n|\r/g, '\n')
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => `<p>${escapeHtml(part).replace(/\n/g, '<br />')}</p>`)
    .join('\n');
}

export function renderWeChatHtml(text: string): string {
  if (!text) return '';
  const source = text.trim();
  let html: string;
  if (source.startsWith('<!--markdown-->')) {
    html = renderMarkdown(source);
  } else if (/<\/?[a-z][\s\S]*>/i.test(source)) {
    html = source.replace(/<!--more-->/g, '');
  } else {
    html = autopEscaped(stripTypechoMarkers(source));
  }
  return sanitizeHtml(html, WECHAT_SANITIZE_OPTIONS);
}

export function extractImageUrls(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    const url = (match[1] || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function absoluteUrl(url: string, siteUrl?: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  const base = siteUrl || 'https://typecho-cf.local';
  return new URL(url, base.endsWith('/') ? base : `${base}/`).toString();
}

function replaceImageUrls(html: string, replacements: Map<string, string>): string {
  return html.replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi, (all, prefix, src, suffix) => {
    const next = replacements.get(src);
    return next ? `${prefix}${escapeAttr(next)}${suffix}` : all;
  });
}

function filenameFromUrl(url: string, contentType = ''): string {
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split('/').pop();
    if (name) return name;
  } catch {}
  if (contentType.includes('png')) return 'image.png';
  if (contentType.includes('gif')) return 'image.gif';
  if (contentType.includes('webp')) return 'image.webp';
  return 'image.jpg';
}

async function requestWeChatJson(url: string, init: RequestInit, label: string): Promise<WeChatJson> {
  const response = await fetchWithTimeout(url, init, 12_000, '微信公众号接口请求超时');
  const data = await response.json().catch(() => null) as WeChatJson | null;
  if (!response.ok || !data || (typeof data.errcode === 'number' && data.errcode !== 0)) {
    const message = data?.errmsg || response.statusText || '未知错误';
    throw new WeChatApiError(label, message, data?.errcode);
  }
  return data;
}

async function getAccessToken(config: WeChatMpConfig): Promise<string> {
  const params = new URLSearchParams({
    grant_type: 'client_credential',
    appid: config.appId,
    secret: config.appSecret,
  });
  const data = await requestWeChatJson(`${WECHAT_API_BASE}/cgi-bin/token?${params.toString()}`, {
    method: 'GET',
  }, '获取 access_token');
  if (!data.access_token) throw new Error('微信公众号未返回 access_token');
  return data.access_token;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
async function getAccessTokenCached(config: WeChatMpConfig): Promise<string> {
  const cached = tokenCache.get(config.appId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const token = await getAccessToken(config);
  tokenCache.set(config.appId, { token, expiresAt: Date.now() + 7_000_000 });
  return token;
}

async function fetchImageBlob(url: string): Promise<{ blob: Blob; filename: string }> {
  const response = await fetchWithTimeout(url, { method: 'GET' });
  if (!response.ok) throw new Error(`读取图片失败：${response.status}`);
  const blob = await response.blob();
  const contentType = response.headers.get('Content-Type') || blob.type || 'image/jpeg';
  if (!contentType.startsWith('image/')) throw new Error(`不是可上传的图片：${url}`);
  return {
    blob: blob.type ? blob : new Blob([blob], { type: contentType }),
    filename: filenameFromUrl(url, contentType),
  };
}

async function uploadImage(
  accessToken: string,
  imageUrl: string,
  label: string,
  endpoint: string,
  extraParams?: Record<string, string>,
): Promise<WeChatJson> {
  const image = await fetchImageBlob(imageUrl);
  const formData = new FormData();
  formData.append('media', image.blob, image.filename);
  const params = new URLSearchParams({ access_token: accessToken, ...(extraParams || {}) });
  return requestWeChatJson(`${WECHAT_API_BASE}${endpoint}?${params.toString()}`, {
    method: 'POST',
    body: formData,
  }, label);
}

async function uploadCoverImage(accessToken: string, imageUrl: string): Promise<string> {
  const data = await uploadImage(accessToken, imageUrl, '上传封面素材', '/cgi-bin/material/add_material', { type: 'image' });
  if (!data.media_id) throw new Error('微信公众号未返回封面素材 media_id');
  return data.media_id;
}

async function uploadArticleImage(accessToken: string, imageUrl: string): Promise<string> {
  const data = await uploadImage(accessToken, imageUrl, '上传正文图片', '/cgi-bin/media/uploadimg');
  if (!data.url) throw new Error('微信公众号未返回正文图片 URL');
  return data.url;
}

function plainDigest(html: string): string {
  return stripHtmlTags(html).slice(0, 120);
}

async function loadAuthorName(db: Database | undefined, authorId: number | null | undefined): Promise<string> {
  if (!db || !authorId) return '';
  const user = await db.query.users.findFirst({
    where: eq(schema.users.uid, authorId),
  }).catch(() => null);
  return user?.screenName || user?.name || '';
}

async function loadAttachmentCover(db: Database | undefined, cid: number): Promise<string> {
  if (!db) return '';
  const attachments = await db.query.contents.findMany({
    where: and(eq(schema.contents.parent, cid), eq(schema.contents.type, 'attachment')),
  }).catch(() => []);
  for (const attachment of attachments) {
    const meta = parseAttachmentMeta(attachment.text);
    if (meta.url && meta.type?.startsWith('image/')) return meta.url;
  }
  return '';
}

function syncStateOptionName(cid: number): string {
  return `plugin:${PLUGIN_ID}:post:${cid}`;
}

function parseSyncState(value: string | null | undefined): SyncState | null {
  if (!value) return null;
  try {
    const data = JSON.parse(value) as Record<string, unknown>;
    const mediaId = typeof data.mediaId === 'string' ? data.mediaId.trim() : '';
    const updatedAt = Number(data.updatedAt);
    return mediaId ? { mediaId, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 } : null;
  } catch {
    return null;
  }
}

async function loadLegacySyncState(db: Database, cid: number): Promise<SyncState | null> {
  const row = await db.query.fields.findFirst({
    where: and(eq(schema.fields.cid, cid), eq(schema.fields.name, 'wechat_publisher_draft_media_id')),
  }).catch(() => null);
  const mediaId = row?.str_value?.trim();
  return mediaId ? { mediaId, updatedAt: 0 } : null;
}

async function loadSyncState(db: Database, cid: number): Promise<SyncState | null> {
  const state = parseSyncState(await getOption(db, syncStateOptionName(cid)));
  if (state) return state;

  const legacyState = await loadLegacySyncState(db, cid);
  if (legacyState) {
    await saveSyncState(db, cid, legacyState.mediaId);
  }
  return legacyState;
}

async function saveSyncState(db: Database, cid: number, mediaId: string): Promise<void> {
  await setOption(db, syncStateOptionName(cid), JSON.stringify({
    mediaId,
    updatedAt: Math.floor(Date.now() / 1000),
  }));
}

async function addDraft(accessToken: string, article: WeChatArticle): Promise<string> {
  const data = await requestWeChatJson(`${WECHAT_API_BASE}/cgi-bin/draft/add?access_token=${encodeURIComponent(accessToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ articles: [article] }),
  }, '创建公众号草稿');
  if (!data.media_id) throw new Error('微信公众号未返回草稿 media_id');
  return data.media_id;
}

async function updateDraft(accessToken: string, mediaId: string, article: WeChatArticle): Promise<void> {
  await requestWeChatJson(`${WECHAT_API_BASE}/cgi-bin/draft/update?access_token=${encodeURIComponent(accessToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_id: mediaId,
      index: 0,
      articles: article,
    }),
  }, '更新公众号草稿');
}

function isStaleDraftError(error: unknown): boolean {
  if (!(error instanceof WeChatApiError)) return false;
  if ([40007, 40008].includes(Number(error.errcode))) return true;
  return /media_id|草稿|draft|not\s*exist|invalid/i.test(error.message);
}

async function syncPostToWeChat(
  db: Database | undefined,
  options: Record<string, unknown> | undefined,
  payload: SyncPayload,
  user?: { uid?: number | null; group?: string | null; screenName?: string | null; name?: string | null },
): Promise<PluginActionResult> {
  const config = normalizeConfig(parsePluginOption(options?.[`plugin:${PLUGIN_ID}`]));
  const cid = Number(payload.cid);
  if (!Number.isInteger(cid) || cid <= 0) throw new Error('文章 ID 不正确');
  if (!db) throw new Error('数据库不可用');

  const post = await db.query.contents.findFirst({
    where: eq(schema.contents.cid, cid),
  });
  if (!post || !['post', 'post_draft'].includes(post.type || '')) {
    throw new Error('文章不存在或不是文章类型');
  }
  if (!hasPermission(user?.group || 'visitor', 'editor') && post.authorId !== user?.uid) {
    throw new Error('没有权限同步这篇文章');
  }

  const siteUrl = typeof options?.siteUrl === 'string' ? options.siteUrl : '';
  let html = renderWeChatHtml(post.text || '');
  const imageUrls = extractImageUrls(html);
  const coverSource = imageUrls[0]
    || await loadAttachmentCover(db, cid)
    || config.defaultCoverUrl;
  if (!coverSource) {
    throw new Error('微信公众号草稿需要封面图，请在正文添加图片或配置默认封面图片 URL');
  }

  const accessToken = await getAccessTokenCached(config);
  const uploadResults = await Promise.all(imageUrls.map(async (src) => {
    const uploadedUrl = await uploadArticleImage(accessToken, absoluteUrl(src, siteUrl));
    return [src, uploadedUrl] as const;
  }));
  const replacements = new Map<string, string>(uploadResults);
  html = replaceImageUrls(html, replacements);

  const coverMediaId = await uploadCoverImage(accessToken, absoluteUrl(coverSource, siteUrl));
  const authorName = config.author
    || await loadAuthorName(db, post.authorId)
    || user?.screenName
    || user?.name
    || '';
  const sourceUrl = config.sourceUrlMode === 'permalink' && post.type === 'post'
    ? buildPermalink({
        cid: post.cid,
        slug: post.slug,
        type: post.type,
        created: post.created,
      }, siteUrl, options?.permalinkPattern as string | undefined, options?.pagePattern as string | undefined)
    : '';

  const article: WeChatArticle = {
    title: (post.title || '无标题').slice(0, 64),
    author: authorName.slice(0, 8),
    digest: plainDigest(html),
    content: html,
    content_source_url: sourceUrl,
    thumb_media_id: coverMediaId,
    need_open_comment: config.needOpenComment === '1' ? 1 : 0,
    only_fans_can_comment: config.onlyFansCanComment === '1' ? 1 : 0,
  };

  const existingState = await loadSyncState(db, cid);
  let mediaId = existingState?.mediaId || '';
  let mode: 'created' | 'updated' = 'created';
  if (mediaId) {
    try {
      await updateDraft(accessToken, mediaId, article);
      mode = 'updated';
    } catch (error) {
      if (!isStaleDraftError(error)) throw error;
      mediaId = '';
    }
  }
  if (!mediaId) {
    mediaId = await addDraft(accessToken, article);
    mode = 'created';
  }

  await saveSyncState(db, cid, mediaId);
  return {
    handled: true,
    success: true,
    mediaId,
    mode,
    uploadedImages: imageUrls.length,
  };
}

function titleActionButton(cid: number): string {
  return `<a href="#" class="typecho-wechat-sync" data-cid="${cid}" title="同步到微信公众号草稿" aria-label="同步到微信公众号草稿">
<svg class="typecho-wechat-sync-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path d="M9.8 5C5.5 5 2 7.8 2 11.3c0 2 1.2 3.8 3.1 5l-.7 2.4 2.7-1.4c.8.2 1.7.4 2.7.4 4.3 0 7.8-2.8 7.8-6.3S14.1 5 9.8 5Z" fill="currentColor" opacity=".9"/>
  <path d="M15.3 11.2c3.7 0 6.7 2.4 6.7 5.3 0 1.6-.9 3.1-2.5 4.1l.6 2-2.3-1.2c-.8.2-1.6.3-2.5.3-3.7 0-6.7-2.4-6.7-5.3s3-5.2 6.7-5.2Z" fill="currentColor" opacity=".55"/>
  <circle cx="7.2" cy="10.6" r="1" fill="#fff"/>
  <circle cx="12.1" cy="10.6" r="1" fill="#fff"/>
</svg>
</a>`;
}

const ADMIN_FOOTER_HTML = `<style>
.typecho-wechat-sync {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: 6px;
  color: #467b96;
  vertical-align: -3px;
}
.typecho-wechat-sync:hover,
.typecho-wechat-sync:focus {
  color: #2d627b;
}
.typecho-wechat-sync-icon {
  display: block;
}
.typecho-wechat-sync.is-busy {
  color: #999;
  pointer-events: none;
  width: auto;
  font-size: 12px;
}
</style>
<script>
(function() {
  function notice(message, type) {
    var old = document.querySelector('.typecho-wechat-notice');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var box = document.createElement('div');
    var isError = type === 'error';
    box.className = 'typecho-wechat-notice typecho-option-tabs notice typecho-dismissible ' + (isError ? 'notice-error' : 'notice-success');
    box.style.padding = '10px 15px';
    box.style.marginBottom = '20px';
    box.style.borderRadius = '3px';
    box.style.background = isError ? '#ffeaea' : '#e7f5e7';
    box.style.color = isError ? '#c33' : '#3a3';
    box.innerHTML = '<p style="margin:0"></p><button type="button" class="typecho-notice-close" aria-label="关闭提示">&times;</button>';
    box.querySelector('p').textContent = message;
    var main = document.querySelector('.typecho-page-main');
    if (main) main.insertBefore(box, main.firstChild);
  }

  function readError(data) {
    if (!data) return '';
    if (typeof data.error === 'string') return data.error;
    if (typeof data.message === 'string') return data.message;
    if (typeof data.errmsg === 'string') return data.errmsg;
    return '';
  }

  document.addEventListener('click', async function(event) {
    var target = event.target && event.target.closest ? event.target.closest('.typecho-wechat-sync') : null;
    if (!target) return;
    event.preventDefault();
    if (target.classList.contains('is-busy')) return;

    var csrf = document.querySelector('input[name="_"]');
    if (!csrf) {
      notice('缺少 CSRF token，无法同步', 'error');
      return;
    }

    var oldHtml = target.innerHTML;
    target.textContent = '同步中';
    target.classList.add('is-busy');
    try {
      var response = await fetch('/api/admin/plugin-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          _: csrf.value,
          plugin: '${PLUGIN_ID}',
          action: 'sync',
          payload: { cid: target.getAttribute('data-cid') }
        })
      });
      var data = await response.json().catch(function() { return {}; });
      if (!response.ok || data.success === false) {
        throw new Error(readError(data) || '同步微信公众号失败');
      }
      notice((data.mode === 'updated' ? '已更新微信公众号草稿：' : '已同步到微信公众号草稿：') + (data.mediaId || ''), 'success');
    } catch (error) {
      notice(error && error.message ? error.message : '同步微信公众号失败', 'error');
    } finally {
      target.innerHTML = oldHtml;
      target.classList.remove('is-busy');
    }
  });
})();
</script>`;

export default function init({ addHook, pluginId }: PluginInitContext): void {
  addHook('admin:managePosts:titleActions', pluginId, (html: string, extra?: { post?: { cid?: number } }) => {
    const cid = Number(extra?.post?.cid);
    if (!Number.isInteger(cid) || cid <= 0) return html;
    return html + titleActionButton(cid);
  });

  addHook('admin:footer', pluginId, (html: string, extra?: { activeMenu?: string }) => {
    if (extra?.activeMenu !== 'manage-posts') return html;
    return html + ADMIN_FOOTER_HTML;
  });

  addHook(
    'plugin:config:beforeSave',
    pluginId,
    (result: { success: boolean; settings?: Record<string, unknown>; error?: string }, extra?: { pluginId?: string; settings?: Record<string, unknown> }) => {
      if (extra?.pluginId !== pluginId) return result;
      try {
        return { success: true, settings: normalizeConfig(extra.settings || {}) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : '微信公众号配置校验失败',
        };
      }
    },
  );

  addHook(
    `plugin:${pluginId}:action`,
    pluginId,
    async (
      result: PluginActionResult,
      extra?: { action?: string; payload?: SyncPayload; options?: Record<string, unknown>; db?: Database; user?: { uid?: number; group?: string; screenName?: string; name?: string } },
    ) => {
      if (extra?.action !== 'sync') return result;
      try {
        return await syncPostToWeChat(extra.db, extra.options, extra.payload || {}, extra.user);
      } catch (error) {
        return {
          handled: true,
          success: false,
          error: error instanceof Error ? error.message : '同步微信公众号失败',
        };
      }
    },
  );
}
