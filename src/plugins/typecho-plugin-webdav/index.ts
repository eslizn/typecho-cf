import { hasPermission, registerPluginAdminPath, registerPluginRoute, safeJsonForScript } from 'typecho/plugin-sdk';
import type { I18n, PluginInitContext, PluginRouteResult } from 'typecho/plugin-sdk';
import type { Database } from 'typecho/db';
import { validateAuthToken, getAuthCookies, requireAdminCSRF } from '@/lib/auth';
import { isSameOriginRequest } from '@/lib/admin-auth';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';
import { InputError, inputErrorMessage, readBoundedFormData, readBoundedJson } from '@/lib/input';
import { resolveI18nMessage } from '@/lib/i18n';

import { PLUGIN_ID } from './types';
import type { WebDavConfig, WebDavStorageAdapter } from './types';
import {
  readPluginSettings, normalizeConfig, normalizeInteger, parseBoolean,
  matchConfiguredWebDavRoute,
} from './config';
import { handleWebDavRequest, createStorageAdapter } from './protocol';
import { clearTianyiSessionCache } from './adapters';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

// Re-export public API
export type { StorageProvider, WebDavConfig, StorageMount, WebDavStorageAdapter } from './types';
export { PLUGIN_ID } from './types';
export {
  readObject, readPluginSettings, normalizeRoutePath, parseMounts,
  resolveWebDavTarget, normalizeConfig, getWebDavClientIp, isWebDavClientBanned,
  recordWebDavAuthFailure, clearWebDavAuthFailures, matchWebDavRoute,
  parseBasicCredentials, hasExplicitSessionCookie,
} from './config';
export { createStorageAdapter } from './protocol';
export { clearTianyiSessionCache, tianyiEnsureSession, tianyiListFiles } from './adapters';

// ── Admin Panel (in-plugin) ──

const ADMIN_API_ROUTE = '/api/admin/webdav';

