/**
 * Mail abstraction layer.
 *
 * This module defines the interface for sending email from Typecho-CF.
 * No built-in SMTP / API adapter is provided — actual delivery MUST be
 * handled by a plugin that registers a `mail:send` filter hook.
 *
 * Without an email plugin, sendMail() returns { sent: false } and all
 * email-dependent features (password reset, comment notifications) will
 * degrade gracefully.
 */

import { applyFilterUntil, type HookContext } from '@/lib/plugin';
import { createI18n, normalizeLocale, resolveLocale, type I18n } from '@/lib/i18n';
import { getGlobalTranslationCatalogs } from '@/lib/i18n-registry';

export interface MailPayload {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface MailContext {
  request?: Request;
  options: Record<string, unknown>;
  reason: 'password-reset' | 'comment' | 'comment-reply' | 'test' | string;
  /** Mail copy is pre-rendered with a fixed locale before the adapter runs. */
  i18n?: I18n;
}

export interface MailResult {
  sent: boolean;
  provider: string;
  error?: string;
}

/** Build a stable translator for outbound mail (automatic mode means English). */
export function createMailI18n(
  options: Record<string, unknown>,
  activePluginIds: Iterable<string> = [],
): I18n {
  const configured = Object.prototype.hasOwnProperty.call(options, 'lang')
    ? options.lang
    : 'zh_CN';
  const normalized = normalizeLocale(configured);
  const mailLocale = normalized === '' ? 'en' : (normalized || 'en');
  const catalogs = getGlobalTranslationCatalogs(activePluginIds);
  const locale = resolveLocale(mailLocale, null, catalogs.keys()).locale;
  return createI18n({ locale, catalogs });
}

/** Loose RFC 5322 addr-spec check — avoids typos, not a full validator. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

/**
 * Send an email through any registered mail:send plugin.
 *
 * Returns a MailResult even when no adapter is installed — callers
 * should treat `sent === false` as a graceful degradation.
 */
export async function sendMail(
  pluginCtx: HookContext,
  payload: MailPayload,
  ctx: MailContext,
): Promise<MailResult> {
  // Gate: must be explicitly enabled
  if (!ctx.options.mailEnabled) {
    return { sent: false, provider: 'disabled', error: 'mailEnabled=0' };
  }

  const from = ctx.options.mailFrom as string | undefined;
  if (!from || !isValidEmail(from)) {
    return { sent: false, provider: 'none', error: 'invalid-from' };
  }

  // Try every registered mail:send handler (filter chain).
  // The first handler that returns `sent: true` wins.
  const result = await applyFilterUntil(
    pluginCtx,
    'mail:send',
    null,
    value => !!value && typeof value === 'object' && value.sent === true,
    { payload, ctx },
  );
  if (result && typeof result === 'object' && 'sent' in result) {
    return result as MailResult;
  }

  return { sent: false, provider: 'none', error: 'no-adapter' };
}
