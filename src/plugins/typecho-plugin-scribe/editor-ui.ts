/**
 * Editor UI injected through the admin:writePost:bottom and
 * admin:writePage:bottom hooks: the toolbar button, its mode menu, and the
 * inline script that streams a Scribe response into the current editor.
 *
 * The markup and script live in this module so the plugin entry point stays
 * readable while the injected asset keeps its single source of truth.
 */
import { safeJsonForScript } from 'typecho/plugin-sdk';
import type { I18n } from 'typecho/plugin-sdk';
import { PLUGIN_ID, translate, type ContentType } from './shared';

export function editorHtml(contentType: ContentType, i18n?: I18n): string {
  const t = (key: string, fallback: string, variables?: Record<string, string | number>) =>
    translate(i18n, key, fallback, variables);
  const messages = safeJsonForScript({
    aiGenerating: t('plugin.typecho-plugin-scribe.message.aiGenerating', 'AI 正在生成…'),
    aiFailed: t('plugin.typecho-plugin-scribe.message.aiFailed', 'AI 写作失败。'),
    aiLabel: t('plugin.typecho-plugin-scribe.message.aiLabel', 'AI 写作'),
    close: translate(i18n, 'admin.action.closeNotice', 'Close notice'),
    labels: {
      generate: t('plugin.typecho-plugin-scribe.message.generate', '生成'),
      polish: t('plugin.typecho-plugin-scribe.message.polish', '润色'),
      correct: t('plugin.typecho-plugin-scribe.message.correct', '纠错'),
    },
    titles: {
      generate: t('plugin.typecho-plugin-scribe.message.generateTitle', 'AI 生成'),
      polish: t('plugin.typecho-plugin-scribe.message.polishTitle', 'AI 润色'),
      correct: t('plugin.typecho-plugin-scribe.message.correctTitle', 'AI 纠错'),
    },
    busy: t('plugin.typecho-plugin-scribe.message.busy', 'AI {label} in progress…', { label: '{label}' }),
    complete: t('plugin.typecho-plugin-scribe.message.complete', 'AI {label}完成', { label: '{label}' }),
    bodyRequired: t('plugin.typecho-plugin-scribe.message.bodyRequired', '请先输入正文，再使用 AI {label}', { label: '{label}' }),
    noContent: t('plugin.typecho-plugin-scribe.message.noContent', 'AI 未返回内容。'),
    csrfMissing: t('plugin.typecho-plugin-scribe.message.csrfMissing', '缺少 CSRF token，无法继续。'),
  });
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
    <span class="typecho-scribe-loader-text">${t('plugin.typecho-plugin-scribe.message.aiGenerating', 'AI 正在生成…')}</span>
  </div>
</div>
<script is:inline>
(function() {
  var messages = ${messages};
  if (window.__typechoScribeReady) return;
  window.__typechoScribeReady = true;

  function clearAdminNotice() {
    var notice = document.querySelector('.typecho-scribe-notice');
    if (notice && notice.parentNode) {
      notice.parentNode.removeChild(notice);
    }
  }

  function localizedMessage(message) {
    var value = String(message || '');
    if (!value) return messages.aiFailed;
    if (value === 'AI 写作失败') return messages.aiFailed;
    if (value === 'AI 未返回内容') return messages.noContent;
    var bodyPrefix = '请先输入正文，再使用 AI ';
    if (value.indexOf(bodyPrefix) === 0) {
      return messages.bodyRequired.replace('{label}', value.slice(bodyPrefix.length));
    }
    if (value === '缺少 CSRF token，无法继续') return messages.csrfMissing;
    return value;
  }

  function showAdminNotice(message, type) {
    clearAdminNotice();

    var notice = document.createElement('div');
    var isError = type === 'error';
    notice.className = 'typecho-scribe-notice typecho-option-tabs notice typecho-dismissible admin-notice ' + (isError ? 'notice-error admin-notice--error' : 'notice-success admin-notice--success');
    notice.setAttribute('role', isError ? 'alert' : 'status');

    var paragraph = document.createElement('p');
    paragraph.textContent = localizedMessage(message);
    notice.appendChild(paragraph);

    var closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'typecho-notice-close';
    closeButton.setAttribute('aria-label', messages.close || '关闭提示');
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
  var MODE_LABELS = messages.labels;
  var MODE_TITLES = messages.titles;

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
      overlayText.textContent = busy ? messages.busy.replace('{label}', label) : messages.aiGenerating;
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
    return extractActionErrorFromText(text) || response.statusText || messages.aiFailed;
  }

  async function readStreamIntoEditor(response, text, oldText, mode) {
    if (!response.body || !window.TextDecoder) {
      var data = await response.json().catch(function() { return {}; });
      if (!response.ok || !data.success) throw new Error(extractActionError(data) || messages.aiFailed);
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
      throw new Error(messages.noContent);
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
        showAdminNotice(messages.bodyRequired.replace('{label}', modeLabel(requestedMode)), 'error');
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
      showAdminNotice(messages.complete.replace('{label}', label), 'success');
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
    item.title = messages.aiLabel;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', messages.aiLabel);
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
    button.title = messages.aiLabel;
    button.setAttribute('aria-label', messages.aiLabel);
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