function translate(i18n: I18n | undefined, key: string, fallback: string, variables?: Record<string, string | number>): string {
  return i18n?.t(key, variables, fallback) ?? fallback;
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

interface AdminAuthResult {
  uid: number;
  user: Record<string, unknown>;
  options: Record<string, unknown>;
  db: Database;
}

async function authenticateAdmin(request: Request, db: Database, options: Record<string, unknown>): Promise<AdminAuthResult | Response> {
  const { token } = getAuthCookies(request.headers.get('cookie'));
  if (!token || !options.secret) {
    return new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const auth = await validateAuthToken(token, String(options.secret), db);
  if (!auth) {
    return new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (!hasPermission(auth.user.group || 'visitor', 'administrator')) {
    return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  return {
    uid: auth.uid,
    user: auth.user as unknown as Record<string, unknown>,
    options,
    db,
  };
}

async function handleAdminApiRequest(request: Request, config: WebDavConfig, workerEnv?: Record<string, unknown>, i18n?: I18n): Promise<Response> {
  const url = new URL(request.url);
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const adapter = createStorageAdapter(config);

  if (request.method === 'GET') {
    const action = url.searchParams.get('action') || 'list';
    const rawPath = url.searchParams.get('path') || '';

    if (action === 'list') {
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
      const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get('pageSize') || '', 10) || config.fileListPageSize));
      const offset = (page - 1) * pageSize;

      if (!rawPath && !config.mounts.some(mount => mount.mount === '')) {
        const mountPrefixes = config.mounts.map(mount => `${mount.mount}/`);
        const total = mountPrefixes.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        return new Response(JSON.stringify({
          success: true,
          data: {
            path: '/', objects: [],
            prefixes: mountPrefixes.slice(offset, offset + pageSize),
            page, pageSize, total, totalPages,
          },
        }), { headers: jsonHeaders });
      }

      const isTianyi = config.mounts.some(m => m.provider === 'tianyi' && (m.mount === '' || rawPath.startsWith(m.mount)));
      const result = await adapter.list(rawPath, workerEnv, isTianyi ? pageSize : 0, isTianyi ? offset : 0);
      const prefixes = [...result.prefixes];
      const objects: typeof result.objects = [];
      for (const o of result.objects) {
        if (o.key.endsWith('/')) {
          const name = o.key.replace(/\/+$/, '');
          if (!prefixes.includes(name + '/')) prefixes.push(name + '/');
        } else {
          objects.push(o);
        }
      }
      prefixes.sort();
      objects.sort((a, b) => a.key.localeCompare(b.key));
      const total = result.total ?? (prefixes.length + objects.length);
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      let pagedPrefixes: string[];
      let pagedObjects: typeof objects;
      if (isTianyi) {
        pagedPrefixes = prefixes;
        pagedObjects = objects;
      } else {
        const all = [
          ...prefixes.map(p => ({ type: 'folder' as const, name: p })),
          ...objects.map(o => ({ type: 'file' as const, name: o.key, obj: o })),
        ];
        const sliced = all.slice(offset, offset + pageSize);
        pagedPrefixes = [];
        pagedObjects = [];
        for (const item of sliced) {
          if (item.type === 'folder') pagedPrefixes.push(item.name);
          else pagedObjects.push(item.obj);
        }
      }
      return new Response(JSON.stringify({
        success: true,
        data: { path: rawPath || '/', objects: pagedObjects, prefixes: pagedPrefixes, page, pageSize, total, totalPages },
      }), { headers: jsonHeaders });
    }
    if (action === 'download') {
      return adapter.read(rawPath, workerEnv);
    }
    return jsonResponse({ error: translate(i18n, 'plugin.typecho-plugin-webdav.api.unknownAction', 'Unknown action') }, 400, jsonHeaders);
  }

  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      let formData: FormData;
      try {
        formData = await readBoundedFormData(request, REQUEST_BODY_LIMITS.uploadEnvelope);
      } catch (error) {
        if (error instanceof InputError) {
          return new Response(JSON.stringify({ error: resolveI18nMessage(inputErrorMessage(error), i18n) }), {
            status: error.status,
            headers: jsonHeaders,
          });
        }
        throw error;
      }
      const action = String(formData.get('action') || 'upload');
      const dirPath = String(formData.get('path') || '');
      const file = formData.get('file') as File | null;

      if (action === 'upload') {
        if (!file) return jsonResponse({ error: translate(i18n, 'plugin.typecho-plugin-webdav.api.fileRequired', 'Please select a file.') }, 400, jsonHeaders);
        const filePath = dirPath ? `${dirPath.replace(/\/+$/, '')}/${file.name}` : file.name;
        await adapter.write(filePath, file.stream(), file.type || 'application/octet-stream', workerEnv);
        return jsonResponse({ success: true, message: translate(i18n, 'plugin.typecho-plugin-webdav.ui.uploadSuccess', 'Uploaded successfully.') }, 200, jsonHeaders);
      }
      return jsonResponse({ error: translate(i18n, 'plugin.typecho-plugin-webdav.api.unknownAction', 'Unknown action') }, 400, jsonHeaders);
    }

    let body: { action?: string; path?: string; newPath?: string; paths?: string[] };
    try {
      body = await readBoundedJson(request, REQUEST_BODY_LIMITS.adminForm) as typeof body;
    } catch (error) {
      if (error instanceof InputError) {
        return new Response(JSON.stringify({ error: resolveI18nMessage(inputErrorMessage(error), i18n) }), {
          status: error.status,
          headers: jsonHeaders,
        });
      }
      throw error;
    }
    const action = body.action || '';
    const targetPath = body.path || '';

    if (action === 'mkdir') {
      if (!targetPath) return jsonResponse({ error: translate(i18n, 'plugin.typecho-plugin-webdav.api.folderRequired', 'Please enter a folder name.') }, 400, jsonHeaders);
      await adapter.mkdir(targetPath.endsWith('/') ? targetPath : `${targetPath}/`, workerEnv);
      return jsonResponse({ success: true, message: translate(i18n, 'plugin.typecho-plugin-webdav.ui.folderCreated', 'Folder created successfully.') }, 200, jsonHeaders);
    }
    if (action === 'delete') {
      const raw = body.paths || (targetPath ? [targetPath] : []);
      const paths = Array.isArray(raw) ? raw : [String(raw)];
      if (!paths.length) return jsonResponse({ error: translate(i18n, 'plugin.typecho-plugin-webdav.api.pathsRequired', 'Select files or folders to delete.') }, 400, jsonHeaders);
      for (const p of paths) await adapter.delete(String(p), workerEnv);
      return jsonResponse({ success: true, message: translate(i18n, 'plugin.typecho-plugin-webdav.ui.deleteSuccess', 'Deleted successfully.') }, 200, jsonHeaders);
    }
    if (action === 'rename') {
      const newPath = body.newPath || '';
      if (!targetPath || !newPath) return jsonResponse({ error: translate(i18n, 'plugin.typecho-plugin-webdav.api.paramsRequired', 'Required parameters are missing.') }, 400, jsonHeaders);
      if (targetPath === newPath) return jsonResponse({ error: translate(i18n, 'plugin.typecho-plugin-webdav.api.sameName', 'The new name is the same as the old name.') }, 400, jsonHeaders);
      const readResp = await adapter.read(targetPath, workerEnv);
      if (!readResp.ok) return jsonResponse({ error: translate(i18n, 'plugin.typecho-plugin-webdav.api.sourceReadFailed', 'Could not read the source file.') }, 502, jsonHeaders);
      if (!readResp.body) return jsonResponse({ error: translate(i18n, 'plugin.typecho-plugin-webdav.api.sourceReadFailed', 'Could not read the source file.') }, 500, jsonHeaders);
      const ct = readResp.headers.get('content-type') || 'application/octet-stream';
      await adapter.write(newPath, readResp.body, ct, workerEnv);
      await adapter.delete(targetPath, workerEnv);
      return jsonResponse({ success: true, message: translate(i18n, 'plugin.typecho-plugin-webdav.ui.renamed', 'Renamed successfully.') }, 200, jsonHeaders);
    }
    return jsonResponse({ error: `${translate(i18n, 'plugin.typecho-plugin-webdav.api.unknownAction', 'Unknown action')}: ${action}` }, 400, jsonHeaders);
  }

  return jsonResponse({ error: 'Method not allowed' }, 405, jsonHeaders);
}

// --- Admin page HTML template ---

