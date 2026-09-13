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
    status: {
      task: t('plugin.typecho-plugin-scribe.message.statusTask', '任务'),
      phase: t('plugin.typecho-plugin-scribe.message.statusPhase', '阶段'),
      activity: t('plugin.typecho-plugin-scribe.message.statusActivity', '当前交互'),
      input: t('plugin.typecho-plugin-scribe.message.statusInput', '上行 Token'),
      output: t('plugin.typecho-plugin-scribe.message.statusOutput', '下行 Token'),
      total: t('plugin.typecho-plugin-scribe.message.statusTotal', '总用量'),
      inputRate: t('plugin.typecho-plugin-scribe.message.statusInputRate', '上行速率'),
      outputRate: t('plugin.typecho-plugin-scribe.message.statusOutputRate', '下行速率'),
      elapsed: t('plugin.typecho-plugin-scribe.message.statusElapsed', '耗时'),
      tokenPerSecond: t('plugin.typecho-plugin-scribe.message.statusTokenPerSecond', 'token/s'),
      estimated: t('plugin.typecho-plugin-scribe.message.statusEstimated', '估算'),
      unavailable: t('plugin.typecho-plugin-scribe.message.statusUnavailable', '—'),
      phases: {
        queued: t('plugin.typecho-plugin-scribe.message.statusPhaseQueued', '准备中'),
        requesting: t('plugin.typecho-plugin-scribe.message.statusPhaseRequesting', '请求中'),
        streaming: t('plugin.typecho-plugin-scribe.message.statusPhaseStreaming', '生成中'),
        completed: t('plugin.typecho-plugin-scribe.message.statusPhaseCompleted', '已完成'),
        failed: t('plugin.typecho-plugin-scribe.message.statusPhaseFailed', '失败'),
        cancelled: t('plugin.typecho-plugin-scribe.message.statusPhaseCancelled', '已取消'),
      },
      activities: {
        preparing: t('plugin.typecho-plugin-scribe.message.statusActivityPreparing', '正在整理标题、正文、风格样本和写作要求'),
        requesting: t('plugin.typecho-plugin-scribe.message.statusActivityRequesting', '正在向 LLM 请求并等待响应'),
        streaming: t('plugin.typecho-plugin-scribe.message.statusActivityStreaming', '正在接收生成内容'),
        finalizing: t('plugin.typecho-plugin-scribe.message.statusActivityFinalizing', '正在整理结果'),
      },
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

.typecho-scribe-status {
  display: none;
  margin: 10px 0;
  padding: 10px 12px;
  border: 1px solid #d9e2e7;
  border-radius: 4px;
  background: #f7fafb;
  color: #46545c;
  font-size: 12px;
  line-height: 1.5;
}
.typecho-scribe-status[aria-hidden="false"] {
  display: block;
}
.typecho-scribe-status-head,
.typecho-scribe-status-row,
.typecho-scribe-status-metrics {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.typecho-scribe-status-head {
  justify-content: space-between;
  margin-bottom: 3px;
}
.typecho-scribe-status-task {
  color: #2f5368;
  font-weight: 700;
}
.typecho-scribe-status-phase {
  color: #64747c;
}
.typecho-scribe-status-activity {
  color: #64747c;
  min-height: 1.5em;
}
.typecho-scribe-status-metrics {
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-top: 6px;
}
.typecho-scribe-status-metric {
  white-space: nowrap;
}
.typecho-scribe-status-metric-label {
  color: #7a878d;
}
.typecho-scribe-status-metric-value {
  color: #344b57;
  font-variant-numeric: tabular-nums;
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
<div class="typecho-scribe-status" role="status" aria-live="polite" aria-hidden="true">
  <div class="typecho-scribe-status-head">
    <span class="typecho-scribe-status-task"></span>
    <span class="typecho-scribe-status-phase"></span>
  </div>
  <div class="typecho-scribe-status-row">
    <span class="typecho-scribe-status-activity"></span>
  </div>
  <div class="typecho-scribe-status-metrics">
    <span class="typecho-scribe-status-metric"><span class="typecho-scribe-status-metric-label">${t('plugin.typecho-plugin-scribe.message.statusInput', '上行 Token')}：</span><span class="typecho-scribe-status-metric-value" data-scribe-metric="input">${t('plugin.typecho-plugin-scribe.message.statusUnavailable', '—')}</span></span>
    <span class="typecho-scribe-status-metric"><span class="typecho-scribe-status-metric-label">${t('plugin.typecho-plugin-scribe.message.statusOutput', '下行 Token')}：</span><span class="typecho-scribe-status-metric-value" data-scribe-metric="output">${t('plugin.typecho-plugin-scribe.message.statusUnavailable', '—')}</span></span>
    <span class="typecho-scribe-status-metric"><span class="typecho-scribe-status-metric-label">${t('plugin.typecho-plugin-scribe.message.statusTotal', '总用量')}：</span><span class="typecho-scribe-status-metric-value" data-scribe-metric="total">${t('plugin.typecho-plugin-scribe.message.statusUnavailable', '—')}</span></span>
    <span class="typecho-scribe-status-metric"><span class="typecho-scribe-status-metric-label">${t('plugin.typecho-plugin-scribe.message.statusInputRate', '上行速率')}：</span><span class="typecho-scribe-status-metric-value" data-scribe-metric="inputRate">${t('plugin.typecho-plugin-scribe.message.statusUnavailable', '—')}</span></span>
    <span class="typecho-scribe-status-metric"><span class="typecho-scribe-status-metric-label">${t('plugin.typecho-plugin-scribe.message.statusOutputRate', '下行速率')}：</span><span class="typecho-scribe-status-metric-value" data-scribe-metric="outputRate">${t('plugin.typecho-plugin-scribe.message.statusUnavailable', '—')}</span></span>
    <span class="typecho-scribe-status-metric"><span class="typecho-scribe-status-metric-label">${t('plugin.typecho-plugin-scribe.message.statusElapsed', '耗时')}：</span><span class="typecho-scribe-status-metric-value" data-scribe-metric="elapsed">${t('plugin.typecho-plugin-scribe.message.statusUnavailable', '—')}</span></span>
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

  var statusState = {
    mode: 'generate',
    phase: 'queued',
    activity: 'preparing',
    usage: {},
    inputTokensPerSecond: null,
    outputTokensPerSecond: null,
    elapsedMs: null
  };
  var STATUS_PHASES = ['queued', 'requesting', 'streaming', 'completed', 'failed', 'cancelled'];
  var STATUS_ACTIVITIES = ['preparing', 'requesting', 'streaming', 'finalizing'];

  function statusElement() {
    return document.querySelector('.typecho-scribe-status');
  }

  function safeStatusInteger(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0 && Math.floor(value) === value ? value : null;
  }

  function safeStatusNumber(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0 ? value : null;
  }

  function statusUsage(value) {
    if (!value || typeof value !== 'object') return {};
    var result = {};
    ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningOutputTokens'].forEach(function(key) {
      var number = safeStatusInteger(value[key]);
      if (number !== null) result[key] = number;
    });
    if (value.inputTokensEstimated === true) result.inputTokensEstimated = true;
    if (value.outputTokensEstimated === true) result.outputTokensEstimated = true;
    return result;
  }

  function statusActivityForPhase(phase) {
    if (phase === 'requesting') return 'requesting';
    if (phase === 'streaming') return 'streaming';
    if (phase === 'completed' || phase === 'failed' || phase === 'cancelled') return 'finalizing';
    return 'preparing';
  }

  function validStatusMode(mode) {
    return mode === 'generate' || mode === 'polish' || mode === 'correct';
  }

  function formatStatusNumber(value) {
    return String(Math.round(value * 100) / 100).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  }

  function formatTokenMetric(value, estimated) {
    if (value === null) return messages.status.unavailable;
    return (estimated ? '~' : '') + formatStatusNumber(value) + (estimated ? ' (' + messages.status.estimated + ')' : '');
  }

  function formatRateMetric(value, estimated) {
    if (value === null) return messages.status.unavailable;
    return (estimated ? '~' : '') + formatStatusNumber(value) + ' ' + messages.status.tokenPerSecond;
  }

  function formatElapsedMetric(value) {
    if (value === null) return messages.status.unavailable;
    if (value < 1000) return Math.max(0, Math.round(value)) + ' ms';
    return formatStatusNumber(value / 1000) + ' s';
  }

  function setStatusMetric(root, name, value) {
    var element = root.querySelector('[data-scribe-metric="' + name + '"]');
    if (element) element.textContent = value;
  }

  function renderScribeStatus() {
    var root = statusElement();
    if (!root) return;
    var mode = validStatusMode(statusState.mode) ? statusState.mode : 'generate';
    var phase = STATUS_PHASES.indexOf(statusState.phase) >= 0 ? statusState.phase : 'queued';
    var activity = STATUS_ACTIVITIES.indexOf(statusState.activity) >= 0 ? statusState.activity : statusActivityForPhase(phase);
    var usage = statusUsage(statusState.usage);
    var input = usage.inputTokens === undefined ? null : usage.inputTokens;
    var output = usage.outputTokens === undefined ? null : usage.outputTokens;
    var total = usage.totalTokens === undefined && input !== null && output !== null ? input + output : (usage.totalTokens === undefined ? null : usage.totalTokens);
    root.setAttribute('aria-hidden', 'false');
    var task = root.querySelector('.typecho-scribe-status-task');
    var phaseElement = root.querySelector('.typecho-scribe-status-phase');
    var activityElement = root.querySelector('.typecho-scribe-status-activity');
    if (task) task.textContent = messages.status.task + '：' + (MODE_TITLES[mode] || MODE_TITLES.generate);
    if (phaseElement) phaseElement.textContent = messages.status.phase + '：' + (messages.status.phases[phase] || messages.status.phases.queued);
    if (activityElement) activityElement.textContent = messages.status.activity + '：' + (messages.status.activities[activity] || messages.status.activities.preparing);
    setStatusMetric(root, 'input', formatTokenMetric(input, usage.inputTokensEstimated === true));
    setStatusMetric(root, 'output', formatTokenMetric(output, usage.outputTokensEstimated === true));
    setStatusMetric(root, 'total', formatTokenMetric(total, usage.inputTokensEstimated === true || usage.outputTokensEstimated === true));
    setStatusMetric(root, 'inputRate', formatRateMetric(safeStatusNumber(statusState.inputTokensPerSecond), usage.inputTokensEstimated === true));
    setStatusMetric(root, 'outputRate', formatRateMetric(safeStatusNumber(statusState.outputTokensPerSecond), usage.outputTokensEstimated === true));
    setStatusMetric(root, 'elapsed', formatElapsedMetric(safeStatusNumber(statusState.elapsedMs)));
  }

  function resetScribeStatus(mode) {
    statusState = {
      mode: validStatusMode(mode) ? mode : 'generate',
      phase: 'queued',
      activity: 'preparing',
      usage: {},
      inputTokensPerSecond: null,
      outputTokensPerSecond: null,
      elapsedMs: 0
    };
    renderScribeStatus();
  }

  function updateScribeStatus(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (validStatusMode(payload.mode)) statusState.mode = payload.mode;
    if (STATUS_PHASES.indexOf(payload.phase) >= 0) statusState.phase = payload.phase;
    if (STATUS_ACTIVITIES.indexOf(payload.activity) >= 0) statusState.activity = payload.activity;
    else if (STATUS_PHASES.indexOf(payload.phase) >= 0) statusState.activity = statusActivityForPhase(payload.phase);
    if (payload.usage && typeof payload.usage === 'object') statusState.usage = statusUsage(payload.usage);
    var inputRate = safeStatusNumber(payload.inputTokensPerSecond);
    var outputRate = safeStatusNumber(payload.outputTokensPerSecond);
    var elapsed = safeStatusNumber(payload.elapsedMs);
    if (inputRate !== null) statusState.inputTokensPerSecond = inputRate;
    if (outputRate !== null) statusState.outputTokensPerSecond = outputRate;
    if (elapsed !== null) statusState.elapsedMs = elapsed;
    renderScribeStatus();
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

  function parseScribeEventBlock(block) {
    var eventName = 'message';
    var dataLines = [];
    String(block || '').split('\\n').forEach(function(line) {
      if (line.indexOf('event:') === 0) {
        eventName = line.slice(6).trim();
      } else if (line.indexOf('data:') === 0) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    });
    if (dataLines.length === 0) return null;
    try {
      return { name: eventName, data: JSON.parse(dataLines.join('\\n')) };
    } catch (error) {
      return { name: 'error', data: { message: messages.aiFailed } };
    }
  }

  function consumeScribeEvents(buffer, onEvent) {
    var normalized = String(buffer || '').replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
    var separator;
    while ((separator = normalized.indexOf('\\n\\n')) >= 0) {
      var block = normalized.slice(0, separator);
      normalized = normalized.slice(separator + 2);
      var event = parseScribeEventBlock(block);
      if (event) onEvent(event);
    }
    return normalized;
  }

  async function readScribeEventStream(response, text, oldText, mode) {
    if (!response.body) throw new Error(messages.aiFailed);
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var nextText = '';
    var streamError = '';
    var seenDone = false;
    var handleEvent = function(event) {
      if (!event) return;
      var data = event.data;
      if (event.name === 'task') {
        updateScribeStatus(data);
      } else if (event.name === 'text') {
        if (data && typeof data.delta === 'string') {
          nextText += data.delta;
          text.value = nextText;
        }
      } else if (event.name === 'progress') {
        updateScribeStatus(data);
      } else if (event.name === 'error') {
        streamError = extractActionError(data) || messages.aiFailed;
        updateScribeStatus({ phase: 'failed', activity: 'finalizing' });
      } else if (event.name === 'done') {
        seenDone = true;
        updateScribeStatus(data);
      }
    };

    for (;;) {
      var result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      buffer = consumeScribeEvents(buffer, handleEvent);
    }
    buffer += decoder.decode();
    buffer = consumeScribeEvents(buffer, handleEvent);
    if (buffer.trim()) {
      var finalEvent = parseScribeEventBlock(buffer);
      if (finalEvent) handleEvent(finalEvent);
    }

    if (streamError) throw new Error(streamError);
    if (!seenDone) throw new Error(messages.aiFailed);
    if (!nextText.trim()) {
      text.value = oldText;
      throw new Error(messages.noContent);
    }
    text.value = mergeAiCompletion(oldText, nextText, mode);
    if (!text.value) {
      text.value = oldText;
      throw new Error(messages.noContent);
    }
  }

  async function readStreamIntoEditor(response, text, oldText, mode) {
    var contentType = response.headers && response.headers.get ? String(response.headers.get('Content-Type') || '').toLowerCase() : '';
    if (!response.ok) {
      throw new Error(await readActionError(response));
    }
    if (contentType.indexOf('text/event-stream') >= 0) {
      await readScribeEventStream(response, text, oldText, mode);
      return;
    }
    if (!response.body || !window.TextDecoder) {
      var data = await response.json().catch(function() { return {}; });
      if (!response.ok || !data.success) throw new Error(extractActionError(data) || messages.aiFailed);
      text.value = mergeAiCompletion(oldText, data.content || '', mode);
      updateScribeStatus({ phase: 'completed', activity: 'finalizing', elapsedMs: statusState.elapsedMs || 0 });
      return;
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
    updateScribeStatus({ phase: 'completed', activity: 'finalizing', elapsedMs: statusState.elapsedMs || 0 });
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

    resetScribeStatus(mode);
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
      updateScribeStatus({ phase: 'failed', activity: 'finalizing' });
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
