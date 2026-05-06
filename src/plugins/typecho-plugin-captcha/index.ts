import type { PluginInitContext } from '@/lib/plugin';

interface CaptchaConfig {
  client: string;
  server: string;
  api: string;
  input: string;
  action: string;
  hidden: number;
  score: number;
}

interface CaptchaVerifyResponse {
  success?: boolean;
  score?: number;
}

interface CommentData {
  _rejected?: string;
  [key: string]: unknown;
}

interface CommentExtra {
  options?: Record<string, unknown>;
  formData?: FormData;
  request?: Request;
  isLoggedIn?: boolean;
}

const DEFAULTS: CaptchaConfig = {
  client: '',
  server: '',
  api: 'https://www.recaptcha.net',
  input: 'captcha',
  action: 'social',
  hidden: 0,
  score: 0.5,
};

function readObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    console.error('[captcha] Failed to parse plugin config');
    return {};
  }
}

function getPluginConfig(options?: Record<string, unknown>): CaptchaConfig {
  const config = readObject(options?.['plugin:typecho-plugin-captcha']);
  return {
    client: String(config.client || DEFAULTS.client),
    server: String(config.server || DEFAULTS.server),
    api: String(config.api || DEFAULTS.api).replace(/\/$/, ''),
    input: String(config.input || DEFAULTS.input),
    action: String(config.action || DEFAULTS.action),
    hidden: Number(config.hidden) || DEFAULTS.hidden,
    score: config.score != null ? Number(config.score) : DEFAULTS.score,
  };
}

async function verifyRecaptcha(
  token: string,
  server: string,
  api: string,
  remoteIp: string,
): Promise<CaptchaVerifyResponse> {
  const body = new URLSearchParams({
    secret: server,
    response: token,
    remoteip: remoteIp,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const resp = await fetch(`${api}/recaptcha/api/siteverify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    return await resp.json() as CaptchaVerifyResponse;
  } finally {
    clearTimeout(timer);
  }
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildClientSnippet(options?: Record<string, unknown>): { headHtml: string; bodyHtml: string } {
  const config = getPluginConfig(options);
  if (!config.client) {
    return { headHtml: '', bodyHtml: '' };
  }

  let headHtml = `<script src="${escapeAttr(config.api)}/recaptcha/api.js?render=${escapeAttr(config.client)}"></script>`;
  if (config.hidden) {
    headHtml += '<style type="text/css">.grecaptcha-badge {display: none !important;}</style>';
  }

  const client = JSON.stringify(config.client);
  const input = JSON.stringify(config.input);
  const action = JSON.stringify(config.action);
  const bodyHtml = `<script is:inline>
(function() {
  function initCaptcha() {
    var form = document.getElementById("comment-form");
    if (!form) return;
    form.addEventListener("submit", function(e) {
      e.preventDefault();
      var btn = form.querySelector('[type="submit"]');
      if (btn) btn.disabled = true;
      grecaptcha.ready(function() {
        grecaptcha.execute(${client}, {action: ${action}}).then(function(token) {
          var inputName = ${input};
          var old = document.getElementById(inputName);
          if (old) old.parentNode.removeChild(old);
          var field = document.createElement("input");
          field.id = inputName;
          field.name = inputName;
          field.type = "hidden";
          field.value = token;
          form.appendChild(field);
          if (btn) btn.disabled = false;
          form.submit();
        });
      });
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCaptcha);
  } else {
    initCaptcha();
  }
})();
</script>`;

  return { headHtml, bodyHtml };
}

function getIp(request?: Request): string {
  const cfIp = request?.headers.get('cf-connecting-ip');
  if (cfIp) return cfIp.trim();
  const xffRaw = request?.headers.get('x-forwarded-for');
  return xffRaw ? (xffRaw.split(',')[0] ?? '').trim() : '';
}

export default function init({ addHook, pluginId }: PluginInitContext): void {
  addHook('feedback:comment', pluginId, async (commentData: CommentData, extra?: CommentExtra) => {
    if (!extra?.options) {
      console.warn('[captcha] No options context provided, skipping verification');
      return commentData;
    }

    const config = getPluginConfig(extra.options);
    if (!config.client || !config.server || extra.isLoggedIn) {
      return commentData;
    }

    const token = extra.formData?.get(config.input)?.toString() || '';
    if (!token) {
      commentData._rejected = '请完成验证码验证';
      return commentData;
    }

    try {
      const result = await verifyRecaptcha(token, config.server, config.api, getIp(extra.request));
      if (!result.success || (typeof result.score === 'number' && result.score < config.score)) {
        commentData._rejected = '验证码验证失败';
      }
    } catch (err) {
      console.error('[captcha] Verification API error:', err);
      commentData._rejected = '验证码服务异常，请稍后重试';
    }

    return commentData;
  });

  addHook('archive:header', pluginId, (headHtml: string, extra?: { options?: Record<string, unknown> }) => {
    const snippet = buildClientSnippet(extra?.options);
    return headHtml + snippet.headHtml;
  });

  addHook('archive:footer', pluginId, (bodyHtml: string, extra?: { options?: Record<string, unknown> }) => {
    const snippet = buildClientSnippet(extra?.options);
    return bodyHtml + snippet.bodyHtml;
  });
}

/**
 * @deprecated Use archive:header / archive:footer hooks instead.
 * Kept for backward compatibility.
 */
export function getClientSnippet(options?: Record<string, unknown>): { headHtml: string; bodyHtml: string } {
  return buildClientSnippet(options);
}
