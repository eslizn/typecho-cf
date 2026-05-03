/**
 * Cloudflare Turnstile Plugin for Typecho
 *
 * Integrates Cloudflare Turnstile to protect comment forms from spam
 * and admin login from brute-force attacks.
 *
 * Configuration is stored as a single JSON object in the options table,
 * following the Typecho convention: name = "plugin:typecho-plugin-turnstile", value = JSON string.
 *
 * Hooks used:
 *   - feedback:comment (filter): Validates Turnstile token before saving comment
 *   - archive:header (filter): Injects Turnstile SDK script into <head>
 *   - archive:footer (filter): Injects comment form widget/interaction script before </body>
 *   - admin:loginHead (filter): Injects Turnstile SDK script into login page <head>
 *   - admin:loginForm (filter): Injects Turnstile widget into login form
 *   - user:login (filter): Validates Turnstile token before admin login
 */

/** Default configuration values */
const DEFAULTS = {
  sitekey: '',
  secret: '',
  input: 'cf-turnstile-response',
  appearance: 'always',
  theme: 'auto',
  size: 'normal',
};

/**
 * Fetch plugin configuration from the options table.
 */
function getPluginConfig(options) {
  const raw = options?.['plugin:typecho-plugin-turnstile'];
  if (!raw) {
    return { ...DEFAULTS };
  }

  try {
    const config = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      sitekey: config.sitekey || DEFAULTS.sitekey,
      secret: config.secret || DEFAULTS.secret,
      input: config.input || DEFAULTS.input,
      appearance: config.appearance || DEFAULTS.appearance,
      theme: config.theme || DEFAULTS.theme,
      size: config.size || DEFAULTS.size,
    };
  } catch {
    console.error('[turnstile] Failed to parse plugin config');
    return { ...DEFAULTS };
  }
}

/**
 * Verify a Turnstile token with Cloudflare's API.
 * @see https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */
async function verifyTurnstile(token, secret, remoteIp) {
  const url = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

  const body = new URLSearchParams({
    secret,
    response: token,
    remoteip: remoteIp,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    return resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} options - Site options object (from loadOptions)
 * @param {string} formId - Target form element ID
 * @returns {{headHtml: string, bodyHtml: string}}
 */
function buildSnippet(options, formId) {
  const config = getPluginConfig(options);

  if (!config.sitekey) {
    return { headHtml: '', bodyHtml: '' };
  }

  const headHtml = `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;

  let bodyHtml;

  if (config.appearance === 'execute') {
    bodyHtml = `<script is:inline>
(function() {
  function initTurnstile() {
    var form = document.getElementById("${formId}");
    if (!form) return;
    form.addEventListener("submit", function(e) {
      e.preventDefault();
      var btn = form.querySelector('[type="submit"]');
      if (btn) btn.disabled = true;
      turnstile.execute("${config.sitekey}", {
        theme: "${config.theme}",
        size: "${config.size}",
        callback: function(token) {
          var old = document.getElementById("${config.input}");
          if (old) old.parentNode.removeChild(old);
          var input = document.createElement("input");
          input.id = "${config.input}";
          input.name = "${config.input}";
          input.type = "hidden";
          input.value = token;
          form.appendChild(input);
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
</script>`;
  } else {
    bodyHtml = `<script is:inline>
(function() {
  function initTurnstile() {
    var form = document.getElementById("${formId}");
    if (!form) return;
    var container = document.createElement("div");
    container.className = "cf-turnstile";
    container.dataset.sitekey = "${config.sitekey}";
    container.dataset.theme = "${config.theme}";
    container.dataset.size = "${config.size}";
    if ("${config.appearance}" === "interaction-only") {
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
</script>`;
  }

  return { headHtml, bodyHtml };
}

/**
 * Read client IP from request headers.
 */
function getIp(request) {
  if (!request) return '';
  const cfIp = request.headers?.get('cf-connecting-ip');
  if (cfIp) return cfIp.trim();
  const xff = request.headers?.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0];
    return first ? first.trim() : '';
  }
  return '';
}

/**
 * Verify a Turnstile token. Returns an error message if rejected, or null if valid.
 * Returns null (skip) when the plugin is not fully configured.
 */
async function checkTurnstile(config, extra) {
  if (!config.sitekey || !config.secret) {
    return null; // not configured, skip silently
  }

  if (extra.skipIfLoggedIn && extra.isLoggedIn) {
    return null;
  }

  const token = extra.formData?.get(config.input)?.toString() || '';
  if (!token) {
    return '请完成人机验证';
  }

  const ip = getIp(extra.request);

  try {
    const result = await verifyTurnstile(token, config.secret, ip);
    if (!result || !result.success) {
      return '人机验证失败';
    }
  } catch (err) {
    console.error('[turnstile] Verification API error:', err);
    return '验证服务异常，请稍后重试';
  }

  return null;
}

export default function init({ addHook, pluginId }) {
  // Filter: feedback:comment — validates Turnstile token before saving comment
  addHook('feedback:comment', pluginId, async (commentData, extra) => {
    if (!extra?.options) return commentData;

    const config = getPluginConfig(extra.options);
    const msg = await checkTurnstile(config, { ...extra, skipIfLoggedIn: true });
    if (msg) {
      commentData._rejected = msg;
    }
    return commentData;
  });

  // Filter: archive:header — inject Turnstile SDK into <head>
  addHook('archive:header', pluginId, (headHtml, extra) => {
    const snippet = buildSnippet(extra?.options, 'comment-form');
    return headHtml + snippet.headHtml;
  });

  // Filter: archive:footer — inject comment form script before </body>
  addHook('archive:footer', pluginId, (bodyHtml, extra) => {
    const snippet = buildSnippet(extra?.options, 'comment-form');
    return bodyHtml + snippet.bodyHtml;
  });

  // Filter: admin:loginHead — inject Turnstile SDK into login page <head>
  addHook('admin:loginHead', pluginId, (headHtml, extra) => {
    const snippet = buildSnippet(extra?.options, 'login-form');
    return headHtml + snippet.headHtml;
  });

  // Filter: admin:loginForm — inject Turnstile widget into login form
  addHook('admin:loginForm', pluginId, (formHtml, extra) => {
    const snippet = buildSnippet(extra?.options, 'login-form');
    return formHtml + snippet.bodyHtml;
  });

  // Filter: user:login — validate Turnstile token before admin login
  addHook('user:login', pluginId, async (loginContext, extra) => {
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
export function getClientSnippet(options) {
  return buildSnippet(options, 'comment-form');
}
