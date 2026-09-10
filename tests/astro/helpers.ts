/**
 * Shared helpers for the `.astro` render tests (see vitest.astro.config.ts).
 */
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { createI18n, type I18n } from '@/lib/i18n';
import { coreCatalogs } from '@/i18n/catalogs';

export interface RenderOptions {
  props?: Record<string, unknown>;
  slots?: Record<string, string>;
  locals?: Record<string, unknown>;
  request?: Request;
}

/** Render a component to HTML the way the app would. */
export async function renderComponent(
  component: any,
  options: RenderOptions = {},
): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(
    component,
    options as unknown as Parameters<AstroContainer['renderToString']>[1],
  );
}

/** Request-local translator backed by the real core catalogs. */
export function testI18n(locale = 'zh-CN'): I18n {
  return createI18n({ locale, catalogs: coreCatalogs });
}
