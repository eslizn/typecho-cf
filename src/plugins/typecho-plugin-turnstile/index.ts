import type { PluginInitContext } from '@/lib/plugin';

interface TurnstileConfig {
  sitekey: string;
  secret: string;
  input: string;
  appearance: string;
  theme: string;
  size: string;
}

interface TurnstileVerifyResponse {
  success?: boolean;
}

interface MutableContext {
  _rejected?: string;
  [key: string]: unknown;
}

interface VerificationExtra {
  options?: Record<string, unknown>;
  formData?: FormData;
  request?: Request;
  isLoggedIn?: boolean;
  skipIfLoggedIn?: boolean;
}

const DEFAULTS: TurnstileConfig = {
  sitekey: '',
  secret: '',
  input: 'cf-turnstile-response',
  appearance: 'always',
  theme: 'auto',
  size: 'normal',
};

function readObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    console.error('[turnstile] Failed to parse plugin config');
    return {};
  }
}

function getPluginConfig(options?: Record<string, unknown>): TurnstileConfig {
  const config = readObject(options?.['plugin:typecho-plugin-turnstile']);
  return {
    sitekey: String(config.sitekey || DEFAULTS.sitekey),
    secret: String(config.secret || DEFAULTS.secret),
    input: String(config.input || DEFAULTS.input),
    appearance: String(config.appearance || DEFAULTS.appearance),
    theme: String(config.theme || DEFAULTS.theme),
    size: String(config.size || DEFAULTS.size),
  };
}

async function verifyTurnstile(token: string, secret: string, remoteIp: string): Promise<TurnstileVerifyResponse> {
  const body = new URLSearchParams({
    secret,
    response: token,
    remoteip: remoteIp,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    return await resp.json() as TurnstileVerifyResponse;
  } finally {
    clearTimeout(timer);
  }
}

function buildSnippet(options: Record<string, unknown> | undefined, formId: string): { headHtml: string; bodyHtml: string } {
  const config = getPluginConfig(options);
  if (!config.sitekey) {
    return { headHtml: '', bodyHtml: '' };
  }

  const headHtml = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>';
  const sitekey = JSON.stringify(config.sitekey);
  const input = JSON.stringify(config.input);
  const theme = JSON.stringify(config.theme);
  const size = JSON.stringify(config.size);
  const appearance = JSON.stringify(config.appearance);
  const targetFormId = JSON.stringify(formId);

  if (config.appearance === 'execute') {
    return {
      headHtml,
      bodyHtml: `<script is:inline>
(function() {
  function initTurnstile() {
    var form = document.getElementById(${targetFormId});
    if (!form) return;
    form.addEventListener("submit", function(e) {
      e.preventDefault();
      var btn = form.querySelector('[type="submit"]');
      if (btn) btn.disabled = true;
      turnstile.execute(${sitekey}, {
        theme: ${theme},
        size: ${size},
        callback: function(token) {
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
        }
      });
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initTurnstile);
  } else {
    initTurnstile();
  }
})();
</script>`,
    };
  }

  return {
    headHtml,
    bodyHtml: `<script is:inline>
(function() {
  function initTurnstile() {
    var form = document.getElementById(${targetFormId});
    if (!form) return;
    var container = document.createElement("div");
    container.className = "cf-turnstile";
    container.dataset.sitekey = ${sitekey};
    container.dataset.theme = ${theme};
    container.dataset.size = ${size};
    if (${appearance} === "interaction-only") {
      container.dataset.appearance = "interaction-only";
    }
    var submitBtn = form.querySelector('[type="submit"]');
    if (submitBtn) {
      submitBtn.parentNode.insertBefore(container, submitBtn);
    } else {
      form.appendChild(container);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initTurnstile);
  } else {
    initTurnstile();
  }
})();
</script>`,
  };
}

function getIp(request?: Request): string {
  const cfIp = request?.headers.get('cf-connecting-ip');
  if (cfIp) return cfIp.trim();
  const xff = request?.headers.get('x-forwarded-for');
  return xff ? (xff.split(',')[0] ?? '').trim() : '';
}

async function checkTurnstile(config: TurnstileConfig, extra: VerificationExtra): Promise<string | null> {
  if (!config.sitekey || !config.secret) {
    return null;
  }
  if (extra.skipIfLoggedIn && extra.isLoggedIn) {
    return null;
  }

  const token = extra.formData?.get(config.input)?.toString() || '';
  if (!token) {
    return '请完成人机验证';
  }

  try {
    const result = await verifyTurnstile(token, config.secret, getIp(extra.request));
    return result.success ? null : '人机验证失败';
  } catch (err) {
    console.error('[turnstile] Verification API error:', err);
    return '验证服务异常，请稍后重试';
  }
}

export default function init({ addHook, pluginId }: PluginInitContext): void {
  addHook('feedback:comment', pluginId, async (commentData: MutableContext, extra?: VerificationExtra) => {
    if (!extra?.options) return commentData;

    const config = getPluginConfig(extra.options);
    const msg = await checkTurnstile(config, { ...extra, skipIfLoggedIn: true });
    if (msg) {
      commentData._rejected = msg;
    }
    return commentData;
  });

  addHook('archive:header', pluginId, (headHtml: string, extra?: { options?: Record<string, unknown> }) => {
    const snippet = buildSnippet(extra?.options, 'comment-form');
    return headHtml + snippet.headHtml;
  });

  addHook('archive:footer', pluginId, (bodyHtml: string, extra?: { options?: Record<string, unknown> }) => {
    const snippet = buildSnippet(extra?.options, 'comment-form');
    return bodyHtml + snippet.bodyHtml;
  });

  addHook('admin:loginHead', pluginId, (headHtml: string, extra?: { options?: Record<string, unknown> }) => {
    const snippet = buildSnippet(extra?.options, 'login-form');
    return headHtml + snippet.headHtml;
  });

  addHook('admin:loginForm', pluginId, (formHtml: string, extra?: { options?: Record<string, unknown> }) => {
    const snippet = buildSnippet(extra?.options, 'login-form');
    return formHtml + snippet.bodyHtml;
  });

  addHook('user:login', pluginId, async (loginContext: MutableContext, extra?: VerificationExtra) => {
    if (!extra?.options) return loginContext;

    const config = getPluginConfig(extra.options);
    const msg = await checkTurnstile(config, extra);
    if (msg) {
      loginContext._rejected = msg;
    }
    return loginContext;
  });
}

/**
 * @deprecated Use archive:header / archive:footer hooks instead.
 * Kept for backward compatibility.
 */
export function getClientSnippet(options?: Record<string, unknown>): { headHtml: string; bodyHtml: string } {
  return buildSnippet(options, 'comment-form');
}
