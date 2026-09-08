import { hasPermission, registerPluginAdminPath, registerPluginRoute } from 'typecho/plugin-sdk';
import type { PluginInitContext, PluginRouteResult } from 'typecho/plugin-sdk';
import type { Database } from 'typecho/db';
import { validateAuthToken, getAuthCookies, requireAdminCSRF } from '@/lib/auth';
import { isSameOriginRequest } from '@/lib/admin-auth';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';
import { InputError, readBoundedFormData, readBoundedJson } from '@/lib/input';

import { PLUGIN_ID } from './types';
import type { WebDavConfig, WebDavStorageAdapter } from './types';
import {
  readPluginSettings, normalizeConfig, normalizeInteger, parseBoolean,
  matchConfiguredWebDavRoute,
} from './config';
import { handleWebDavRequest, createStorageAdapter } from './protocol';
import { clearTianyiSessionCache } from './adapters';

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

async function handleAdminApiRequest(request: Request, config: WebDavConfig, workerEnv?: Record<string, unknown>): Promise<Response> {
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
    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: jsonHeaders });
  }

  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      let formData: FormData;
      try {
        formData = await readBoundedFormData(request, REQUEST_BODY_LIMITS.uploadEnvelope);
      } catch (error) {
        if (error instanceof InputError) {
          return new Response(JSON.stringify({ error: error.message }), {
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
        if (!file) return new Response(JSON.stringify({ error: '没有选择文件' }), { status: 400, headers: jsonHeaders });
        const filePath = dirPath ? `${dirPath.replace(/\/+$/, '')}/${file.name}` : file.name;
        await adapter.write(filePath, file.stream(), file.type || 'application/octet-stream', workerEnv);
        return new Response(JSON.stringify({ success: true, message: '上传成功' }), { headers: jsonHeaders });
      }
      return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: jsonHeaders });
    }

    let body: { action?: string; path?: string; newPath?: string; paths?: string[] };
    try {
      body = await readBoundedJson(request, REQUEST_BODY_LIMITS.adminForm) as typeof body;
    } catch (error) {
      if (error instanceof InputError) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: error.status,
          headers: jsonHeaders,
        });
      }
      throw error;
    }
    const action = body.action || '';
    const targetPath = body.path || '';

    if (action === 'mkdir') {
      if (!targetPath) return new Response(JSON.stringify({ error: '请输入目录名' }), { status: 400, headers: jsonHeaders });
      await adapter.mkdir(targetPath.endsWith('/') ? targetPath : `${targetPath}/`, workerEnv);
      return new Response(JSON.stringify({ success: true, message: '目录创建成功' }), { headers: jsonHeaders });
    }
    if (action === 'delete') {
      const raw = body.paths || (targetPath ? [targetPath] : []);
      const paths = Array.isArray(raw) ? raw : [String(raw)];
      if (!paths.length) return new Response(JSON.stringify({ error: '请选择要删除的文件或目录' }), { status: 400, headers: jsonHeaders });
      for (const p of paths) await adapter.delete(String(p), workerEnv);
      return new Response(JSON.stringify({ success: true, message: '删除成功' }), { headers: jsonHeaders });
    }
    if (action === 'rename') {
      const newPath = body.newPath || '';
      if (!targetPath || !newPath) return new Response(JSON.stringify({ error: '缺少参数' }), { status: 400, headers: jsonHeaders });
      if (targetPath === newPath) return new Response(JSON.stringify({ error: '新名称与旧名称相同' }), { status: 400, headers: jsonHeaders });
      const readResp = await adapter.read(targetPath, workerEnv);
      if (!readResp.ok) return new Response(JSON.stringify({ error: `读取源文件失败 (${readResp.status})` }), { status: 502, headers: jsonHeaders });
      if (!readResp.body) return new Response(JSON.stringify({ error: '无法读取源文件' }), { status: 500, headers: jsonHeaders });
      const ct = readResp.headers.get('content-type') || 'application/octet-stream';
      await adapter.write(newPath, readResp.body, ct, workerEnv);
      await adapter.delete(targetPath, workerEnv);
      return new Response(JSON.stringify({ success: true, message: '重命名成功' }), { headers: jsonHeaders });
    }
    return new Response(JSON.stringify({ error: `未知操作: ${action}` }), { status: 400, headers: jsonHeaders });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: jsonHeaders });
}

