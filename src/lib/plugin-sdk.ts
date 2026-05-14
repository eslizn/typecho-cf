// Plugin SDK — public API surface for Typecho plugins and themes.
// Plugins import from 'typecho/plugin-sdk'; the host project resolves it
// via package.json exports (self-referencing).

// ── Types ──
export type { PluginInitContext, PluginRouteResult, PluginManifest, PluginConfigField } from './plugin';
export type { AttachmentMeta } from './attachment';
export type { Database } from '../db/index';

// ── Plugin system ──
export {
  HookPoints,
  parsePluginOption,
  parsePluginConfigFormData,
  loadPluginConfig,
  escapeAttr,
  getClientIp,
} from './plugin';

// ── Auth ──
export { hasPermission, verifyPassword } from './auth';

// ── Content ──
export { buildPermalink, formatDate, buildAuthorLink, buildCategoryLink } from './content';

// ── Markdown / HTML ──
export {
  escapeHtml,
  renderMarkdown,
  renderMarkdownFiltered,
  renderContentExcerpt,
  generateExcerpt,
  autop,
  stripTypechoMarkers,
  stripHtmlTags,
} from './markdown';

// ── Network ──
export { fetchWithTimeout } from './fetch';

// ── Attachments ──
export { parseAttachmentMeta } from './attachment';

// ── URL ──
export { normalizeHttpUrl } from './url';

// ── Options ──
export { getOption, setOption } from './options';
