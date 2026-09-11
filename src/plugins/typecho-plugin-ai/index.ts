import {
  parsePluginOption,
  resolveCapability,
} from 'typecho/plugin-sdk';
import type {
  CapabilityRuntimeContext,
  I18n,
  PluginInitContext,
  PluginRouteClaim,
  PluginRouteResult,
} from 'typecho/plugin-sdk';
import { AI_ERROR_CODES } from './errors';
import { createAiChatService } from './chat';
import { handleAiHttpRequest, isAiHttpEndpointPath } from './http';
import {
  AiConfigValidationError,
  isValidHttpBasePath,
  normalizeAiConfig,
  validateAiConfig,
  validateAiConfigLocally,
} from './provider';
import {
  AI_CAPABILITIES,
  AI_CONFIG_FIELDS,
  AI_PLUGIN_ID,
  type AiConfig,
} from './types';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

export { createAiChatService, validateChatRequest } from './chat';
export { handleAiHttpRequest, isAiHttpEndpointPath, parseChatRequest } from './http';
export {
  AI_REQUEST_LIMITS,
  AI_VALIDATION_LIMITS,
  buildProviderEndpoint,
  isValidHttpBasePath,
  isReservedHttpBasePath,
  listChatModels,
  logicalModelName,
  normalizeAiConfig,
  normalizeBasePath,
  normalizeBaseUrl,
  selectAiModel,
  supportsRequestModalities,
  validateAiConfig,
  validateAiConfigLocally,
} from './provider';
export type { AiRequestLimits, AiValidationLimits } from './provider';
export { AI_ERROR_CODES, AiCapabilityError, isAiCapabilityError } from './errors';
export * from './types';

const HTTP_V1_PREFIX = '/v1';

interface AiConfigValidationResult {
  success?: boolean;
  settings?: Record<string, unknown>;
  error?: string;
}

interface AiConfigSaveExtra {
  pluginId?: string;
  settings?: Record<string, unknown>;
  i18n?: I18n;
}

interface AiRouteExtra {
  request?: Request;
  path?: string;
  options?: Record<string, unknown>;
  capabilityRuntime?: CapabilityRuntimeContext;
}

function configuredRouteClaims(config: Readonly<Record<string, unknown>>): ReadonlyArray<PluginRouteClaim> {
  const normalized = normalizeAiConfig(config);
  if (!normalized.http.enabled || !isValidHttpBasePath(normalized.http.basePath)) return [];
  return [{ path: normalized.http.basePath, match: 'prefix' }];
}

function configValidationError(error: unknown, i18n?: I18n): string {
  if (error instanceof AiConfigValidationError) {
    return i18n?.t(`plugin.${AI_PLUGIN_ID}.error.${error.code}`, error.params, error.message) ?? error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return 'AI configuration validation failed.';
}

function runtimeService(
  runtime: CapabilityRuntimeContext | undefined,
  pluginId: string,
): ReturnType<typeof createAiChatService> | null {
  if (!runtime) return null;
  const resolved = resolveCapability<ReturnType<typeof createAiChatService>>(runtime, {
    capability: AI_CAPABILITIES.chatGenerate,
    ownerPluginId: pluginId,
  });
  return resolved.ok ? resolved.value : null;
}

function routeConfig(options: Record<string, unknown> | undefined, pluginId: string): AiConfig {
  return normalizeAiConfig(parsePluginOption(options?.[`plugin:${pluginId}`]));
}

export default function init({
  addHook,
  pluginId,
  registerCapability,
  registerRouteResolver,
  registerTranslations,
}: PluginInitContext): void {
  if (!registerCapability) {
    throw new Error('The Typecho runtime does not provide generic capability registration.');
  }

  registerTranslations?.('en', en);
  registerTranslations?.('zh-CN', zhCN);

  registerCapability({
    capability: AI_CAPABILITIES.chatGenerate,
    version: 1,
    factory: runtime => createAiChatService(
      runtime,
      normalizeAiConfig(runtime.getOwnPluginConfig()),
    ),
  });

  registerRouteResolver(({ config }) => configuredRouteClaims(config));

  addHook(
    'plugin:config:beforeSave',
    pluginId,
    async (
      result: AiConfigValidationResult,
      extra?: AiConfigSaveExtra,
    ): Promise<AiConfigValidationResult> => {
      if (extra?.pluginId !== pluginId) return result;
      try {
        const normalized = normalizeAiConfig(extra.settings || {});
        validateAiConfigLocally(normalized);
        await validateAiConfig(normalized);
        return { success: true, settings: normalized as unknown as Record<string, unknown> };
      } catch (error) {
        return { success: false, error: configValidationError(error, extra?.i18n) };
      }
    },
  );

  addHook(
    'request:route',
    pluginId,
    async (
      result: PluginRouteResult,
      extra?: AiRouteExtra,
    ): Promise<PluginRouteResult> => {
      if (result?.handled || !extra?.request || !extra.path) return result;
      const config = routeConfig(extra.options, pluginId);
      if (!config.http.enabled || !isValidHttpBasePath(config.http.basePath)) return result;
      // Paths that only share the base path prefix must fall through to the
      // normal route chain; only the two OpenAI-compatible endpoints resolve
      // the capability and answer with a plugin response.
      if (!isAiHttpEndpointPath(config, extra.path)) return result;

      const service = runtimeService(extra.capabilityRuntime, pluginId);
      if (!service) {
        const response = new Response(JSON.stringify({
          error: {
            message: 'The AI capability is unavailable.',
            type: 'server_error',
            code: AI_ERROR_CODES.noAvailableModel,
          },
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
        return { handled: true, response };
      }

      const response = await handleAiHttpRequest({
        request: extra.request,
        path: extra.path,
        config,
        service,
      });
      return response ? { handled: true, response } : result;
    },
    10,
  );
}

export { AI_CAPABILITIES, AI_CONFIG_FIELDS, AI_PLUGIN_ID, HTTP_V1_PREFIX };
