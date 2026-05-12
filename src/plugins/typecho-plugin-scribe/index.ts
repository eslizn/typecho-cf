import type { PluginInitContext } from '@/lib/plugin';
import { parsePluginOption } from '@/lib/plugin';
import type { Database } from '@/db';
import { schema } from '@/db';
import { and, desc, eq, inArray, or } from 'drizzle-orm';

type WriterMode = 'generate' | 'polish' | 'correct';
type ContentType = 'post' | 'page';
type LengthPreset = 'concise' | 'balanced' | 'detailed';
type FactPolicy = 'conservative' | 'assumptive';

const LENGTH_PRESETS = ['concise', 'balanced', 'detailed'] as const;
const FACT_POLICIES = ['conservative', 'assumptive'] as const;
const OUTPUT_LANGUAGES = ['auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko'] as const;

const LENGTH_LABELS: Record<LengthPreset, string> = {
  concise: '偏短：聚焦核心观点，避免铺陈。',
  balanced: '标准：结构完整，信息密度适中。',
  detailed: '深入：展开背景、细节、例证和必要的小结。',
};

interface ScribeConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  temperature: string;
  maxTokens: string;
  stylePostCount: string;
  outputLanguage: string;
  targetAudience: string;
  lengthPreset: LengthPreset;
  factPolicy: FactPolicy;
  userPrompt: string;
  includeBodyAssets: string;
}

interface WriterPayload {
  contentType?: ContentType;
  title?: string;
  body?: string;
  cid?: number | string;
  attachmentIds?: Array<number | string>;
}

interface PluginActionResult {
  handled?: boolean;
  success?: boolean;
  content?: string;
  error?: string;
  response?: Response;
}

interface ConfigValidationResult {
  success: boolean;
  settings?: ScribeConfig;
  error?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface ChatCompletionStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
    message?: {
      content?: string;
    };
  }>;
}

interface StyleSample {
  title: string;
  text: string;
}

interface ContentAsset {
  source: 'body' | 'attachment';
  kind: 'image' | 'file';
  title: string;
  url: string;
  mime?: string;
  size?: number;
  cid?: number;
}

type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface ModelInfo {
  id?: string;
}

interface ModelsResponse {
  data?: ModelInfo[];
}

const PLUGIN_ID = 'typecho-plugin-scribe';

const DEFAULTS: ScribeConfig = {
  endpoint: 'https://open.bigmodel.cn/api/paas/v4/',
  apiKey: '',
  model: 'glm-4.7-flash',
  temperature: '0.7',
  maxTokens: '32000',
  stylePostCount: '5',
  outputLanguage: 'auto',
  targetAudience: '',
  lengthPreset: 'balanced',
  factPolicy: 'conservative',
  userPrompt: '',
  includeBodyAssets: '0',
};

const VALIDATION_TIMEOUT_MS = 3500;
const LLM_REQUEST_TIMEOUT_MS = 60_000;
const SYSTEM_PROMPT = [
  '你是 Typecho-CF 的资深内容编辑助手。',
  '你的目标是帮助作者生成、润色或纠错可直接保存的正文，而不是回答关于写作过程的问题。',
  '先在内部完成任务理解、风格归纳、结构规划和事实风险检查，但不要输出分析过程、计划、检查清单或解释。',
  '严格遵守用户提供的标题、已有正文、站点风格样本、附件资料和管理员写作要求。',
  '不要编造事实、出处、数字、人物、机构或链接；上下文不足时使用克制、可核验的表述。',
  '默认输出 Markdown 正文。除非用户明确要求，不要输出 front matter、JSON、代码围栏、标题重复、问候语或说明文字。',
  '润色和纠错任务必须返回完整正文，不能只返回修改或新增片段。',
].join('\n');

function normalizeConfig(settings?: Record<string, unknown>): ScribeConfig {
  return {
    endpoint: String(settings?.endpoint || '').trim(),
    apiKey: String(settings?.apiKey || '').trim(),
    model: String(settings?.model || '').trim(),
    temperature: String(settings?.temperature || DEFAULTS.temperature).trim(),
    maxTokens: String(settings?.maxTokens || DEFAULTS.maxTokens).trim(),
    stylePostCount: String(settings?.stylePostCount || DEFAULTS.stylePostCount).trim(),
    outputLanguage: String(settings?.outputLanguage || DEFAULTS.outputLanguage).trim(),
    targetAudience: String(settings?.targetAudience || DEFAULTS.targetAudience).trim(),
    lengthPreset: normalizeLengthPreset(settings?.lengthPreset),
    factPolicy: normalizeFactPolicy(settings?.factPolicy),
    userPrompt: String(settings?.userPrompt || DEFAULTS.userPrompt).trim(),
    includeBodyAssets: String(settings?.includeBodyAssets || DEFAULTS.includeBodyAssets).trim(),
  };
}

function normalizeEnum<T extends string>(value: unknown, validValues: readonly T[], fallback: T): T {
  return validValues.includes(value as T) ? (value as T) : fallback;
}

function assertValid<T extends string>(value: string, validValues: readonly T[], label: string): void {
  if (!(validValues as readonly string[]).includes(value)) throw new Error(`${label}配置不正确`);
}

function normalizeLengthPreset(value: unknown): LengthPreset {
  return normalizeEnum(value, LENGTH_PRESETS, 'balanced');
}

function normalizeFactPolicy(value: unknown): FactPolicy {
  return normalizeEnum(value, FACT_POLICIES, 'conservative');
}

function getConfig(options?: Record<string, unknown>): ScribeConfig {
  return normalizeConfig({
    ...DEFAULTS,
    ...parsePluginOption(options?.[`plugin:${PLUGIN_ID}`]),
  });
}

function buildChatCompletionsUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/chat/completions`;
}

function buildModelsUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/models`;
}

function buildModelUrl(endpoint: string, model: string): string {
  return `${buildModelsUrl(endpoint)}/${encodeURIComponent(model)}`;
}

function normalizeText(text: string): string {
  return text
    .replace(/^<!--markdown-->/, '')
    .replace(/<!--more-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function xmlBlock(name: string, content: string): string {
  return `<${name}>\n${content.trim() || '无'}\n</${name}>`;
}

function buildStyleContext(samples: StyleSample[]): string {
  if (samples.length === 0) {
    return '暂无最近文章样本。';
  }

  return samples.map((sample, index) => [
    `样本 ${index + 1} 标题：${sample.title || '无标题'}`,
    `样本 ${index + 1} 正文片段：${normalizeText(truncateText(sample.text, 1200))}`,
  ].join('\n')).join('\n\n');
}

function buildConfiguredUserPrompt(config: ScribeConfig): string {
  if (!config.userPrompt) {
    return '未配置额外写作要求。';
  }

  return [
    '以下是站点管理员配置的额外写作要求，请在不违背系统约束和事实准确性的前提下遵循：',
    config.userPrompt,
  ].join('\n');
}

function buildWritingProfile(config: ScribeConfig): string {
  const language = config.outputLanguage === 'auto'
    ? '自动判断：优先沿用标题、正文和样本的主要语言。'
    : `固定使用：${config.outputLanguage}`;
  const audience = config.targetAudience
    ? config.targetAudience
    : '未指定，按站点既有文章的读者画像推断。';
  const length = LENGTH_LABELS[config.lengthPreset] ?? LENGTH_LABELS.balanced;
  const factPolicy = config.factPolicy === 'assumptive'
    ? '允许基于常识做低风险推断，但必须避免虚构具体事实、数据、链接和来源。'
    : '保守事实策略：没有在上下文出现或无法确定的具体事实不要写成确定结论。';

  return [
    `输出语言：${language}`,
    `目标读者：${audience}`,
    `篇幅策略：${length}`,
    `事实策略：${factPolicy}`,
  ].join('\n');
}

const MODE_INSTRUCTIONS: Record<WriterMode, (label: string) => string[]> = {
  generate: (label) => [`根据标题和上下文生成一篇完整${label}正文。`, '不要重复输出标题。', '先组织清晰结构，再输出正文。'],
  polish: (label) => [`润色下面这篇${label}，输出润色后的完整正文。`, '重点提升表达清晰度、段落节奏、结构衔接和可读性。', '不得改变原文核心观点、事实、语气边界或 Markdown 语义。'],
  correct: (label) => [`校对这篇${label}，输出校对后的完整正文。`, '修正错别字、语法错误、标点不当、事实矛盾和逻辑断裂。', '保留原文风格、结构、观点和语气，不添加新内容或做润色式改写。'],
};

function buildModeInstruction(mode: WriterMode, typeLabel: string): string {
  return MODE_INSTRUCTIONS[mode](typeLabel).join('\n');
}

function buildOutputContract(mode: WriterMode): string {
  const lines = [
    '只输出最终 Markdown 正文。',
    '不要输出标题、解释、分析过程、计划、检查清单、代码围栏或额外寒暄。',
    '保留合理的 Markdown 链接、图片、引用、列表、脚注和代码块语义。',
    '引用定义和脚注定义统一放在全文末尾。',
    '避免重复段落和重复小标题。',
  ];

  if (mode !== 'generate') {
    lines.push('必须返回完整正文，从正文第一段开始，到正文最后一段结束。');
  }

  return lines.map((line, index) => `${index + 1}. ${line}`).join('\n');
}

function shouldIncludeBodyAssets(config: ScribeConfig): boolean {
  return config.includeBodyAssets === '1';
}

function buildAssetsContext(assets: ContentAsset[]): string {
  if (assets.length === 0) {
    return '未发现正文图片或附件。';
  }

  return assets.map((asset, index) => {
    const parts = [
      `${index + 1}. ${asset.kind === 'image' ? '图片' : '附件'}：${asset.title || '未命名'}`,
      `URL：${asset.url}`,
      asset.mime ? `类型：${asset.mime}` : '',
      asset.size ? `大小：${asset.size} bytes` : '',
      asset.cid ? `附件 ID：${asset.cid}` : '',
      `来源：${asset.source === 'attachment' ? '附件记录' : '正文引用'}`,
    ].filter(Boolean);
    return parts.join('\n');
  }).join('\n\n');
}

function buildPrompt(
  mode: WriterMode,
  payload: WriterPayload,
  styleSamples: StyleSample[],
  config: ScribeConfig,
  assets: ContentAsset[],
): string {
  const typeLabel = payload.contentType === 'page' ? '页面' : '文章';
  const title = payload.title || '未命名';
  const body = payload.body || '';
  const styleContext = buildStyleContext(styleSamples);
  const configuredUserPrompt = buildConfiguredUserPrompt(config);

  return [
    xmlBlock('style_samples', styleContext),
    xmlBlock('writing_profile', buildWritingProfile(config)),
    xmlBlock('admin_requirements', configuredUserPrompt),
    shouldIncludeBodyAssets(config) ? xmlBlock('assets', buildAssetsContext(assets)) : '',
    xmlBlock('draft', [
      `content_type: ${typeLabel}`,
      `title: ${title}`,
      body ? `body:\n${body}` : 'body: 无',
    ].join('\n')),
    xmlBlock('task', buildModeInstruction(mode, typeLabel)),
    xmlBlock('output_contract', buildOutputContract(mode)),
  ].filter(Boolean).join('\n\n');
}

async function readErrorSnippet(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  const message = extractErrorMessageFromText(text);
  return message ? `：${message.slice(0, 200)}` : '';
}

function extractErrorMessageFromText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  try {
    const data = JSON.parse(trimmed) as unknown;
    return extractErrorMessage(data);
  } catch {
    return trimmed.startsWith('{') || trimmed.startsWith('[') ? '' : trimmed;
  }
}

function extractErrorMessage(data: unknown): string {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return '';

  const record = data as Record<string, unknown>;
  const error = record.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const errorRecord = error as Record<string, unknown>;
    if (typeof errorRecord.message === 'string') return errorRecord.message;
    if (typeof errorRecord.msg === 'string') return errorRecord.msg;
    if (typeof errorRecord.code === 'string') return errorRecord.code;
  }

  if (typeof record.message === 'string') return record.message;
  if (typeof record.msg === 'string') return record.msg;
  if (typeof record.detail === 'string') return record.detail;
  return '';
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = VALIDATION_TIMEOUT_MS,
  timeoutMessage = 'LLM 配置校验超时，请确认接口地址和网络',
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function validationHeaders(config: ScribeConfig): HeadersInit {
  return {
    Authorization: `Bearer ${config.apiKey}`,
  };
}

async function assertModelsResponse(response: Response, config: ScribeConfig): Promise<void> {
  if (!response.ok) {
    const suffix = await readErrorSnippet(response);
    if (response.status === 401 || response.status === 403) {
      throw new Error(`API Key 无效或无权限${suffix}`);
    }
    if (response.status === 404) {
      throw new Error(`模型不存在或接口地址不正确${suffix}`);
    }
    throw new Error(`LLM 配置校验失败 (${response.status})${suffix}`);
  }

  const data = await response.json().catch(() => null) as ModelsResponse | ModelInfo | null;
  if (Array.isArray((data as ModelsResponse | null)?.data)) {
    const exists = (data as ModelsResponse).data?.some(item => item.id === config.model);
    if (!exists) {
      throw new Error(`模型不存在：${config.model}`);
    }
  }
}

async function validateModelAccess(config: ScribeConfig): Promise<void> {
  const modelResponse = await fetchWithTimeout(buildModelUrl(config.endpoint, config.model), {
    method: 'GET',
    headers: validationHeaders(config),
  });

  if (modelResponse.ok) {
    return;
  }

  if (![404, 405].includes(modelResponse.status)) {
    await assertModelsResponse(modelResponse, config);
    return;
  }

  const listResponse = await fetchWithTimeout(buildModelsUrl(config.endpoint), {
    method: 'GET',
    headers: validationHeaders(config),
  });
  await assertModelsResponse(listResponse, config);
}

async function validateConfig(settings?: Record<string, unknown>): Promise<ScribeConfig> {
  const config = normalizeConfig(settings);
  if (!config.endpoint || !config.apiKey || !config.model) {
    throw new Error('请填写接口地址、API Key 和模型名称');
  }

  let url: URL;
  try {
    url = new URL(config.endpoint);
  } catch {
    throw new Error('接口地址格式不正确');
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('接口地址必须使用 http 或 https');
  }

  const temperature = Number(config.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error('temperature 必须是 0 到 2 之间的数字');
  }

  const maxTokens = Number(config.maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 32000) {
    throw new Error('max tokens 必须是 128 到 32000 之间的整数');
  }

  const stylePostCount = Number(config.stylePostCount);
  if (!Number.isInteger(stylePostCount) || stylePostCount < 0 || stylePostCount > 20) {
    throw new Error('风格参考文章数必须是 0 到 20 之间的整数');
  }
  if (!['0', '1'].includes(config.includeBodyAssets)) {
    throw new Error('发送正文图片和附件配置不正确');
  }
  assertValid(config.outputLanguage, OUTPUT_LANGUAGES, '输出语言');
  assertValid(config.lengthPreset, LENGTH_PRESETS, '篇幅策略');
  assertValid(config.factPolicy, FACT_POLICIES, '事实策略');

  await validateModelAccess(config);

  return config;
}

async function loadStyleSamples(db: Database | undefined, count: number): Promise<StyleSample[]> {
  if (!db || count <= 0) return [];

  const rows = await db
    .select({
      title: schema.contents.title,
      text: schema.contents.text,
    })
    .from(schema.contents)
    .where(and(
      eq(schema.contents.type, 'post'),
      eq(schema.contents.status, 'publish'),
    ))
    .orderBy(desc(schema.contents.created))
    .limit(count);

  return rows.map(row => ({
    title: row.title || '',
    text: row.text || '',
  }));
}

function parsePositiveInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/^<|>$/g, '');
}