function adminPageHtml(csrf: string, pageSize: number, i18n?: I18n): string {
  const t = (key: string, fallback: string, variables?: Record<string, string | number>) =>
    translate(i18n, key, fallback, variables);
  const messages = safeJsonForScript({
    serverError: t('plugin.typecho-plugin-webdav.ui.serverError', 'Server error ({status})', { status: '{status}' }),
    loadingFailed: t('plugin.typecho-plugin-webdav.ui.loadingFailed', 'Loading failed: {reason}', { reason: '{reason}' }),
    loading: t('plugin.typecho-plugin-webdav.ui.loading', 'Loading…'),
    empty: t('plugin.typecho-plugin-webdav.ui.empty', 'This directory is empty.'),
    rename: t('plugin.typecho-plugin-webdav.ui.rename', 'Rename'),
    delete: t('plugin.typecho-plugin-webdav.ui.delete', 'Delete'),
    previous: t('plugin.typecho-plugin-webdav.ui.previous', 'Previous'),
    next: t('plugin.typecho-plugin-webdav.ui.next', 'Next'),
    rootDeleteForbidden: t('plugin.typecho-plugin-webdav.ui.rootDeleteForbidden', 'The mount root cannot be deleted.'),
    deleteConfirm: t('plugin.typecho-plugin-webdav.ui.deleteConfirm', 'Delete {path}? This cannot be undone.'),
    chooseDelete: t('plugin.typecho-plugin-webdav.ui.chooseDelete', 'Select files or folders to delete first.'),
    deleteSuccess: t('plugin.typecho-plugin-webdav.ui.deleteSuccess', 'Deleted successfully.'),
    deleteFailed: t('plugin.typecho-plugin-webdav.ui.deleteFailed', 'Delete failed: {reason}'),
    selectDelete: t('plugin.typecho-plugin-webdav.ui.chooseDelete', 'Select files or folders to delete first.'),
    uploadSuccess: t('plugin.typecho-plugin-webdav.ui.uploadSuccess', 'Uploaded successfully.'),
    uploadFailed: t('plugin.typecho-plugin-webdav.ui.uploadFailed', 'Upload failed: {reason}'),
    folderNameRequired: t('plugin.typecho-plugin-webdav.ui.folderNameRequired', 'Enter a folder name.'),
    folderCreated: t('plugin.typecho-plugin-webdav.ui.folderCreated', 'Folder created successfully.'),
    createFailed: t('plugin.typecho-plugin-webdav.ui.createFailed', 'Create failed: {reason}'),
    renameRequired: t('plugin.typecho-plugin-webdav.ui.renameRequired', 'Enter a new name.'),
    renamed: t('plugin.typecho-plugin-webdav.ui.renamed', 'Renamed successfully.'),
    renameFailed: t('plugin.typecho-plugin-webdav.ui.renameFailed', 'Rename failed: {reason}'),
    directoryCreateFailed: t('plugin.typecho-plugin-webdav.ui.directoryCreateFailed', 'Could not create directory {path}: {reason}'),
    selectedDeleteConfirm: t('plugin.typecho-plugin-webdav.ui.selectedDeleteConfirm', 'Delete the selected {count} items? This cannot be undone.', { count: '{count}' }),
    pageSummary: t('plugin.typecho-plugin-webdav.ui.pageSummary', 'Page {page}/{pages}, {count} items', { page: '{page}', pages: '{pages}', count: '{count}' }),
    sourceMap: {
      '加载中...': t('plugin.typecho-plugin-webdav.ui.loading', 'Loading…'),
      '加载失败：': t('plugin.typecho-plugin-webdav.ui.loadingFailed', 'Loading failed: {reason}', { reason: '{reason}' }),
      '此目录为空': t('plugin.typecho-plugin-webdav.ui.empty', 'This directory is empty.'),
      '重命名': t('plugin.typecho-plugin-webdav.ui.rename', 'Rename'),
      '删除': t('plugin.typecho-plugin-webdav.ui.delete', 'Delete'),
      '上一页': t('plugin.typecho-plugin-webdav.ui.previous', 'Previous'),
      '下一页': t('plugin.typecho-plugin-webdav.ui.next', 'Next'),
      '挂载根目录不允许删除': t('plugin.typecho-plugin-webdav.ui.rootDeleteForbidden', 'The mount root cannot be deleted.'),
      '挂载根目录不允许删除，已跳过': t('plugin.typecho-plugin-webdav.ui.rootDeleteSkipped', 'The mount root cannot be deleted and was skipped.'),
      '请先选择要删除的项目': t('plugin.typecho-plugin-webdav.ui.chooseDelete', 'Select files or folders to delete first.'),
      '删除成功': t('plugin.typecho-plugin-webdav.ui.deleteSuccess', 'Deleted successfully.'),
      '上传完成': t('plugin.typecho-plugin-webdav.ui.uploadSuccess', 'Uploaded successfully.'),
      '请输入文件夹名称': t('plugin.typecho-plugin-webdav.ui.folderNameRequired', 'Enter a folder name.'),
      '文件夹创建成功': t('plugin.typecho-plugin-webdav.ui.folderCreated', 'Folder created successfully.'),
      '请输入新名称': t('plugin.typecho-plugin-webdav.ui.renameRequired', 'Enter a new name.'),
      '重命名成功': t('plugin.typecho-plugin-webdav.ui.renamed', 'Renamed successfully.'),
      '请选择文件': t('plugin.typecho-plugin-webdav.api.fileRequired', 'Please select a file.'),
      '创建目录失败': t('plugin.typecho-plugin-webdav.ui.createFailed', 'Create failed: {reason}', { reason: '{reason}' }),
    },
  });
  return `<div class="col-mb-12 typecho-list" id="webdav-app">
  <div id="webdav-notice" class="webdav-notice admin-notice typecho-dismissible"></div>
  <div class="typecho-list-operate clearfix">
    <div class="operate">
      <label><i class="sr-only">${t('plugin.typecho-plugin-webdav.ui.selectAll', 'Select all')}</i><input type="checkbox" class="typecho-table-select-all"></label>
      <div class="btn-group btn-drop">
        <button class="btn dropdown-toggle btn-s" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="webdav-actions">${t('plugin.typecho-plugin-webdav.ui.selectedItems', 'Selected items')} <i class="i-caret-down"></i></button>
        <ul class="dropdown-menu" id="webdav-actions" role="menu"><li><a href="#" id="btn-delete-selected">${t('plugin.typecho-plugin-webdav.ui.delete', 'Delete')}</a></li></ul>
      </div>
      <button class="btn primary btn-s" id="btn-upload">${t('plugin.typecho-plugin-webdav.ui.uploadFile', 'Upload files')}</button>
      <button class="btn btn-s" id="btn-new-folder">${t('plugin.typecho-plugin-webdav.ui.newFolder', 'New folder')}</button>
    </div>
  </div>
  <div class="webdav-breadcrumb">
    <a href="#" data-path="" class="breadcrumb-link">${t('plugin.typecho-plugin-webdav.ui.root', 'Root directory')}</a><span id="breadcrumb-path"></span>
  </div>
  <div class="typecho-table-wrap" id="webdav-table-wrap">
    <table class="typecho-list-table">
      <colgroup><col width="20"><col width=""><col width="12%" class="kit-hidden-mb"><col width="18%" class="kit-hidden-mb"><col width="12%"></colgroup>
      <thead><tr><th><input type="checkbox" class="typecho-table-select-all"></th><th>${t('plugin.typecho-plugin-webdav.ui.name', 'Name')}</th><th>${t('plugin.typecho-plugin-webdav.ui.size', 'Size')}</th><th>${t('plugin.typecho-plugin-webdav.ui.modified', 'Modified')}</th><th>${t('plugin.typecho-plugin-webdav.ui.actions', 'Actions')}</th></tr></thead>
      <tbody id="file-list-body"><tr><td colspan="5"><h6 class="typecho-list-table-title"><span class="loading">${t('plugin.typecho-plugin-webdav.ui.loading', 'Loading…')}</span></h6></td></tr></tbody>
    </table>
  </div>
<div id="upload-modal" class="webdav-modal"><div class="webdav-modal-dialog webdav-modal-dialog--wide"><h3 class="webdav-modal-title">${t('plugin.typecho-plugin-webdav.ui.uploadTitle', 'Upload files')}</h3><p class="webdav-modal-help">${t('plugin.typecho-plugin-webdav.ui.uploadTo', 'Upload to:')} <span id="upload-dir-path">/</span></p><input type="file" id="upload-file-input" class="webdav-modal-input" multiple webkitdirectory=""><progress id="upload-progress" value="0" max="100" class="webdav-progress"></progress><div class="webdav-modal-actions"><button class="btn btn-s" id="btn-upload-cancel">${t('plugin.typecho-plugin-webdav.ui.cancel', 'Cancel')}</button><button class="btn primary btn-s" id="btn-upload-confirm">${t('plugin.typecho-plugin-webdav.ui.uploadFile', 'Upload files')}</button></div></div></div>
  <div id="mkdir-modal" class="webdav-modal"><div class="webdav-modal-dialog"><h3 class="webdav-modal-title">${t('plugin.typecho-plugin-webdav.ui.newFolder', 'New folder')}</h3><p class="webdav-modal-help">${t('plugin.typecho-plugin-webdav.ui.createIn', 'Create under')} <span id="mkdir-dir-path">/</span></p><input type="text" id="mkdir-name-input" class="text w-100 webdav-modal-input" placeholder="${t('plugin.typecho-plugin-webdav.ui.folderName', 'Folder name')}"><div class="webdav-modal-actions"><button class="btn btn-s" id="btn-mkdir-cancel">${t('plugin.typecho-plugin-webdav.ui.cancel', 'Cancel')}</button><button class="btn primary btn-s" id="btn-mkdir-confirm">${t('plugin.typecho-plugin-webdav.ui.create', 'Create')}</button></div></div></div>
  <div id="rename-modal" class="webdav-modal"><div class="webdav-modal-dialog"><h3 class="webdav-modal-title">${t('plugin.typecho-plugin-webdav.ui.rename', 'Rename')}</h3><input type="text" id="rename-input" class="text w-100 webdav-modal-input" placeholder="${t('plugin.typecho-plugin-webdav.ui.newName', 'New name')}"><div class="webdav-modal-actions"><button class="btn btn-s" id="btn-rename-cancel">${t('plugin.typecho-plugin-webdav.ui.cancel', 'Cancel')}</button><button class="btn primary btn-s" id="btn-rename-confirm">${t('plugin.typecho-plugin-webdav.ui.confirm', 'Confirm')}</button></div></div></div>
</div>
<style>
.webdav-notice{display:none}
.webdav-breadcrumb{margin:0 0 1em;padding:8px 12px;border:1px solid #E0E0DC;border-radius:var(--admin-radius);background:var(--admin-surface);font-size:.92857em}
.webdav-breadcrumb a{color:#467B96;text-decoration:none}.webdav-breadcrumb a:hover{text-decoration:underline}
.webdav-breadcrumb span{color:#999}
.file-link{color:#444;text-decoration:none}.file-link:hover{color:#467B96;text-decoration:none}
.folder-icon{color:#E8A838;margin-right:4px}.file-icon{color:#999;margin-right:4px}
.webdav-modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.45);z-index:1000}
.webdav-modal-dialog{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);box-sizing:border-box;width:360px;max-width:90vw;padding:24px;border:1px solid #E0E0DC;border-radius:var(--admin-radius);background:var(--admin-surface)}
.webdav-modal-dialog--wide{width:400px}
.webdav-modal-title{margin:0 0 16px;font-size:1.1em}
.webdav-modal-help{margin:0 0 12px;color:var(--admin-muted);font-size:.92857em}
.webdav-modal-input{width:100%;margin-bottom:12px}
.webdav-progress{display:none;width:100%;margin-bottom:12px}
.webdav-modal-actions{text-align:right}
.webdav-modal-actions .btn + .btn{margin-left:8px}
.rename-link{margin-right:8px}
.webdav-pager-nav{display:flex;justify-content:center;align-items:center;gap:16px;padding:8px 0}
.webdav-pager-disabled{color:#CCC}
.file-icon{margin-right:4px}
.file-icon--image{color:#5A9E5F}.file-icon--video{color:#6A5ACD}.file-icon--audio{color:#D2691E}.file-icon--archive{color:#8B7355}.file-icon--code{color:#467B96}.file-icon--document{color:#C0392B}
#webdav-table-wrap.drag-over-table{outline:3px dashed #467B96;outline-offset:-3px;background:#FFFBCC}
#webdav-table-wrap tr.drag-over-row{background:#D6EAF8!important;outline:2px solid #2980B9;outline-offset:-2px}
</style>
<script>
(function(){
var M=${messages},csrf=${JSON.stringify(csrf)},curPath="",entries=[],renameTarget="",curPage=1,pageSize=${pageSize},totalItems=0,totalPages=1;
function MT(k,v){var s=M[k]||k;v=v||{};Object.keys(v).forEach(function(n){s=s.split("{"+n+"}").join(String(v[n]))});return s}
function L(s){s=String(s);if(M.sourceMap&&M.sourceMap[s])return M.sourceMap[s];if(s.indexOf("加载失败：")===0)return MT("loadingFailed",{reason:s.slice(5)});if(s.indexOf("删除失败：")===0)return MT("deleteFailed",{reason:s.slice(5)});if(s.indexOf("上传 ")===0&&s.indexOf(" 失败：")>0)return MT("uploadFailed",{reason:s.slice(3)});if(s.indexOf("创建失败：")===0)return MT("createFailed",{reason:s.slice(5)});if(s.indexOf("重命名失败：")===0)return MT("renameFailed",{reason:s.slice(6)});if(s.indexOf("创建目录失败：")===0)return MT("directoryCreateFailed",{path:s.slice(7).split(" ")[0]||"",reason:s.slice(7).replace(/^[^ ]+ /,"")});if(s.indexOf("确认删除选中的 ")===0)return MT("selectedDeleteConfirm",{count:s.slice(8).split(" 个项目")[0]||""});if(s.indexOf("确认删除 ")===0)return MT("deleteConfirm",{path:s.slice(5).replace(/ ？此操作不可撤销。$/,"")});var page=s.match(/^第 (\\d+)\\/(\\d+) 页，共 (\\d+) 项$/);if(page)return MT("pageSummary",{page:page[1],pages:page[2],count:page[3]});return s}
var rawNotice=notice;notice=function(msg,type){return rawNotice(L(msg),type)};var rawConfirm=window.confirm.bind(window);window.confirm=function(message){return rawConfirm(L(message))};

var _noticeTimer;function notice(msg,type){clearTimeout(_noticeTimer);var n=document.getElementById("webdav-notice");n.style.display="block";n.className="webdav-notice message admin-notice typecho-dismissible "+(type==="success"?"success admin-notice--success":type==="error"?"error admin-notice--error":"notice admin-notice--warning");n.innerHTML='<p>'+E(msg)+'</p><button type="button" class="typecho-notice-close" aria-label="Close notice">&times;</button>';var b=n.querySelector(".typecho-notice-close");if(b)b.addEventListener("click",function(){n.style.display="none"});_noticeTimer=setTimeout(function(){n.style.display="none"},5000)}

function E(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function BP(p){if(!p)return"";var a=p.split("/").filter(Boolean),h="",c="",i;for(i=0;i<a.length;i++){c+="/"+a[i];h+=' / <a href="#" data-path="'+E(c.charAt(0)==="/" ? c.slice(1) : c)+'" class="breadcrumb-link">'+E(a[i])+"</a>"}return h}
function BS(b){if(!b||b===0)return"-";return b<1024?b+" B":b<1048576?Math.ceil(b/1024)+" KB":(b/1048576).toFixed(1)+" MB"}
function FD(d){if(!d)return"-";try{return new Date(d).toLocaleString()}catch(e){return d}}
function MI(n,f){if(f)return'<span class="folder-icon">&#128193;</span>';var x=n.split(".").pop().toLowerCase();var m={jpg:1,jpeg:1,png:1,gif:1,webp:1,svg:1,bmp:1,ico:1,avif:1,mp4:2,webm:2,avi:2,mov:2,mkv:2,mp3:3,wav:3,flac:3,aac:3,ogg:3,zip:4,rar:4,"7z":4,tar:4,gz:4,bz2:4,js:5,ts:5,jsx:5,tsx:5,py:5,rb:5,go:5,rs:5,java:5,c:5,cpp:5,h:5,css:5,html:5,xml:5,json:5,yaml:5,yml:5,pdf:6};var t=m[x]||0;if(t===1)return'<span class="file-icon file-icon--image">&#128247;</span>';if(t===2)return'<span class="file-icon file-icon--video">&#127910;</span>';if(t===3)return'<span class="file-icon file-icon--audio">&#127925;</span>';if(t===4)return'<span class="file-icon file-icon--archive">&#128230;</span>';if(t===5)return'<span class="file-icon file-icon--code">&#128221;</span>';if(t===6)return'<span class="file-icon file-icon--document">&#128214;</span>';return'<span class="file-icon">&#128196;</span>'}
document.addEventListener("click",function(e){var t=e.target;if(t.classList.contains("pager-link")){e.preventDefault();curPage=parseInt(t.dataset.page)||1;LD(curPath,true)}if(t.classList.contains("breadcrumb-link")){e.preventDefault();LD(t.dataset.path||"")}if(t.closest(".delete-link")){e.preventDefault();var p=t.closest(".delete-link").dataset.path;if(!p||p==="/"){notice("挂载根目录不允许删除","error");return}if(confirm("确认删除 "+p+" ？此操作不可撤销。"))DI([p])}if(t.closest(".rename-link")){e.preventDefault();var l=t.closest(".rename-link");renameTarget=l.dataset.path;var nm=renameTarget.replace(/\\/+$/,"").split("/").pop()||renameTarget;document.getElementById("rename-input").value=nm;document.getElementById("rename-modal").style.display="block";document.getElementById("rename-input").focus();document.getElementById("rename-input").select()}var nav=t.closest("[data-nav]");if(nav){e.preventDefault();LD(nav.dataset.nav)}});
async function DI(paths){try{var r=await fetch("/api/admin/webdav",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({action:"delete",paths:paths})});if(!r.ok){var em="Server error ("+r.status+")";try{var ej=await r.json();if(ej.error)em=ej.error}catch(ex){}throw new Error(em)}var j=await r.json();if(!j.success)throw new Error(j.error);notice("删除成功","success");LD(curPath)}catch(e){notice("删除失败："+e.message,"error")}}
document.getElementById("btn-delete-selected").addEventListener("click",function(e){e.preventDefault();var cbs=document.querySelectorAll("#file-list-body input[type=checkbox]:checked");if(!cbs.length){notice("请先选择要删除的项目","notice");return}var ps=[],hasRoot=false;for(var j=0;j<cbs.length;j++){var v=cbs[j].value;if(!v||v==="/"){hasRoot=true;continue}ps.push(v)}if(hasRoot)notice("挂载根目录不允许删除，已跳过","error");if(!ps.length)return;if(confirm("确认删除选中的 "+ps.length+" 个项目？此操作不可撤销。"))DI(ps)});
document.getElementById("btn-upload").addEventListener("click",function(){document.getElementById("upload-dir-path").textContent=curPath?"/"+curPath+"/":"/";document.getElementById("upload-modal").style.display="block";document.getElementById("upload-file-input").value="";var p=document.getElementById("upload-progress");p.style.display="none";p.value=0});
document.getElementById("btn-upload-cancel").addEventListener("click",function(){document.getElementById("upload-modal").style.display="none"});
document.getElementById("btn-upload-confirm").addEventListener("click",async function(){var fs=document.getElementById("upload-file-input").files;if(!fs||!fs.length){notice("请选择文件","notice");return}var p=document.getElementById("upload-progress");p.style.display="block";p.value=0;var ok=0;for(var i=0;i<fs.length;i++){await uploadFile(fs[i],curPath||"/",function(v){ok+=v;p.value=Math.round(ok/fs.length*100)})}document.getElementById("upload-modal").style.display="none";LD(curPath)});
async function uploadFile(file,dirPath,onProgress){var fd=new FormData();fd.append("action","upload");fd.append("path",dirPath);fd.append("file",file,file.name);try{var r=await fetch("/api/admin/webdav",{method:"POST",headers:{"X-CSRF-Token":csrf},body:fd});if(!r.ok){var em="Server error ("+r.status+")";try{var ej=await r.json();if(ej.error)em=ej.error}catch(ex){}throw new Error(em)}var j=await r.json();if(!j.success)throw new Error(j.error);onProgress&&onProgress(1)}catch(e){notice("上传 "+file.name+" 失败："+e.message,"error");onProgress&&onProgress(0)}finally{}}
document.getElementById("btn-new-folder").addEventListener("click",function(){document.getElementById("mkdir-dir-path").textContent=curPath?"/"+curPath+"/":"/";document.getElementById("mkdir-modal").style.display="block";document.getElementById("mkdir-name-input").value="";document.getElementById("mkdir-name-input").focus()});
document.getElementById("btn-mkdir-cancel").addEventListener("click",function(){document.getElementById("mkdir-modal").style.display="none"});
document.getElementById("btn-mkdir-confirm").addEventListener("click",async function(){var n=document.getElementById("mkdir-name-input").value.trim();if(!n){notice("请输入文件夹名称","notice");return}var p=curPath?curPath+"/"+n:n;try{var r=await fetch("/api/admin/webdav",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({action:"mkdir",path:p})});if(!r.ok){var em="Server error ("+r.status+")";try{var ej=await r.json();if(ej.error)em=ej.error}catch(ex){}throw new Error(em)}var j=await r.json();if(!j.success)throw new Error(j.error);document.getElementById("mkdir-modal").style.display="none";notice("文件夹创建成功","success");LD(curPath)}catch(e){notice("创建失败："+e.message,"error")}});
document.getElementById("btn-rename-cancel").addEventListener("click",function(){document.getElementById("rename-modal").style.display="none"});
document.getElementById("btn-rename-confirm").addEventListener("click",async function(){var nn=document.getElementById("rename-input").value.trim();if(!nn){notice("请输入新名称","notice");return}var ps=renameTarget.replace(/\\/+$/,"").split("/");ps.pop();var pp=ps.join("/");var np=pp?pp+"/"+nn:nn;try{var r=await fetch("/api/admin/webdav",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({action:"rename",path:renameTarget.replace(/\\/+$/,""),newPath:np})});if(!r.ok){var em="Server error ("+r.status+")";try{var ej=await r.json();if(ej.error)em=ej.error}catch(ex){}throw new Error(em)}var j=await r.json();if(!j.success)throw new Error(j.error);document.getElementById("rename-modal").style.display="none";notice("重命名成功","success");LD(curPath)}catch(e){notice("重命名失败："+e.message,"error")}});
document.querySelectorAll("#upload-modal, #mkdir-modal, #rename-modal").forEach(function(m){m.addEventListener("click",function(e){if(e.target===m)m.style.display="none"})});
document.addEventListener("keydown",function(e){if(e.key==="Escape"){document.getElementById("upload-modal").style.display="none";document.getElementById("mkdir-modal").style.display="none";document.getElementById("rename-modal").style.display="none"}});
document.getElementById("mkdir-name-input").addEventListener("keydown",function(e){if(e.key==="Enter")document.getElementById("btn-mkdir-confirm").click()});
document.getElementById("rename-input").addEventListener("keydown",function(e){if(e.key==="Enter")document.getElementById("btn-rename-confirm").click()});

// Drag-and-drop on file list table
(function(){
var tableWrap=document.getElementById("webdav-table-wrap");
var dragCounter=0,dropTargetPath="",hoveredRow=null;
function resetDrag(){dragCounter=0;dropTargetPath="";if(hoveredRow){hoveredRow.classList.remove("drag-over-row");hoveredRow=null}tableWrap.classList.remove("drag-over-table")}
document.addEventListener("dragenter",function(e){if(!e.dataTransfer)return;var kinds=e.dataTransfer.types||[];if(kinds.indexOf("Files")<0)return;e.preventDefault();dragCounter=Math.min(dragCounter+1,1000);tableWrap.classList.add("drag-over-table")});
document.addEventListener("dragleave",function(e){e.preventDefault();dragCounter--;if(dragCounter<=0)resetDrag()});
document.addEventListener("dragend",function(){resetDrag()});
document.getElementById("file-list-body").addEventListener("dragover",function(e){e.preventDefault();e.dataTransfer.dropEffect="copy";var tr=e.target.closest("tr");if(tr){var cb=tr.querySelector('input[type="checkbox"]');if(cb&&cb.dataset.isFolder==="1"){if(hoveredRow&&hoveredRow!==tr)hoveredRow.classList.remove("drag-over-row");tr.classList.add("drag-over-row");hoveredRow=tr;dropTargetPath=cb.value;return}}if(hoveredRow){hoveredRow.classList.remove("drag-over-row");hoveredRow=null}dropTargetPath=curPath?curPath+"/":"/"});
document.getElementById("file-list-body").addEventListener("dragleave",function(e){var tr=e.target.closest("tr");if(tr&&hoveredRow===tr){tr.classList.remove("drag-over-row");hoveredRow=null;dropTargetPath=curPath?curPath+"/":"/"}});
tableWrap.addEventListener("drop",async function(e){e.preventDefault();resetDrag();var items=e.dataTransfer.items;if(!items||!items.length)return;var destPath=dropTargetPath||(curPath?curPath+"/":"/");var p=document.getElementById("upload-progress");p.style.display="block";p.value=0;var total=items.length,ok=0;for(var i=0;i<items.length;i++){try{var entry=(items[i].webkitGetAsEntry||items[i].getAsEntry).call(items[i]);if(entry)await processEntry(entry,destPath,function(v){ok+=v;p.value=Math.round(ok/total*100)})}catch(ex){}}p.style.display="none";notice("上传完成","success");LD(curPath)});
async function processEntry(entry,dirPath,onProgress){if(!entry)return;if(entry.isFile){return new Promise(function(resolve){entry.file(function(file){uploadFile(file,dirPath).then(function(){onProgress&&onProgress(1);resolve()}).catch(function(){onProgress&&onProgress(0);resolve()})},function(){onProgress&&onProgress(0);resolve()})})}else if(entry.isDirectory){var base=dirPath;while(base.endsWith("/")&&base!=="/")base=base.slice(0,-1);var newDir=(base==="/"?"/":base+"/")+entry.name+"/";var dirOk=false;try{var mr=await fetch("/api/admin/webdav",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({action:"mkdir",path:newDir})});dirOk=mr.ok;if(!mr.ok)throw new Error("mkdir failed");await new Promise(function(r){setTimeout(r,200)})}catch(e){notice("创建目录失败："+newDir+" "+e.message,"error");;if(!dirOk)return};var reader=entry.createReader();var subEntries=[];var batch;do{batch=await new Promise(function(resolve){reader.readEntries(resolve)});subEntries=subEntries.concat(Array.from(batch))}while(batch.length>0);for(var i=0;i<subEntries.length;i++){await processEntry(subEntries[i],newDir,onProgress)}}}
})();

async function LD(p,g){curPath=p;if(!g){curPage=1}document.getElementById("breadcrumb-path").innerHTML=BP(p);document.getElementById("file-list-body").innerHTML='<tr><td colspan="5"><h6 class="typecho-list-table-title"><span class="loading">'+E(M.loading||"")+'</span></h6></td></tr>';try{var r=await fetch("/api/admin/webdav?action=list&path="+encodeURIComponent(p)+"&page="+curPage+"&pageSize="+pageSize,{headers:{"X-CSRF-Token":csrf}});if(!r.ok){var em=MT("serverError",{status:r.status});try{var ej=await r.json();if(ej.error)em=ej.error}catch(ex){}throw new Error(em)}var j=await r.json();if(!j.success)throw new Error(j.error);entries=[];var d=j.data;(d.prefixes||[]).forEach(function(x){var nm=x.replace(/\\/$/,"").split("/").pop()||x;entries.push({name:nm,isFolder:true,size:0,lastModified:"",fullKey:x})});(d.objects||[]).forEach(function(x){var nm=x.key.split("/").pop()||x.key;entries.push({name:nm,isFolder:false,size:x.size,lastModified:x.lastModified,etag:x.etag,fullKey:x.key})});totalItems=d.total||0;totalPages=d.totalPages||1;curPage=d.page||1;RT()}catch(e){document.getElementById("file-list-body").innerHTML='<tr><td colspan="5"><h6 class="typecho-list-table-title">'+E(MT("loadingFailed",{reason:e.message||e}))+'</h6></td></tr>'}}
function RT(){var body=document.getElementById("file-list-body");if(!entries.length){body.innerHTML='<tr><td colspan="5"><h6 class="typecho-list-table-title">'+E(M.empty||"")+'</h6></td></tr>';return}var h=entries.map(function(e){var ep=(curPath?curPath+"/":"")+e.name;var dp=e.isFolder?ep+"/":ep;var ca=e.isFolder?'href="#" data-nav="'+E(dp)+'"':'href="/api/admin/webdav?action=download&path='+encodeURIComponent(ep)+'" target="_blank"';return'<tr><td><input type="checkbox" value="'+E(dp)+'" data-is-folder="'+(e.isFolder?"1":"0")+'"></td><td><a class="file-link" '+ca+'>'+MI(e.name,e.isFolder)+E(e.name)+(e.isFolder?"/":"")+'</a></td><td>'+(e.isFolder?"-":BS(e.size))+'</td><td>'+FD(e.lastModified)+'</td><td><a href="#" class="rename-link" data-path="'+E(ep)+'" data-is-folder="'+(e.isFolder?"1":"0")+'" title="'+E(M.rename||"")+'"><i class="i-edit"></i></a><a href="#" class="delete-link" data-path="'+E(dp)+'" title="'+E(M.delete||"")+'"><i class="i-delete"></i></a></td></tr>'});h.push('<tr class="webdav-pager"><td colspan="5"><div class="webdav-pager-nav">'+(curPage>1?'<a href="#" class="pager-link" data-page="'+(curPage-1)+'">&laquo; '+E(M.previous||"")+'</a>':'<span class="webdav-pager-disabled">&laquo; '+E(M.previous||"")+'</span>')+'<span>'+E(MT("pageSummary",{page:curPage,pages:totalPages,count:totalItems}))+'</span>'+(curPage<totalPages?'<a href="#" class="pager-link" data-page="'+(curPage+1)+'">'+E(M.next||"")+' &raquo;</a>':'<span class="webdav-pager-disabled">'+E(M.next||"")+' &raquo;</span>')+'</div></td></tr>');body.innerHTML=h.join("");document.querySelectorAll(".typecho-table-select-all").forEach(function(cb){cb.checked=false})}
LD("");
})();
</script>`;
}

