import type {
  CapabilityFactory,
  CapabilityRuntimeContext,
  PluginConfigField,
} from 'typecho/plugin-sdk';

export const AI_PLUGIN_ID = 'typecho-plugin-ai';

export const AI_CAPABILITIES = {
  chatGenerate: 'ai.chat.generate',
  imageGenerate: 'ai.image.generate',
  audioSpeechGenerate: 'ai.audio.speech.generate',
  audioTranscribe: 'ai.audio.transcribe',
  embeddingsCreate: 'ai.embeddings.create',
} as const;

/**
 * Capability that publishes this plugin's public chat model catalog.
 *
 * Other plugins (for example Scribe) consume it as a generic dynamic option
 * source, so they never have to import this plugin or read its stored config.
 */
export const AI_MODEL_CATALOG_CAPABILITY = 'ai.models.list';

/** Service shape exposed through {@link AI_MODEL_CATALOG_CAPABILITY}. */
export interface AiModelCatalogService {
  listOptions(): ReadonlyArray<{ value: string; label?: string }>;
}

export type AiCapability = typeof AI_CAPABILITIES[keyof typeof AI_CAPABILITIES];

export const AI_MODALITIES = {
  text: 'text',
  image: 'image',
  audioInput: 'audio_input',
  audioOutput: 'audio_output',
} as const;

export type AiModelModality = typeof AI_MODALITIES[keyof typeof AI_MODALITIES];

export type AiChatOutputModality = 'text' | 'audio';

export interface AiModelConfig {
  model: string;
  alias?: string;
  enabled: boolean;
  capabilities: AiCapability[];
  modalities: AiModelModality[];
}

export interface AiProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: AiModelConfig[];
}

export interface AiAccessToken {
  id: string;
  token: string;
}

export interface AiHttpConfig {
  enabled: boolean;
  basePath: string;
  /** Bearer tokens allowed to call the optional HTTP endpoint. */
  tokens: AiAccessToken[];
}

export interface AiConfig {
  providers: AiProviderConfig[];
  http: AiHttpConfig;
}

export type AiBinary = Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;

export interface AiTextContentPart {
  type: 'text';
  text: string;
}

export interface AiImageContentPart {
  type: 'image_url';
  image_url: {
    url: string | AiBinary;
    detail?: 'auto' | 'low' | 'high';
    mimeType?: string;
  };
}

export interface AiAudioInputContentPart {
  type: 'input_audio';
  input_audio: {
    data: string | AiBinary;
    format: string;
  };
}

export type AiContentPart = AiTextContentPart | AiImageContentPart | AiAudioInputContentPart;
export type AiMessageContent = string | AiContentPart[];

export interface AiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AiChatMessage {
  role: 'developer' | 'system' | 'user' | 'assistant' | 'tool';
  content?: AiMessageContent | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: AiToolCall[];
  /** Deprecated OpenAI function-call response/input shape. */
  function_call?: AiFunctionCall;
}

export interface AiFunctionCall {
  name: string;
  arguments: string;
}

export interface AiFunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface AiTool {
  type: 'function';
  function: AiFunctionDefinition;
}

export type AiToolChoice = 'none' | 'auto' | 'required' | {
  type: 'function';
  function: { name: string };
};

export interface AiAudioOutputOptions {
  voice: string;
  format: string;
}

export interface AiChatRequest {
  model?: string;
  messages: AiChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  tools?: AiTool[];
  tool_choice?: AiToolChoice;
  parallel_tool_calls?: boolean;
  modalities?: AiChatOutputModality[];
  audio?: AiAudioOutputOptions;
  user?: string;
  n?: number;
  stop?: string | string[] | null;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  logprobs?: boolean;
  top_logprobs?: number;
  response_format?: Record<string, unknown>;
  stream_options?: { include_usage?: boolean };
  seed?: number;
  reasoning_effort?: string;
  metadata?: Record<string, string>;
  prediction?: Record<string, unknown>;
  store?: boolean;
  service_tier?: string;
  /** Deprecated OpenAI function-calling request shape. */
  functions?: AiFunctionDefinition[];
  function_call?: 'none' | 'auto' | { name: string };
}

export interface AiAudioOutput {
  id?: string;
  data: Uint8Array;
  format?: string;
  expires_at?: number;
  transcript?: string;
}