function isSkippableUrl(url: string): boolean {
  return !url
    || url.startsWith('#')
    || /^mailto:/i.test(url)
    || /^javascript:/i.test(url)
    || /^tel:/i.test(url);
}

function inferAssetKind(url: string, mime?: string): 'image' | 'file' {
  if (mime?.startsWith('image/')) return 'image';
  return /\.(avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(url) ? 'image' : 'file';
}

function pushBodyAsset(assets: ContentAsset[], title: string, url: string): void {
  const normalizedUrl = normalizeUrl(url);
  if (isSkippableUrl(normalizedUrl)) return;
  assets.push({
    source: 'body',
    kind: inferAssetKind(normalizedUrl),
    title: title.trim(),
    url: normalizedUrl,
  });
}

function extractBodyAssets(body: string): ContentAsset[] {
  const assets: ContentAsset[] = [];

  for (const match of body.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    pushBodyAsset(assets, match[1] || '', match[2] || '');
  }

  for (const match of body.matchAll(/(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    pushBodyAsset(assets, match[1] || '', match[2] || '');
  }

  for (const match of body.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    const tag = match[0] || '';
    const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] || '';
    pushBodyAsset(assets, alt, match[1] || '');
  }

  for (const match of body.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi)) {
    const title = (match[2] || '').replace(/<[^>]+>/g, '').trim();
    pushBodyAsset(assets, title, match[1] || '');
  }

  return assets;
}

function parseAttachmentMeta(text: string | null): { url?: string; name?: string; type?: string; size?: number } {
  try {
    const meta = JSON.parse(text || '{}') as Record<string, unknown>;
    return {
      url: typeof meta.url === 'string' ? meta.url : undefined,
      name: typeof meta.name === 'string' ? meta.name : undefined,
      type: typeof meta.type === 'string' ? meta.type : undefined,
      size: typeof meta.size === 'number' ? meta.size : Number(meta.size) || undefined,
    };
  } catch {
    return {};
  }
}

function dedupeAssets(assets: ContentAsset[]): ContentAsset[] {
  const seen = new Set<string>();
  const result: ContentAsset[] = [];
  for (const asset of assets) {
    const key = asset.cid ? `cid:${asset.cid}` : `url:${asset.url}`;
    if (!asset.url || seen.has(key)) continue;
    seen.add(key);
    result.push(asset);
  }
  return result.slice(0, 20);
}

async function loadAttachmentAssets(
  db: Database | undefined,
  cid: number,
  attachmentIds: number[],
): Promise<ContentAsset[]> {
  if (!db || (!cid && attachmentIds.length === 0)) return [];

  const conditions = [
    cid ? eq(schema.contents.parent, cid) : undefined,
    attachmentIds.length > 0 ? inArray(schema.contents.cid, attachmentIds) : undefined,
  ].filter(Boolean);

  if (conditions.length === 0) return [];

  const rows = await db
    .select({
      cid: schema.contents.cid,
      title: schema.contents.title,
      text: schema.contents.text,
    })
    .from(schema.contents)
    .where(and(
      eq(schema.contents.type, 'attachment'),
      conditions.length === 1 ? conditions[0] : or(...conditions),
    ))
    .limit(50);

  return rows.map((row): ContentAsset => {
    const meta = parseAttachmentMeta(row.text);
    const url = meta.url || '';
    return {
      source: 'attachment',
      kind: inferAssetKind(url, meta.type),
      title: meta.name || row.title || '',
      url,
      mime: meta.type,
      size: meta.size,
      cid: row.cid,
    };
  }).filter(asset => !!asset.url);
}

async function loadContentAssets(
  db: Database | undefined,
  config: ScribeConfig,
  payload: WriterPayload,
): Promise<ContentAsset[]> {
  if (!shouldIncludeBodyAssets(config)) return [];

  const cid = parsePositiveInt(payload.cid);
  const attachmentIds = Array.isArray(payload.attachmentIds)
    ? [...new Set(payload.attachmentIds.map(parsePositiveInt).filter(Boolean))]
    : [];
  const bodyAssets = extractBodyAssets(payload.body || '');
  const attachmentAssets = await loadAttachmentAssets(db, cid, attachmentIds);
  return dedupeAssets([...bodyAssets, ...attachmentAssets]);
}

function toAbsoluteUrl(url: string, siteUrl?: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (!siteUrl || !url.startsWith('/')) return '';
  return `${siteUrl.replace(/\/+$/, '')}${url}`;
}

function buildUserContent(prompt: string, assets: ContentAsset[], siteUrl?: string): string | UserContentPart[] {
  const imageParts = assets
    .filter(asset => asset.kind === 'image')
    .map(asset => toAbsoluteUrl(asset.url, siteUrl))
    .filter(Boolean)
    .slice(0, 8)
    .map(url => ({ type: 'image_url' as const, image_url: { url } }));

  if (imageParts.length === 0) {
    return prompt;
  }

  return [
    { type: 'text', text: prompt },
    ...imageParts,
  ];
}

function buildChatCompletionPayload(
  config: ScribeConfig,
  mode: WriterMode,
  payload: WriterPayload,
  styleSamples: StyleSample[],
  assets: ContentAsset[],
  siteUrl?: string,
  stream = false,
): Record<string, unknown> {
  return {
    model: config.model,
    temperature: Number(config.temperature) || 0.7,
    max_tokens: Number(config.maxTokens) || Number(DEFAULTS.maxTokens),
    stream,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserContent(buildPrompt(mode, payload, styleSamples, config, assets), assets, siteUrl) },
    ],
  };
}

