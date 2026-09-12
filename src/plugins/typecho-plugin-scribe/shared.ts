/**
 * Small shared pieces of the Scribe plugin: the plugin id, the content-type
 * union, and the translator wrapper used by both the request pipeline and the
 * editor UI module.
 */
import type { I18n } from 'typecho/plugin-sdk';

export const PLUGIN_ID = 'typecho-plugin-scribe';

export type ContentType = 'post' | 'page';

export function translate(
  i18n: I18n | undefined,
  key: string,
  fallback: string,
  variables?: Record<string, string | number>,
): string {
  return i18n?.t(key, variables, fallback) ?? fallback;
}