export interface AiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface AiNormalizedMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: AiToolCall[];
  function_call?: AiFunctionCall;
  audio?: AiAudioOutput;
}

export interface AiChatChoice {
  index: number;
  message: AiNormalizedMessage;
  finish_reason: string | null;
}

export interface AiChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: AiChatChoice[];
  usage?: AiUsage;
}

export interface AiStreamDelta {
  role?: 'assistant';
  content?: string | null;
  tool_calls?: AiToolCall[];
  audio?: AiAudioOutput;
}

export interface AiChatStreamChoice {
  index: number;
  delta: AiStreamDelta;
  finish_reason?: string | null;
}

export interface AiChatStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: AiChatStreamChoice[];
  usage?: AiUsage;
}

export type AiChatResult = AiChatResponse | ReadableStream<AiChatStreamChunk>;

export interface AiChatGenerationService {
  generate(request: AiChatRequest): Promise<AiChatResult>;
}

export type AiChatCapabilityFactory = CapabilityFactory<AiChatGenerationService>;
export type AiRuntimeContext = CapabilityRuntimeContext;

export const AI_CONFIG_FIELDS: Record<string, PluginConfigField> = {
  http: {
    type: 'object',
    label: 'HTTP compatibility endpoint',
    itemFields: {
      enabled: {
        type: 'select',
        label: 'Enabled',
        default: 'false',
        options: { true: 'Enabled', false: 'Disabled' },
      },
      basePath: {
        type: 'text',
        label: 'Base path',
        default: '/ai',
        description: 'Site-relative path. The endpoint is exposed below this path under /v1.',
      },
      tokens: {
        type: 'tokens',
        label: 'Access tokens',
        default: [],
        description: 'Bearer tokens allowed to call the endpoint. Delete every token to make the endpoint unreachable.',
      },
    },
  },
  providers: {
    type: 'repeatable',
    label: 'Providers',
    default: [],
    description: 'Configure one or more OpenAI-compatible upstream providers and their models.',
    collapsible: true,
    summaryFields: ['name', 'baseUrl'],
    itemFields: {
      name: { type: 'text', label: 'Provider name', default: '' },
      baseUrl: {
        type: 'text',
        label: 'Base URL',
        default: '',
        description: 'Complete public HTTPS API root, for example https://api.openai.com/v1.',
      },
      apiKey: { type: 'password', label: 'API key', default: '' },
      models: {
        type: 'repeatable',
        label: 'Models',
        default: [],
        collapsible: true,
        summaryFields: ['model', 'alias'],
        statusField: 'enabled',
        itemFields: {
          model: { type: 'text', label: 'Upstream model', default: '' },
          alias: {
            type: 'text',
            label: 'Alias',
            default: '',
            description: 'Optional public model name. When set, the upstream name is not accepted as an alias.',
          },
          enabled: {
            type: 'select',
            label: 'Enabled',
            default: 'true',
            options: { true: 'Enabled', false: 'Disabled' },
          },
          capabilities: {
            type: 'checkbox',
            label: 'Capabilities',
            default: [AI_CAPABILITIES.chatGenerate],
            options: {
              [AI_CAPABILITIES.chatGenerate]: 'Chat generation',
              [AI_CAPABILITIES.imageGenerate]: 'Image generation',
              [AI_CAPABILITIES.audioSpeechGenerate]: 'Audio speech generation',
              [AI_CAPABILITIES.audioTranscribe]: 'Audio transcription',
              [AI_CAPABILITIES.embeddingsCreate]: 'Embeddings',
            },
            // Reserved capability IDs have no implementation yet, so the admin
            // can see them but never enable them.
            optionDisabled: [
              AI_CAPABILITIES.imageGenerate,
              AI_CAPABILITIES.audioSpeechGenerate,
              AI_CAPABILITIES.audioTranscribe,
              AI_CAPABILITIES.embeddingsCreate,
            ],
          },
          modalities: {
            type: 'checkbox',
            label: 'Modalities',
            default: [AI_MODALITIES.text],
            options: {
              [AI_MODALITIES.text]: 'Text',
              [AI_MODALITIES.image]: 'Image input',
              [AI_MODALITIES.audioInput]: 'Audio input',
              [AI_MODALITIES.audioOutput]: 'Audio output',
            },
          },
        },
      },
    },
  },

};