async function callLLM(
  config: ScribeConfig,
  mode: WriterMode,
  payload: WriterPayload,
  styleSamples: StyleSample[],
  assets: ContentAsset[],
  siteUrl?: string,
): Promise<string> {
  if (!config.endpoint || !config.apiKey || !config.model) {
    throw new Error('请先完整配置接口地址、API Key 和模型名称');
  }

  const response = await fetchWithTimeout(
    buildChatCompletionsUrl(config.endpoint),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...validationHeaders(config),
      },
      body: JSON.stringify(buildChatCompletionPayload(config, mode, payload, styleSamples, assets, siteUrl)),
    },
    LLM_REQUEST_TIMEOUT_MS,
    'LLM 请求超时，请稍后重试',
  );

  if (!response.ok) {
    const suffix = await readErrorSnippet(response);
    throw new Error(`LLM 请求失败 (${response.status})${suffix}`);
  }

  const data = await response.json() as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM 返回格式不正确');
  }

  return content.trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function createTextStreamFromLLM(response: Response): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error('LLM 未返回可读取的流');
  }

  let buffer = '';
  let outputStarted = false;

  function cleanFirstChunk(content: string): string {
    if (outputStarted) return content;
    outputStarted = true;
    return content.replace(/^```(?:markdown|md)?\s*/i, '');
  }

  function parseLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return '';
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return '';

    try {
      const chunk = JSON.parse(data) as ChatCompletionStreamChunk;
      return cleanFirstChunk(chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.message?.content || '');
    } catch {
      return '';
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const content = parseLine(line);
          if (content) {
            controller.enqueue(encoder.encode(content));
            return;
          }
          continue;
        }

        const { done, value } = await reader.read();
        if (done) {
          const tail = parseLine(buffer);
          if (tail) controller.enqueue(encoder.encode(tail.replace(/\s*```$/i, '')));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel() {
      void reader.cancel();
    },
  });
}