// --- Admin page HTML template ---

function adminPageHtml(csrf: string, pageSize: number): string {
  return `<div class="col-mb-12 typecho-list" id="webdav-app">
  <div id="webdav-notice" style="display:none"></div>
  <div class="typecho-list-operate clearfix">
    <div class="operate">
      <label><i class="sr-only">全选</i><input type="checkbox" class="typecho-table-select-all"></label>
      <div class="btn-group btn-drop">
        <button class="btn dropdown-toggle btn-s" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="webdav-actions">选中项 <i class="i-caret-down"></i></button>
        <ul class="dropdown-menu" id="webdav-actions" role="menu"><li><a href="#" id="btn-delete-selected">删除</a></li></ul>
      </div>
      <button class="btn primary btn-s" id="btn-upload">上传文件</button>
      <button class="btn btn-s" id="btn-new-folder">新建文件夹</button>
    </div>
  </div>
  <div class="webdav-breadcrumb" style="margin:0 0 1em;padding:8px 12px;background:#FFF;border-radius:2px;font-size:.92857em">
    <a href="#" data-path="" class="breadcrumb-link">根目录</a><span id="breadcrumb-path"></span>
  </div>
  <div class="typecho-table-wrap" id="webdav-table-wrap">
    <table class="typecho-list-table">
      <colgroup><col width="20"><col width=""><col width="12%" class="kit-hidden-mb"><col width="18%" class="kit-hidden-mb"><col width="12%"></colgroup>
      <thead><tr><th><input type="checkbox" class="typecho-table-select-all"></th><th>名称</th><th>大小</th><th>修改时间</th><th>操作</th></tr></thead>
      <tbody id="file-list-body"><tr><td colspan="5"><h6 class="typecho-list-table-title"><span class="loading">加载中...</span></h6></td></tr></tbody>
    </table>
  </div>
<div id="upload-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.45);z-index:1000"><div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#FFF;padding:24px;border-radius:4px;width:400px;max-width:90vw"><h3 style="margin:0 0 16px;font-size:1.1em">上传文件</h3><p style="color:#999;font-size:.92857em;margin:0 0 12px">上传到：<span id="upload-dir-path">/</span></p><input type="file" id="upload-file-input" multiple style="margin-bottom:12px;width:100%" webkitdirectory=""><progress id="upload-progress" value="0" max="100" style="width:100%;display:none;margin-bottom:12px"></progress><div style="text-align:right"><button class="btn btn-s" id="btn-upload-cancel">取消</button><button class="btn primary btn-s" id="btn-upload-confirm">上传</button></div></div></div>
  <div id="mkdir-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.45);z-index:1000"><div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#FFF;padding:24px;border-radius:4px;width:360px;max-width:90vw"><h3 style="margin:0 0 16px;font-size:1.1em">新建文件夹</h3><p style="color:#999;font-size:.92857em;margin:0 0 12px">在 <span id="mkdir-dir-path">/</span> 下创建</p><input type="text" id="mkdir-name-input" class="text w-100" placeholder="文件夹名称" style="margin-bottom:12px"><div style="text-align:right"><button class="btn btn-s" id="btn-mkdir-cancel">取消</button><button class="btn primary btn-s" id="btn-mkdir-confirm">创建</button></div></div></div>
  <div id="rename-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.45);z-index:1000"><div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#FFF;padding:24px;border-radius:4px;width:360px;max-width:90vw"><h3 style="margin:0 0 16px;font-size:1.1em">重命名</h3><input type="text" id="rename-input" class="text w-100" placeholder="新名称" style="margin-bottom:12px"><div style="text-align:right"><button class="btn btn-s" id="btn-rename-cancel">取消</button><button class="btn primary btn-s" id="btn-rename-confirm">确认</button></div></div></div>
</div>
<style>
.webdav-breadcrumb a{color:#467B96;text-decoration:none}.webdav-breadcrumb a:hover{text-decoration:underline}
.webdav-breadcrumb span{color:#999}
.file-link{color:#444;text-decoration:none}.file-link:hover{color:#467B96;text-decoration:none}
.folder-icon{color:#E8A838;margin-right:4px}.file-icon{color:#999;margin-right:4px}
#webdav-table-wrap.drag-over-table{outline:3px dashed #467B96;outline-offset:-3px;background:#FFFBCC}
#webdav-table-wrap tr.drag-over-row{background:#D6EAF8!important;outline:2px solid #2980B9;outline-offset:-2px}
</style>
<script>
(function(){
var csrf=${JSON.stringify(csrf)},curPath="",entries=[],renameTarget="",curPage=1,pageSize=${pageSize},totalItems=0,totalPages=1;

var _noticeTimer;function notice(msg,type){clearTimeout(_noticeTimer);var n=document.getElementById("webdav-notice");n.style.display="block";n.className="message "+(type==="success"?"success":type==="error"?"error":"notice");n.innerHTML='<p>'+E(msg)+'</p><button type="button" class="typecho-notice-close">&times;</button>';var b=n.querySelector(".typecho-notice-close");if(b)b.addEventListener("click",function(){n.style.display="none"});_noticeTimer=setTimeout(function(){n.style.display="none"},5000)}

function E(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function BP(p){if(!p)return"";var a=p.split("/").filter(Boolean),h="",c="",i;for(i=0;i<a.length;i++){c+="/"+a[i];h+=' / <a href="#" data-path="'+E(c.charAt(0)==="/" ? c.slice(1) : c)+'" class="breadcrumb-link">'+E(a[i])+"</a>"}return h}
function BS(b){if(!b||b===0)return"-";return b<1024?b+" B":b<1048576?Math.ceil(b/1024)+" KB":(b/1048576).toFixed(1)+" MB"}
function FD(d){if(!d)return"-";try{return new Date(d).toLocaleString()}catch(e){return d}}
function MI(n,f){if(f)return'<span class="folder-icon">&#128193;</span>';var x=n.split(".").pop().toLowerCase();var m={jpg:1,jpeg:1,png:1,gif:1,webp:1,svg:1,bmp:1,ico:1,avif:1,mp4:2,webm:2,avi:2,mov:2,mkv:2,mp3:3,wav:3,flac:3,aac:3,ogg:3,zip:4,rar:4,"7z":4,tar:4,gz:4,bz2:4,js:5,ts:5,jsx:5,tsx:5,py:5,rb:5,go:5,rs:5,java:5,c:5,cpp:5,h:5,css:5,html:5,xml:5,json:5,yaml:5,yml:5,pdf:6};var t=m[x]||0;if(t===1)return'<span class="file-icon" style="color:#5A9E5F">&#128247;</span>';if(t===2)return'<span class="file-icon" style="color:#6A5ACD">&#127910;</span>';if(t===3)return'<span class="file-icon" style="color:#D2691E">&#127925;</span>';if(t===4)return'<span class="file-icon" style="color:#8B7355">&#128230;</span>';if(t===5)return'<span class="file-icon" style="color:#467B96">&#128221;</span>';if(t===6)return'<span class="file-icon" style="color:#C0392B">&#128214;</span>';return'<span class="file-icon">&#128196;</span>'}
async function LD(p,g){curPath=p;if(!g){curPage=1}document.getElementById("breadcrumb-path").innerHTML=BP(p);document.getElementById("file-list-body").innerHTML='<tr><td colspan="5"><h6 class="typecho-list-table-title"><span class="loading">加载中...</span></h6></td></tr>';try{var r=await fetch("/api/admin/webdav?action=list&path="+encodeURIComponent(p)+"&page="+curPage+"&pageSize="+pageSize,{headers:{"X-CSRF-Token":csrf}});if(!r.ok){var em="Server error ("+r.status+")";try{var ej=await r.json();if(ej.error)em=ej.error}catch(ex){}throw new Error(em)}var j=await r.json();if(!j.success)throw new Error(j.error);entries=[];var d=j.data;(d.prefixes||[]).forEach(function(x){var nm=x.replace(/\\/$/,"").split("/").pop()||x;entries.push({name:nm,isFolder:true,size:0,lastModified:"",fullKey:x})});(d.objects||[]).forEach(function(x){var nm=x.key.split("/").pop()||x.key;entries.push({name:nm,isFolder:false,size:x.size,lastModified:x.lastModified,etag:x.etag,fullKey:x.key})});totalItems=d.total||0;totalPages=d.totalPages||1;curPage=d.page||1;RT()}catch(e){document.getElementById("file-list-body").innerHTML='<tr><td colspan="5"><h6 class="typecho-list-table-title">加载失败：'+E(e.message)+'</h6></td></tr>'}finally{}}
function RT(){if(!entries.length){document.getElementById("file-list-body").innerHTML='<tr><td colspan="5"><h6 class="typecho-list-table-title">此目录为空</h6></td></tr>';return}var h=entries.map(function(e,i){var ep=(curPath?curPath+"/":"")+e.name;var dp=e.isFolder?ep+"/":ep;var ca=e.isFolder?'href="#" data-nav="'+E(dp)+'"':'href="/api/admin/webdav?action=download&path='+encodeURIComponent(ep)+'" target="_blank"';return'<tr><td><input type="checkbox" value="'+E(dp)+'" data-is-folder="'+(e.isFolder?"1":"0")+'"></td><td><a class="file-link" '+ca+'>'+MI(e.name,e.isFolder)+E(e.name)+(e.isFolder?"/":"")+'</a></td><td>'+(e.isFolder?"-":BS(e.size))+'</td><td>'+FD(e.lastModified)+'</td><td><a href="#" class="rename-link" data-path="'+E(ep)+'" data-is-folder="'+(e.isFolder?"1":"0")+'" title="重命名" style="margin-right:8px"><i class="i-edit"></i></a><a href="#" class="delete-link" data-path="'+E(dp)+'" title="删除"><i class="i-delete"></i></a></td></tr>'});h.push('<tr class="webdav-pager"><td colspan="5"><div style="display:flex;justify-content:center;align-items:center;gap:16px;padding:8px 0">'+(curPage>1?'<a href="#" class="pager-link" data-page="'+(curPage-1)+'">&laquo; 上一页</a>':'<span style="color:#ccc">&laquo; 上一页</span>')+'<span>第 '+curPage+'/'+totalPages+' 页，共 '+totalItems+' 项</span>'+(curPage<totalPages?'<a href="#" class="pager-link" data-page="'+(curPage+1)+'">下一页 &raquo;</a>':'<span style="color:#ccc">下一页 &raquo;</span>')+'</div></td></tr>');document.getElementById("file-list-body").innerHTML=h.join("");document.querySelectorAll(".typecho-table-select-all").forEach(function(cb){cb.checked=false})}
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

LD("");
})();
</script>`;
}

