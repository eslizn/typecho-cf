/**
 * Captcha Plugin for Typecho
 *
 * Integrates Google reCAPTCHA v3 or Cloudflare Turnstile to protect
 * comment forms from spam. Ported from the original PHP Captcha plugin.
 *
 * Configuration is stored as a single JSON object in the options table,
 * following the Typecho convention: name = "plugin:typecho-plugin-captcha", value = JSON string.
 *
 * JSON value structure:
 *   {
 *     "client":  "site-key",           // Frontend key (required)
 *     "server":  "secret-key",         // Backend key (required)
 *     "api":     "https://...",        // API endpoint (default: depends on provider)
 *     "input":   "captcha",            // Form field name for token
 *     "action":  "social",             // reCAPTCHA action/scene
 *     "hidden":  0                     // 1 = hide reCAPTCHA badge
 *   }
 *
 * Field names match the original PHP Captcha plugin for compatibility.
 *
 * Hooks used:
 *   - feedback:comment (filter): Validates captcha token before saving comment
 *
 * The plugin also provides a client-side snippet (see getClientSnippet())
 * that themes should include in pages with comment forms.
 */

/** Default configuration values */
const DEFAULTS = {
  client: '',
  server: '',
  api: 'https://www.recaptcha.net',
  input: 'captcha',
  action: 'social',
  hidden: 0,
};

/**
 * Fetch plugin configuration from the options table.
 * Configuration is stored as a single row: name = "plugin:captcha", value = JSON string.
 * This follows the Typecho convention where PHP uses serialize(), we use JSON.
 *
 * The options object is passed from the caller (comment API) via extra.options,
 * which is loaded by loadOptions() and contains all rows from typecho_options.
 * The key "plugin:captcha" maps to a JSON string of plugin settings.
 */
function getPluginConfig(options) {
  const raw = options?.['plugin:captcha'];
  if (!raw) {
    return { ...DEFAULTS };
  }

  try {
    const config = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      client: config.client || DEFAULTS.client,
      server: config.server || DEFAULTS.server,
      api: config.api || DEFAULTS.api,
      input: config.input || DEFAULTS.input,
      action: config.action || DEFAULTS.action,
      hidden: Number(config.hidden) || DEFAULTS.hidden,
    };
  } catch {
    console.error('[captcha] Failed to parse plugin config');
    return { ...DEFAULTS };
  }
}

/**
 * Verify a reCAPTCHA v3 token with Google's API.
 */
async function verifyRecaptcha(token, server, api, remoteIp) {
  const url = `${api}/recaptcha/api/siteverify`;

  const body = new URLSearchParams({
    secret: server,
    response: token,
    remoteip: remoteIp,
  });

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  return resp.json();
}

/**
 * Plugin entry point.
 */
export default function init({ addHook, pluginId }) {
  /**
   * Filter: feedback:comment
   *
   * Validates the reCAPTCHA v3 token before the comment is saved.
   * The comment API passes { request, formData, db, isLoggedIn } as extra context.
   *
   * If validation fails, sets commentData._rejected which the comment API
   * checks and returns as a 403 response.
   */
  addHook('feedback:comment', pluginId, async (commentData, extra) => {
    // extra = { request, formData, db, options, isLoggedIn } passed from comment API
    if (!extra || !extra.options) {
      console.warn('[captcha] No options context provided, skipping verification');
      return commentData;
    }

    const config = getPluginConfig(extra.options);

    // If no keys configured, skip verification
    if (!config.client || !config.server) {
      return commentData;
    }

    // Skip for logged-in users (same as original PHP plugin)
    if (extra.isLoggedIn) {
      return commentData;
    }

    // Get captcha token from form data
    const token = extra.formData?.get(config.input)?.toString() || '';
    if (!token) {
      commentData._rejected = '请完成验证码验证';
      return commentData;
    }

    // Get client IP — prefer CF-Connecting-IP (single trusted value from Cloudflare).
    // X-Forwarded-For may be "clientIP, proxy1, proxy2"; only the first entry is the real client.
    const cfIp = extra.request?.headers?.get('cf-connecting-ip');
    const xffRaw = extra.request?.headers?.get('x-forwarded-for');
    const ip = cfIp
      ? cfIp.trim()
      : (xffRaw ? (xffRaw.split(',')[0] ?? '').trim() : '');

    try {
      const result = await verifyRecaptcha(token, config.server, config.api, ip);
      if (!result || !result.success) {
        commentData._rejected = '验证码验证失败';
        return commentData;
      }
    } catch (err) {
      console.error('[captcha] Verification API error:', err);
      commentData._rejected = '验证码服务异常，请稍后重试';
      return commentData;
    }

    return commentData;
  });
}

/**
 * Helper: Generate the client-side HTML snippets for themes.
 *
 * Themes should call this and include the returned HTML in comment form pages.
 * This matches the original PHP plugin's header() and footer() output.
 *
 * Usage in Astro components:
 *   import { getClientSnippet } from 'typecho-plugin-captcha';
 *   const captcha = getClientSnippet(ctx.options);
 *   ---
 *   <Fragment set:html={captcha.headHtml} />   <!-- in <head> -->
 *   <Fragment set:html={captcha.bodyHtml} />   <!-- before </body> -->
 *
 * @param {object} options - Site options object (from loadOptions)
 * @returns {{headHtml: string, bodyHtml: string}}
 */
export function getClientSnippet(options) {
  const config = getPluginConfig(options);

  if (!config.client) {
    return { headHtml: '', bodyHtml: '' };
  }

  let headHtml = `<script src="${config.api}/recaptcha/api.js?render=${config.client}"></script>`;
  if (config.hidden) {
    headHtml += '<style type="text/css">.grecaptcha-badge {display: none !important;}</style>';
  }

  const bodyHtml = `<script>grecaptcha.ready(function() { grecaptcha.execute("${config.client}", {action: "${config.action}"}).then(function(token) { var input = document.createElement("input"); input.id = input.name="${config.input}"; input.type="hidden"; input.value=token; if (document.getElementById("textarea")) { document.getElementById("textarea").parentNode.appendChild(input); } });});</script>`;

  return { headHtml, bodyHtml };
}