async function callLLMStream(
  config: ScribeConfig,
  mode: WriterMode,
  payload: WriterPayload,
  styleSamples: StyleSample[],
  assets: ContentAsset[],
  siteUrl?: string,
): Promise<Response> {
  if (!config.endpoint || !config.apiKey || !config.model) {
    throw new Error('请先完整配置接口地址、API Key 和模型名称');
  }

  const response = await fetchWithTimeout(
    buildChatCompletionsUrl(config.endpoint),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(buildChatCompletionPayload(config, mode, payload, styleSamples, assets, siteUrl, true)),
    },
    LLM_REQUEST_TIMEOUT_MS,
    'LLM 请求超时，请稍后重试',
  );

  if (!response.ok) {
    const suffix = await readErrorSnippet(response);
    throw new Error(`LLM 请求失败 (${response.status})${suffix}`);
  }

  return new Response(createTextStreamFromLLM(response), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Typecho-Plugin-Stream': '1',
    },
  });
}

const POST_EDITOR_HTML = editorHtml('post');
const PAGE_EDITOR_HTML = editorHtml('page');

function editorHtml(contentType: ContentType): string {
  return `
<style>
#wmd-scribe-button span {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  font-size: 11px;
  font-weight: 700;
  color: #666;
}
#wmd-scribe-button {
  position: relative;
}
#wmd-scribe-button[aria-disabled="true"] {
  opacity: .5;
  cursor: default;
}

.typecho-scribe-menu {
  display: none;
  position: absolute;
  top: 24px;
  left: 0;
  gap: 4px;
  padding: 4px;
  background: #fff;
  border: 1px solid #d9d9d9;
  border-radius: 3px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, .12);
  z-index: 30;
}
.typecho-scribe-menu[aria-hidden="false"] {
  display: flex;
}
.typecho-scribe-menu-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 2px;
  background: transparent;
  color: #555;
  cursor: pointer;
}
.typecho-scribe-menu-button svg {
  flex-shrink: 0;
}
.typecho-scribe-menu-button:hover,
.typecho-scribe-menu-button:focus {
  background: #f0f0f0;
  color: #222;
  outline: none;
}
.typecho-scribe-menu-button[aria-disabled="true"] {
  opacity: .5;
  cursor: default;
}

#wmd-editarea {
  position: relative;
}

.typecho-scribe-overlay {
  display: none;
  position: absolute;
  inset: 0;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.85);
  z-index: 10;
  border-radius: 3px;
}
.typecho-scribe-overlay[aria-hidden="false"] {
  display: flex;
}

.typecho-scribe-loader {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.typecho-scribe-loader-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid #e0e0e0;
  border-top-color: #467b96;
  border-radius: 50%;
  animation: typecho-scribe-spin 0.8s linear infinite;
}

@keyframes typecho-scribe-spin {
  to { transform: rotate(360deg); }
}

.typecho-scribe-loader-text {
  font-size: 13px;
  color: #666;
}

.typecho-scribe-locked {
  overflow: hidden !important;
  resize: none;
  pointer-events: none;
}

.typecho-scribe-fallback-btn svg {
  display: block;
  width: 16px;
  height: 16px;
}
</style>
<div class="typecho-scribe" data-content-type="${contentType}" hidden>
  <span class="typecho-scribe-fallback-actions"></span>
</div>
<div class="typecho-scribe-overlay" role="status" aria-live="polite" aria-hidden="true">
  <div class="typecho-scribe-loader">
    <span class="typecho-scribe-loader-spinner" aria-hidden="true"></span>
    <span class="typecho-scribe-loader-text">AI 正在生成...</span>
  </div>
</div>
<script is:inline>
(function() {
  if (window.__typechoScribeReady) return;
  window.__typechoScribeReady = true;

  function clearAdminNotice() {
    var notice = document.querySelector('.typecho-scribe-notice');
    if (notice && notice.parentNode) {
      notice.parentNode.removeChild(notice);
    }
  }

  function showAdminNotice(message, type) {
    clearAdminNotice();

    var notice = document.createElement('div');
    var isError = type === 'error';
    notice.className = 'typecho-scribe-notice typecho-option-tabs notice typecho-dismissible ' + (isError ? 'notice-error' : 'notice-success');
    notice.style.padding = '10px 15px';
    notice.style.marginBottom = '20px';
    notice.style.borderRadius = '3px';
    notice.style.background = isError ? '#ffeaea' : '#e7f5e7';
    notice.style.color = isError ? '#c33' : '#3a3';
    notice.setAttribute('role', isError ? 'alert' : 'status');

    var paragraph = document.createElement('p');
    paragraph.textContent = message || 'AI 写作失败';
    paragraph.style.margin = '0';
    notice.appendChild(paragraph);

    var closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'typecho-notice-close';
    closeButton.setAttribute('aria-label', '关闭提示');
    closeButton.innerHTML = '&times;';
    notice.appendChild(closeButton);

    var main = document.querySelector('.typecho-page-main');
    if (main) {
      main.insertBefore(notice, main.firstChild);
      if (!notice.closest('[class*="col-"]')) {
        notice.classList.add('col-mb-12');
      }
    } else {
      document.body.insertBefore(notice, document.body.firstChild);
    }

    notice.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  var SCRIBE_ICON = '<span aria-hidden="true">AI</span>';
  var MODE_ICONS = {
    generate: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
    polish: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    correct: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 10 2 2 4-4"/><rect width="20" height="20" x="2" y="2" rx="4" opacity=".25"/><path d="M20.5 2.5 15 20 9 17l-5.5 3L6 14Z"/></svg>'
  };
  var scribeButtons = [];
  var MODE_LABELS = { generate: '生成', polish: '润色', correct: '纠错' };
  var MODE_TITLES = { generate: 'AI 生成', polish: 'AI 润色', correct: 'AI 纠错' };

  function modeLabel(mode) {
    return MODE_LABELS[mode] || MODE_LABELS.generate;
  }

  function setBusy(text, button, busy, label) {
    var toolbar = document.getElementById('wmd-button-row');
    var editarea = document.getElementById('wmd-editarea') || (text ? text.parentElement : null);
    var overlay = document.querySelector('.typecho-scribe-overlay');
    var overlayText = document.querySelector('.typecho-scribe-loader-text');
    if (toolbar) {
      toolbar.classList.toggle('typecho-scribe-busy', busy);
    }
    if (overlay) {
      if (busy && editarea && overlay.parentNode !== editarea) {
        editarea.appendChild(overlay);
      }
      overlay.setAttribute('aria-hidden', busy ? 'false' : 'true');
    }
    if (overlayText && label) {
      overlayText.textContent = busy ? 'AI 正在' + label + '...' : 'AI 正在生成...';
    }
    if (busy) closeScribeMenus();
    scribeButtons.forEach(function(control) {
      control.setAttribute('aria-disabled', busy ? 'true' : 'false');
    });
    if (button) {
      button.setAttribute('aria-disabled', busy ? 'true' : 'false');
    }
    if (text) {
      text.readOnly = busy;
      text.classList.toggle('typecho-scribe-locked', busy);
      text.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
  }

  function mergeAiCompletion(oldText, streamedText, mode) {
    var fence = String.fromCharCode(96) + '{3}';
    var fenceStart = new RegExp('^\\\\s*' + fence + '(?:markdown|md)?\\\\s*', 'i');
    var fenceEnd = new RegExp('\\\\s*' + fence + '\\\\s*$', 'i');
    var cleaned = (streamedText || '').replace(fenceStart, '').replace(fenceEnd, '').trim();
    if (!oldText.trim() || mode === 'generate') return cleaned;
    if (!cleaned) return oldText;

    return mergeFullRewrite(oldText, cleaned);
  }

  function mergeFullRewrite(oldText, rewrittenText) {
    var oldParts = splitTrailingReferenceBlock(oldText);
    var rewrittenParts = splitTrailingReferenceBlock(rewrittenText);
    var body = rewrittenParts.body || rewrittenText;
    var refs = mergeReferenceBlocks(oldParts.refs, rewrittenParts.refs);

    if (!looksLikeCompleteRewrite(oldParts.body || oldText, body)) {
      body = joinMarkdownBlocks(oldParts.body || oldText, body);
    }

    return joinMarkdownBlocks(body, refs);
  }

  function looksLikeCompleteRewrite(oldBody, rewrittenBody) {
    var oldNormalized = normalizeMarkdownBody(oldBody);
    var rewrittenNormalized = normalizeMarkdownBody(rewrittenBody);
    if (oldNormalized.length < 30) return true;
    if (rewrittenNormalized.indexOf(oldNormalized.slice(0, Math.min(120, oldNormalized.length))) >= 0) return true;

    var oldHeadings = markdownHeadings(oldBody);
    if (oldHeadings.length > 0) {
      var rewrittenHeadings = markdownHeadings(rewrittenBody);
      if (rewrittenHeadings.indexOf(oldHeadings[0]) >= 0 && rewrittenNormalized.length >= oldNormalized.length * 0.6) {
        return true;
      }
    }

    var anchors = significantMarkdownLines(oldBody).slice(0, 6);
    if (anchors.length === 0) return rewrittenNormalized.length >= oldNormalized.length * 0.6;

    var hits = 0;
    anchors.forEach(function(line) {
      if (rewrittenNormalized.indexOf(line) >= 0) hits += 1;
    });
    return hits >= Math.min(2, anchors.length) && rewrittenNormalized.length >= oldNormalized.length * 0.6;
  }

  function normalizeMarkdownBody(markdown) {
    return String(markdown || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  }

  function significantMarkdownLines(markdown) {
    return String(markdown || '')
      .split('\\n')
      .map(normalizeMarkdownBody)
      .filter(function(line) {
        return line.length >= 12 && !isReferenceDefinitionLine(line);
      });
  }

  function markdownHeadings(markdown) {
    return String(markdown || '')
      .split('\\n')
      .map(function(line) {
        var match = String(line || '').match(/^\\s{0,3}#{1,6}\\s+(.+?)\\s*#*\\s*$/);
        return match ? match[1].trim().toLowerCase() : '';
      })
      .filter(Boolean);
  }

  function splitTrailingReferenceBlock(markdown) {
    var normalized = String(markdown || '').replace(/\\s+$/, '');
    if (!normalized) return { body: '', refs: '' };

    var lines = normalized.split('\\n');
    var i = lines.length - 1;
    while (i >= 0 && !lines[i].trim()) i -= 1;

    var end = i;
    var sawReference = false;
    while (i >= 0) {
      var line = lines[i];
      if (!line.trim()) {
        i -= 1;
        continue;
      }
      if (isReferenceDefinitionLine(line)) {
        sawReference = true;
        i -= 1;
        continue;
      }
      if (isReferenceContinuationLine(line)) {
        i -= 1;
        continue;
      }
      break;
    }

    if (!sawReference) return { body: normalized, refs: '' };
    return {
      body: lines.slice(0, i + 1).join('\\n').replace(/\\s+$/, ''),
      refs: lines.slice(i + 1, end + 1).join('\\n').trim(),
    };
  }

  function isReferenceDefinitionLine(line) {
    return /^\\s{0,3}\\[(?:\\^?[^\\]]+)\\]:\\s+\\S/.test(line);
  }

  function isReferenceContinuationLine(line) {
    return /^\\s{4,}\\S/.test(line);
  }

  function joinMarkdownBlocks(first, second) {
    var left = String(first || '').replace(/\\s+$/, '');
    var right = String(second || '').replace(/^\\s+/, '').replace(/\\s+$/, '');
    if (!left) return right;
    if (!right) return left;
    return left + '\\n\\n' + right;
  }

  function mergeReferenceBlocks(first, second) {
    var merged = [];
    var seen = {};
    appendReferenceLines(merged, seen, first);
    appendReferenceLines(merged, seen, second);
    return merged.join('\\n').trim();
  }

  function appendReferenceLines(merged, seen, block) {
    String(block || '').split('\\n').forEach(function(line) {
      var key = referenceKey(line);
      if (key && seen[key]) return;
      if (key) seen[key] = true;
      if (line.trim() || merged.length > 0) merged.push(line);
    });
  }

  function referenceKey(line) {
    var match = String(line || '').match(/^\\s{0,3}\\[((?:\\^)?[^\\]]+)\\]:/);
    return match ? match[1].trim().toLowerCase() : '';
  }

  function extractActionError(data) {
    if (!data) return '';
    if (typeof data === 'string') return data;
    if (typeof data.error === 'string') return data.error;
    if (data.error && typeof data.error === 'object') {
      if (typeof data.error.message === 'string') return data.error.message;
      if (typeof data.error.msg === 'string') return data.error.msg;
      if (typeof data.error.code === 'string') return data.error.code;
    }
    if (typeof data.message === 'string') return data.message;
    if (typeof data.msg === 'string') return data.msg;
    if (typeof data.detail === 'string') return data.detail;
    return '';
  }

  function extractActionErrorFromText(text) {
    var trimmed = String(text || '').trim();
    if (!trimmed) return '';
    try {
      return extractActionError(JSON.parse(trimmed));
    } catch (error) {
      return trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[' ? '' : trimmed;
    }
  }

  async function readActionError(response) {
    var text = await response.text().catch(function() { return ''; });
    return extractActionErrorFromText(text) || response.statusText || 'AI 写作失败';
  }

  async function readStreamIntoEditor(response, text, oldText, mode) {
    if (!response.body || !window.TextDecoder) {
      var data = await response.json().catch(function() { return {}; });
      if (!response.ok || !data.success) throw new Error(extractActionError(data) || 'AI 写作失败');
      text.value = mergeAiCompletion(oldText, data.content || '', mode);
      return;
    }

    if (!response.ok) {
      throw new Error(await readActionError(response));
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var nextText = '';
    text.value = mode === 'polish' || mode === 'correct' ? oldText : '';

    for (;;) {
      var result = await reader.read();
      if (result.done) break;
      nextText += decoder.decode(result.value, { stream: true });
      text.value = nextText;
    }

    var tail = decoder.decode();
    if (tail) {
      nextText += tail;
    }
    text.value = mergeAiCompletion(oldText, nextText, mode);

    if (!text.value && oldText) {
      text.value = oldText;
      throw new Error('AI 未返回内容');
    }
  }

  async function runScribe(box, button, requestedMode) {
    if (button && button.getAttribute('aria-disabled') === 'true') return;

    var title = document.getElementById('title');
    var text = document.getElementById('text');
    var csrf = document.querySelector('input[name="_"]');
    var cid = document.querySelector('input[name="cid"]');
    if (!box || !title || !text || !csrf) return;

    var oldText = text.value || '';
    var hasText = oldText.trim() !== '';
    var mode;
    if (requestedMode) {
      if ((requestedMode === 'polish' || requestedMode === 'correct') && !hasText) {
        showAdminNotice('请先输入正文，再使用 AI ' + modeLabel(requestedMode), 'error');
        return;
      }
      mode = requestedMode;
    } else {
      mode = 'generate';
    }
    var label = modeLabel(mode);

    setBusy(text, button, true, label);
    clearAdminNotice();

    try {
      var response = await fetch('/api/admin/plugin-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          _: csrf.value,
          plugin: '${PLUGIN_ID}',
          action: mode,
          payload: {
            contentType: box.getAttribute('data-content-type') || 'post',
            title: title.value || '',
            body: oldText,
            cid: cid ? cid.value : '',
            attachmentIds: Array.prototype.slice.call(document.querySelectorAll('input[name="attachment[]"]')).map(function(input) {
              return input.value || '';
            })
          }
        })
      });
      await readStreamIntoEditor(response, text, oldText, mode);
      text.dispatchEvent(new Event('input', { bubbles: true }));
      if (window.jQuery) window.jQuery(text).trigger('input');
      showAdminNotice('AI ' + label + '完成', 'success');
    } catch (error) {
      text.value = oldText;
      showAdminNotice(error && error.message ? error.message : 'AI 写作失败', 'error');
    } finally {
      setBusy(text, button, false, label);
    }
  }

  var scribeMenuOpen = false;

  function closeScribeMenus() {
    if (!scribeMenuOpen) return;
    scribeMenuOpen = false;
    document.querySelectorAll('.typecho-scribe-menu').forEach(function(menu) {
      menu.setAttribute('aria-hidden', 'true');
    });
    document.querySelectorAll('.typecho-scribe-menu-trigger').forEach(function(trigger) {
      trigger.setAttribute('aria-expanded', 'false');
    });
  }

  function toggleScribeMenu(trigger) {
    if (!trigger || trigger.getAttribute('aria-disabled') === 'true') return;
    var menu = trigger.querySelector('.typecho-scribe-menu');
    if (!menu) return;
    var willOpen = menu.getAttribute('aria-hidden') !== 'false';
    closeScribeMenus();
    menu.setAttribute('aria-hidden', willOpen ? 'false' : 'true');
    trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    scribeMenuOpen = willOpen;
  }

  function createMenuButton(box, mode, title) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'typecho-scribe-menu-button';
    button.innerHTML = MODE_ICONS[mode] || '';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', function(event) {
      event.preventDefault();
      event.stopPropagation();
      closeScribeMenus();
      runScribe(box, button, mode);
    });
    scribeButtons.push(button);
    return button;
  }

  function createScribeMenu(box) {
    var menu = document.createElement('div');
    menu.className = 'typecho-scribe-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-hidden', 'true');
    Object.keys(MODE_TITLES).forEach(function(mode) {
      menu.appendChild(createMenuButton(box, mode, MODE_TITLES[mode]));
    });
    return menu;
  }

  function createToolbarButton(box) {
    var item = document.createElement('li');
    item.id = 'wmd-scribe-button';
    item.className = 'wmd-button typecho-scribe-toolbar-button typecho-scribe-menu-trigger';
    item.title = 'AI 写作';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', 'AI 写作');
    item.setAttribute('aria-haspopup', 'menu');
    item.setAttribute('aria-expanded', 'false');
    item.innerHTML = SCRIBE_ICON;
    item.appendChild(createScribeMenu(box));
    item.addEventListener('click', function(event) {
      event.preventDefault();
      event.stopPropagation();
      toggleScribeMenu(item);
    });
    item.addEventListener('keydown', function(event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleScribeMenu(item);
      } else if (event.key === 'Escape') {
        closeScribeMenus();
      }
    });
    scribeButtons.push(item);
    return item;
  }

  function createFallbackButton(box) {
    var actions = box.querySelector('.typecho-scribe-fallback-actions');
    if (!actions || actions.querySelector('.typecho-scribe-fallback-btn')) return;
    var wrapper = document.createElement('span');
    wrapper.className = 'typecho-scribe-fallback-menu typecho-scribe-menu-trigger';
    wrapper.style.position = 'relative';
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-xs typecho-scribe-fallback-btn';
    button.innerHTML = SCRIBE_ICON;
    button.title = 'AI 写作';
    button.setAttribute('aria-label', 'AI 写作');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    wrapper.appendChild(button);
    wrapper.appendChild(createScribeMenu(box));
    button.addEventListener('click', function(event) {
      event.preventDefault();
      event.stopPropagation();
      toggleScribeMenu(wrapper);
    });
    actions.appendChild(wrapper);
    scribeButtons.push(button);
    box.hidden = false;
  }

  function mountButton(box) {
    if (document.getElementById('wmd-scribe-button')) return true;
    var row = document.getElementById('wmd-button-row');
    if (!row) return false;

    var spacer = document.createElement('li');
    spacer.className = 'wmd-spacer typecho-scribe-spacer';
    row.appendChild(spacer);
    row.appendChild(createToolbarButton(box));
    box.hidden = false;
    box.classList.add('typecho-scribe-mounted');
    return true;
  }

  function initScribe() {
    var box = document.querySelector('.typecho-scribe');
    if (!box) return;
    var attempts = 0;
    var timer = window.setInterval(function() {
      attempts += 1;
      if (mountButton(box)) {
        window.clearInterval(timer);
      } else if (attempts >= 50) {
        window.clearInterval(timer);
        createFallbackButton(box);
      }
    }, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScribe);
  } else {
    initScribe();
  }
  document.addEventListener('click', closeScribeMenus);
})();
</script>`;
}