// --- Default Export (Plugin Entry) ---

export default function init({ addHook, pluginId, registerTranslations }: PluginInitContext): void {
  registerTranslations?.('en', en);
  registerTranslations?.('zh-CN', zhCN);

  registerPluginAdminPath(ADMIN_API_ROUTE);
  // Default front-end route; the request:route handler below re-registers
  // the configured routePath lazily (configurable via admin settings), so a
  // cold isolate with a non-default routePath still gets cache exemptions.
  registerPluginRoute('/webdav');

  addHook(
    'plugin:config:beforeSave',
    pluginId,
    (result: { success: boolean; settings?: Record<string, unknown>; error?: string }, extra?: { pluginId?: string; settings?: Record<string, unknown>; i18n?: I18n }) => {
      if (extra?.pluginId !== pluginId) return result;

      try {
        const config = normalizeConfig(extra.settings || {});
        clearTianyiSessionCache();
        return {
          success: true,
          settings: {
            routePath: config.routePath,
            protocolEnabled: config.protocolEnabled ? 'true' : 'false',
            mounts: config.mounts,
            failBanEnabled: config.failBanEnabled ? 'true' : 'false',
            failBanMaxFailures: config.failBanMaxFailures,
            failBanWindowSeconds: config.failBanWindowSeconds,
            failBanSeconds: config.failBanSeconds,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error
            ? error.message
            : translate(extra?.i18n, 'plugin.typecho-plugin-webdav.config.validationFailed', 'WebDAV settings could not be validated.'),
        };
      }
    },
  );

  addHook(
    'request:route',
    pluginId,
    async (result: PluginRouteResult, extra?: {
      request?: Request; url?: URL; path?: string; db?: Database;
      options?: Record<string, unknown>; env?: Record<string, unknown>; i18n?: I18n;
    }) => {
      if (result?.handled || !extra?.request || !extra.path) return result;

      if (extra.path === ADMIN_API_ROUTE) {
        if (!extra.db) {
          return {
            handled: true,
            response: jsonResponse({ error: translate(extra.i18n, 'plugin.typecho-plugin-webdav.api.databaseUnavailable', 'Database unavailable.') }, 503, { 'Content-Type': 'application/json' }),
          };
        }
        try {
          const options = extra.options || {};
          const authResult = await authenticateAdmin(extra.request, extra.db, options);
          if (authResult instanceof Response) {
            const msg = authResult.status === 403
              ? translate(extra.i18n, 'core.error.forbidden', 'Forbidden.')
              : translate(extra.i18n, 'core.error.unauthorized', 'Unauthorized.');
            return { handled: true, response: jsonResponse({ error: msg }, authResult.status, { 'Content-Type': 'application/json' }) };
          }

          if (extra.request.method === 'POST') {
            if (!isSameOriginRequest(extra.request, String(options.siteUrl || ''))) {
              return {
                handled: true,
                response: new Response(JSON.stringify({ error: translate(extra.i18n, 'core.error.forbidden', 'Forbidden') }), {
                  status: 403,
                  headers: { 'Content-Type': 'application/json' },
                }),
              };
            }
            const csrfError = await requireAdminCSRF(
              extra.request,
              String(options.secret || ''),
              String(authResult.user.authCode || authResult.user.auth_code || ''),
              authResult.uid,
              extra.i18n,
            );
            if (csrfError) {
              return { handled: true, response: jsonResponse({ error: csrfError }, 403, { 'Content-Type': 'application/json' }) };
            }
          }

          const apiSettings = readPluginSettings(extra.options);
          const apiConfig = normalizeConfig(apiSettings);
          return { handled: true, response: await handleAdminApiRequest(extra.request, apiConfig, extra.env, extra.i18n) };
        } catch (error) {
          console.error('[webdav] Admin API error:', error);
          return {
            handled: true,
            response: jsonResponse({ error: error instanceof Error ? error.message : translate(extra.i18n, 'core.error.server', 'Server error') }, 500, { 'Content-Type': 'application/json' }),
          };
        }
      }

      const settings = readPluginSettings(extra.options);
      if (!parseBoolean(settings?.protocolEnabled, true)) return result;

      const routeMatch = matchConfiguredWebDavRoute(settings, extra.path);
      if (!routeMatch) return result;

      // Keep the plugin-route table in sync with the configured entry path
      // (idempotent) so middleware never caches or deprecation-checks it.
      registerPluginRoute(routeMatch.routePath);

      let config: WebDavConfig;
      try {
        config = normalizeConfig(settings);
        config.routePath = routeMatch.routePath;
      } catch (error) {
        console.error('[webdav] Invalid configuration:', error);
        return {
          handled: true,
          response: new Response(translate(extra.i18n, 'plugin.typecho-plugin-webdav.api.invalidConfig', 'The WebDAV plugin is not configured.'), { status: 503 }),
        };
      }

      try {
        return { handled: true, response: await handleWebDavRequest(config, routeMatch.relativePath, extra as any) };
      } catch (error) {
        console.error('[webdav] Request failed:', error);
        return {
          handled: true,
          response: new Response(translate(extra.i18n, 'plugin.typecho-plugin-webdav.api.storageError', 'WebDAV storage error.'), { status: 502 }),
        };
      }
    },
    20,
  );

  addHook(
    'admin:page',
    pluginId,
    (html: string, extra?: { slug?: string; csrfToken?: string; options?: Record<string, unknown>; i18n?: I18n }) => {
      if (extra?.slug !== 'webdav') return html;
      const csrf = extra?.csrfToken || '';
      const pluginSettings = readPluginSettings(extra?.options);
      const pageSize = normalizeInteger(pluginSettings?.fileListPageSize, 50, 1, 200);
      return adminPageHtml(csrf, pageSize, extra.i18n);
    },
  );

  addHook(
    'admin:footer',
    pluginId,
    (html: string, extra?: { activeMenu?: string; user?: { group?: string }; i18n?: I18n }) => {
      const isAdmin = extra?.user?.group && hasPermission(extra.user.group, 'administrator');
      if (!isAdmin) return html;

      const isActive = extra?.activeMenu === 'webdav';
      const menuLabel = translate(extra?.i18n, 'plugin.typecho-plugin-webdav.adminMenu', 'WebDAV');
      const extraHtml = `<script>
(function(){
  var mgmt = document.querySelector('#typecho-nav-list ul.root:nth-child(3) ul.child');
  if (mgmt) {
    var li = document.createElement('li');
    li.className = '${isActive ? 'focus' : ''}';
    var link = document.createElement('a');
    link.href = '/admin/plugin/webdav';
    link.textContent = ${safeJsonForScript(menuLabel)};
    li.appendChild(link);
    mgmt.appendChild(li);
  }
})();
</script>`;
      return html + extraHtml;
    },
  );
}
