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

  const headHtml = `<script is:inline>
(function() {
  window.__typechoTurnstilePending = window.__typechoTurnstilePending || null;
  window.__typechoTurnstileSubmit = window.__typechoTurnstileSubmit || function(token) {
    var pending = window.__typechoTurnstilePending;
    if (!pending || !pending.form) return;

    var old = pending.form.querySelector('input[name="' + pending.inputName + '"]');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var field = document.createElement("input");
    field.id = pending.inputName;
    field.name = pending.inputName;
    field.type = "hidden";
    field.value = token;
    pending.form.appendChild(field);

    if (pending.timer) clearTimeout(pending.timer);
    if (pending.button) pending.button.disabled = false;
    window.__typechoTurnstilePending = null;
    pending.form.submit();
  };
  window.__typechoTurnstileSetStatus = window.__typechoTurnstileSetStatus || function(containerId, message, type) {
    var status = document.getElementById(containerId + "-status");
    if (!status) return;
    status.textContent = message || "";
    status.className = "typecho-turnstile-status message " + (type === "error" ? "error" : "notice");
  };
  window.__typechoTurnstileResetPending = window.__typechoTurnstileResetPending || function(message) {
    var pending = window.__typechoTurnstilePending;
    if (pending && pending.timer) clearTimeout(pending.timer);
    if (pending && pending.button) pending.button.disabled = false;
    if (pending && pending.containerId && message) {
      window.__typechoTurnstileSetStatus(pending.containerId, message, "error");
    }
    window.__typechoTurnstilePending = null;
  };
  window.__typechoTurnstileReady = window.__typechoTurnstileReady || function(callback) {
    if (window.turnstile && typeof window.turnstile.execute === "function") {
      callback();
      return;
    }
    var attempts = 0;
    var timer = setInterval(function() {
      attempts += 1;
      if (window.turnstile && typeof window.turnstile.execute === "function") {
        clearInterval(timer);
        callback();
      } else if (attempts >= 100) {
        clearInterval(timer);
      }
    }, 100);
  };
})();
</script><style>
.typecho-turnstile { margin: 0 0 1em; text-align: center; }
.typecho-turnstile-widget { display: inline-block; min-height: 65px; }
.typecho-turnstile-status:empty { display: none; }
.typecho-turnstile-status { margin: 6px 0 0; text-align: left; }
</style><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;
  const sitekey = escapeAttr(config.sitekey);
  const inputAttr = escapeAttr(config.input);
  const themeAttr = escapeAttr(config.theme);
  const sizeAttr = escapeAttr(config.size);
  const appearanceAttr = escapeAttr(config.appearance);
  const onDemand = config.appearance === 'execute' || config.appearance === 'interaction-only';
  const executionAttr = escapeAttr(onDemand ? 'execute' : 'render');
  const input = JSON.stringify(config.input);
  const targetFormId = JSON.stringify(formId);
  const containerIdValue = `typecho-turnstile-${formId}`;
  const containerIdAttr = escapeAttr(containerIdValue);
  const statusIdAttr = escapeAttr(`${containerIdValue}-status`);

  const widgetHtml = `<div class="typecho-turnstile">
<div
  id="${containerIdAttr}"
  class="cf-turnstile typecho-turnstile-widget"
  data-sitekey="${sitekey}"
  data-theme="${themeAttr}"
  data-size="${sizeAttr}"
  data-appearance="${appearanceAttr}"
  data-execution="${executionAttr}"
  data-response-field="true"
  data-response-field-name="${inputAttr}"
  data-callback="__typechoTurnstileSubmit"
  data-error-callback="__typechoTurnstileResetPending"
  data-timeout-callback="__typechoTurnstileResetPending"
></div>
<p id="${statusIdAttr}" class="typecho-turnstile-status" aria-live="polite"></p>
</div>`;

  if (!onDemand) {
    return {
      headHtml,
      bodyHtml: widgetHtml,
    };
  }

  return {
    headHtml,
    bodyHtml: `${widgetHtml}<script is:inline>
(function() {
  var inputName = ${input};
  var containerId = ${JSON.stringify(containerIdValue)};

  function getTokenField(form) {
    return form.querySelector('input[name="' + inputName + '"]');
  }

  function hasToken(form) {
    var field = getTokenField(form);
    return !!(field && field.value);
  }

  function resetPending() {
    window.__typechoTurnstileResetPending("人机验证加载超时，请检查网络后重试");
  }

  function initTurnstile() {
    var form = document.getElementById(${targetFormId});
    if (!form) return;
    form.addEventListener("submit", function(e) {
      if (hasToken(form)) return;
      e.preventDefault();
      var button = form.querySelector('[type="submit"]');
      if (button) button.disabled = true;
      window.__typechoTurnstileSetStatus(containerId, "正在加载人机验证，请稍候...", "loading");
      window.__typechoTurnstilePending = {
        form: form,
        inputName: inputName,
        containerId: containerId,
        button: button,
        timer: setTimeout(resetPending, 15000)
      };
      window.__typechoTurnstileReady(function() {
        window.__typechoTurnstileSetStatus(containerId, "请完成人机验证", "loading");
        turnstile.execute("#" + containerId);
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

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
