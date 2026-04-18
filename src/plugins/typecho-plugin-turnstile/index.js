/**
 * Cloudflare Turnstile Plugin for Typecho
 *
 * Integrates Cloudflare Turnstile to protect comment forms from spam.
 *
 * Configuration is stored as a single JSON object in the options table,
 * following the Typecho convention: name = "plugin:typecho-plugin-turnstile", value = JSON string.
 *
 * Hooks used:
 *   - feedback:comment (filter): Validates Turnstile token before saving comment
 *   - archive:header (filter): Injects Turnstile SDK script into <head>
 *   - archive:footer (filter): Injects comment form widget/interaction script before </body>
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
 * Generate the client-side HTML snippets.
 * @param {object} options - Site options object (from loadOptions)
 * @returns {{headHtml: string, bodyHtml: string}}
 */
function buildClientSnippet(options) {
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
    var form = document.getElementById("comment-form");
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
    var form = document.getElementById("comment-form");
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
 * Plugin entry point.
 */
export default function init({ addHook, pluginId }) {
  // Filter: feedback:comment — validates Turnstile token before saving comment
  addHook('feedback:comment', pluginId, async (commentData, extra) => {
    if (!extra || !extra.options) {
      console.warn('[turnstile] No options context provided, skipping verification');
      return commentData;
    }

    const config = getPluginConfig(extra.options);

    if (!config.sitekey || !config.secret) {
      return commentData;
    }

    if (extra.isLoggedIn) {
      return commentData;
    }

    const token = extra.formData?.get(config.input)?.toString() || '';
    if (!token) {
      commentData._rejected = '请完成人机验证';
      return commentData;
    }

    const cfIp = extra.request?.headers?.get('cf-connecting-ip');
    const xffRaw = extra.request?.headers?.get('x-forwarded-for');
    const ip = cfIp
      ? cfIp.trim()
      : (xffRaw ? (xffRaw.split(',')[0] ?? '').trim() : '');

    try {
      const result = await verifyTurnstile(token, config.secret, ip);
      if (!result || !result.success) {
        commentData._rejected = '人机验证失败';
        return commentData;
      }
    } catch (err) {
      console.error('[turnstile] Verification API error:', err);
      commentData._rejected = '验证服务异常，请稍后重试';
      return commentData;
    }

    return commentData;
  });

  // Filter: archive:header — inject Turnstile SDK into <head>
  addHook('archive:header', pluginId, (headHtml, extra) => {
    const snippet = buildClientSnippet(extra?.options);
    return headHtml + snippet.headHtml;
  });

  // Filter: archive:footer — inject comment form script before </body>
  addHook('archive:footer', pluginId, (bodyHtml, extra) => {
    const snippet = buildClientSnippet(extra?.options);
    return bodyHtml + snippet.bodyHtml;
  });
}

/**
 * @deprecated Use archive:header / archive:footer hooks instead.
 * Kept for backward compatibility.
 */
export function getClientSnippet(options) {
  return buildClientSnippet(options);
}