export default function init({ addHook, pluginId }: PluginInitContext): void {
  addHook('admin:writePost:bottom', pluginId, (html: string) => html + POST_EDITOR_HTML);
  addHook('admin:writePage:bottom', pluginId, (html: string) => html + PAGE_EDITOR_HTML);

  addHook(
    'plugin:config:beforeSave',
    pluginId,
    async (result: ConfigValidationResult, extra?: { pluginId?: string; settings?: Record<string, unknown> }) => {
      if (extra?.pluginId !== pluginId) return result;

      try {
        const settings = await validateConfig(extra.settings || {});
        return { success: true, settings };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'LLM 配置校验失败',
        };
      }
    },
  );

  addHook(
    `plugin:${pluginId}:action`,
    pluginId,
    async (
      result: PluginActionResult,
      extra?: { action?: string; payload?: WriterPayload; options?: Record<string, unknown>; db?: Database },
    ) => {
      const action = extra?.action || '';
      if (!['generate', 'polish', 'correct'].includes(action)) return result;

      try {
        const config = getConfig(extra?.options);
        const payload = extra?.payload || {};
        const siteUrl = typeof extra?.options?.siteUrl === 'string' ? extra.options.siteUrl : undefined;
        const [styleSamples, assets] = await Promise.all([
          loadStyleSamples(extra?.db, Number.isFinite(Number(config.stylePostCount)) ? Number(config.stylePostCount) : 0),
          loadContentAssets(extra?.db, config, payload),
        ]);
        const response = await callLLMStream(config, action as WriterMode, payload, styleSamples, assets, siteUrl);
        return {
          handled: true,
          success: true,
          response,
        };
      } catch (error) {
        return {
          handled: true,
          success: false,
          error: error instanceof Error ? error.message : 'AI 写作失败',
        };
      }
    },
  );
}