// --- Default Export (Plugin Entry) ---

export default function init({ addHook, pluginId }: PluginInitContext): void {
  registerPluginAdminPath(ADMIN_API_ROUTE);
  // Default front-end route; the request:route handler below re-registers
  // the configured routePath lazily (configurable via admin settings), so a
  // cold isolate with a non-default routePath still gets cache exemptions.
  registerPluginRoute('/webdav');

  addHook(
    'plugin:config:beforeSave',
    pluginId,
    (result: { success: boolean; settings?: Record<string, unknown>; error?: string }, extra?: { pluginId?: string; settings?: Record<string, unknown> }) => {
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
          error: error instanceof Error ? error.message : 'WebDAV 配置校验失败',
        };
      }
    },
  );

  addHook(
    'request:route',
    pluginId,
    async (result: PluginRouteResult, extra?: {
      request?: Request; url?: URL; path?: string; db?: Database;
      options?: Record<string, unknown>; env?: Record<string, unknown>;
    }) => {
      if (result?.handled || !extra?.request || !extra.path) return result;

      if (extra.path === ADMIN_API_ROUTE) {
        if (!extra.db) {
          return { handled: true, response: new Response(JSON.stringify({ error: 'Database unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } }) };
        }
        try {
          const options = extra.options || {};
          const authResult = await authenticateAdmin(extra.request, extra.db, options);
          if (authResult instanceof Response) {
            const msg = authResult.status === 403 ? 'Forbidden' : 'Unauthorized';
            return { handled: true, response: new Response(JSON.stringify({ error: msg }), { status: authResult.status, headers: { 'Content-Type': 'application/json' } }) };
          }

          if (extra.request.method === 'POST') {
            if (!isSameOriginRequest(extra.request, String(options.siteUrl || ''))) {
              return {
                handled: true,
                response: new Response(JSON.stringify({ error: 'Forbidden' }), {
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
            );
            if (csrfError) {
              return { handled: true, response: new Response(JSON.stringify({ error: 'CSRF validation failed' }), { status: 403, headers: { 'Content-Type': 'application/json' } }) };
            }
          }

          const apiSettings = readPluginSettings(extra.options);
          const apiConfig = normalizeConfig(apiSettings);
          return { handled: true, response: await handleAdminApiRequest(extra.request, apiConfig, extra.env) };
        } catch (error) {
          console.error('[webdav] Admin API error:', error);
          return { handled: true, response: new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Internal error' }), { status: 500, headers: { 'Content-Type': 'application/json' } }) };
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
        return { handled: true, response: new Response('WebDAV plugin is not configured', { status: 503 }) };
      }

      try {
        return { handled: true, response: await handleWebDavRequest(config, routeMatch.relativePath, extra as any) };
      } catch (error) {
        console.error('[webdav] Request failed:', error);
        return { handled: true, response: new Response('WebDAV storage error', { status: 502 }) };
      }
    },
    20,
  );

  addHook(
    'admin:page',
    pluginId,
    (html: string, extra?: { slug?: string; csrfToken?: string; options?: Record<string, unknown> }) => {
      if (extra?.slug !== 'webdav') return html;
      const csrf = extra?.csrfToken || '';
      const pluginSettings = readPluginSettings(extra?.options);
      const pageSize = normalizeInteger(pluginSettings?.fileListPageSize, 50, 1, 200);
      return adminPageHtml(csrf, pageSize);
    },
  );

  addHook(
    'admin:footer',
    pluginId,
    (html: string, extra?: { activeMenu?: string; user?: { group?: string } }) => {
      const isAdmin = extra?.user?.group && hasPermission(extra.user.group, 'administrator');
      if (!isAdmin) return html;

      const isActive = extra?.activeMenu === 'webdav';
      const extraHtml = `<script>
(function(){
  var mgmt = document.querySelector('#typecho-nav-list ul.root:nth-child(3) ul.child');
  if (mgmt) {
    var li = document.createElement('li');
    li.className = '${isActive ? 'focus' : ''}';
    li.innerHTML = '<a href="/admin/plugin/webdav">WebDAV</a>';
    mgmt.appendChild(li);
  }
})();
</script>`;
      return html + extraHtml;
    },
  );
}
