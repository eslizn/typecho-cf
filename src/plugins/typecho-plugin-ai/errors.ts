export const AI_ERROR_CODES = {
  noAvailableModel: 'no-available-model',
  modelNotFound: 'model-not-found',
  unsupportedModality: 'unsupported-modality',
  unsupportedFeature: 'unsupported-feature',
  upstreamTimeout: 'upstream-timeout',
  upstreamClientError: 'upstream-client-error',
  upstreamServerError: 'upstream-server-error',
  invalidRequest: 'invalid-request',
} as const;

export type AiErrorCode = typeof AI_ERROR_CODES[keyof typeof AI_ERROR_CODES];

export class AiCapabilityError extends Error {
  readonly name = 'AiCapabilityError';

  constructor(
    public readonly code: AiErrorCode,
    message: string,
    public readonly status = statusForAiError(code),
    public readonly retryable = code === AI_ERROR_CODES.upstreamTimeout || code === AI_ERROR_CODES.upstreamServerError,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function isAiCapabilityError(error: unknown): error is AiCapabilityError {
  return error instanceof AiCapabilityError;
}

export function statusForAiError(code: AiErrorCode): number {
  switch (code) {
    case AI_ERROR_CODES.invalidRequest:
    case AI_ERROR_CODES.modelNotFound:
    case AI_ERROR_CODES.unsupportedModality:
    case AI_ERROR_CODES.unsupportedFeature:
      return 400;
    case AI_ERROR_CODES.noAvailableModel:
      return 503;
    case AI_ERROR_CODES.upstreamClientError:
      return 502;
    case AI_ERROR_CODES.upstreamTimeout:
      return 504;
    case AI_ERROR_CODES.upstreamServerError:
      return 502;
  }
  return 500;
}
