// Plugin SDK — public API surface for Typecho plugins and themes.
// Plugins import from 'typecho/plugin-sdk'; the host project resolves it
// via package.json exports (self-referencing).

// ── Types ──
export type {
  PluginInitContext,
  PluginRouteClaim,
  PluginRouteResolver,
  PluginRouteResolverContext,
  PluginRouteResult,
  PluginManifest,
  PluginConfigField,
} from './plugin';
export type {
  AsyncTaskDefinition,
  RegisteredAsyncTask,
  RegisteredScheduledTask,
  ScheduledTaskDefinition,
  ScheduledTaskKeyContext,
  ScheduledTaskPayload,
  TaskEnvelope,
  TaskExecutionContext,
  TaskHandler,
  TaskKind,
  TaskLocalSlot,
  TaskResult,
  TaskSource,
} from './tasks/types';
export type { EnqueueAsyncTaskOptions } from './tasks/enqueue';
export type { I18n, I18nMessage, MessageVariables } from './i18n';
export type { IanaTimezone, TimezoneSetting } from './timezone';
export type { AttachmentMeta } from './attachment';
export type { Database } from '../db/index';
export type {
  CapabilityDescriptor,
  CapabilityFactory,
  CapabilityFactoryContext,
  CapabilityRegistration,
  CapabilityResolveFailure,
  CapabilityResolveFailureReason,
  CapabilityResolveResult,
  CapabilityResolveSuccess,
  CapabilityRuntimeContext,
  CapabilityRuntimeContextInput,
} from './capability';
export type {
  PluginActivationActionPlan,
  PluginActivationPlan,
  PluginDependency,
  PluginDependencyIssue,
  PluginDependencyIssueCode,
  PluginDependencyKind,
  PluginDependencyNode,
} from './plugin-dependencies';

// ── Plugin system ──
export {
  HookPoints,
  parsePluginOption,
  parsePluginConfigFormData,
  loadPluginConfig,
  escapeAttr,
} from './plugin';
export {
  createCapabilityRuntimeContext,
  getCapabilityActivationGeneration,
  resolveCapability,
} from './capability';
export { getClientIp } from './client-ip';
export { safeJsonForScript } from './escape';

// ── Auth ──
export { generateRandomString, hasPermission, timeSafeEqual, verifyPassword } from './auth';

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
