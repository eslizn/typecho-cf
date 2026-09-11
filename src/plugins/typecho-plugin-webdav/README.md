# WebDAV

Typecho-CF WebDAV 协议插件，通过 WebDAV 协议挂载和访问多种存储后端，支持多挂载点，内置管理面板。

## 功能

- **WebDAV 协议完整实现** — PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE
- **多后端支持** — Cloudflare R2、Amazon S3 兼容存储、天翼云盘
- **多挂载点** — 一个入口路由下可配置多个存储后端，各自映射为一级子目录
- **Basic Auth 认证** — 基于 Typecho 用户表的 HTTP Basic 认证
- **登录失败封禁** — 按 IP 统计 Basic Auth 失败次数，超阈值后临时封禁
- **浏览器目录浏览** — GET 请求目录时返回 HTML 文件列表
- **前缀限制** — 每个挂载可配置桶内前缀，限制可访问范围
- **管理面板** — 在后台"管理"菜单中提供 WebDAV 网页文件管理器，支持浏览、上传、下载、删除、重命名、新建文件夹

## 配置参数

### 基础配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `routePath` | text | `/webdav` | WebDAV 入口路径 |
| `protocolEnabled` | select | 启用 | WebDAV 协议入口开关。关闭后 WebDAV 协议不可用，仅可通过管理面板操作文件 |
| `failBanEnabled` | select | 启用 | 登录失败封禁开关 |
| `failBanMaxFailures` | text | `5` | 失败次数阈值 |
| `failBanWindowSeconds` | text | `300` | 统计窗口（秒） |
| `failBanSeconds` | text | `900` | 封禁时长（秒） |
| `fileListPageSize` | text | `50` | 管理面板每页条数，范围 1–200 |

### 挂载配置（repeatable，可添加多个）

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `mount` | text | `/` | 挂载目录名，`/` 或空表示根目录（唯一根挂载），否则为目录名 |
| `provider` | select | `r2` | 存储类型：R2 / S3 兼容 / 天翼云盘 |
| `bindingName` | select (R2) | `BUCKET` | R2 Bucket 绑定名（从 wrangler.toml 自动读取） |
| `endpoint` | text (S3) | — | S3 Endpoint URL |
| `bucket` | text (S3) | — | S3 Bucket 名称 |
| `region` | text (S3) | `us-east-1` | S3 Region |
| `accessKeyId` | text (S3) | — | S3 Access Key ID |
| `secretAccessKey` | password (S3) | — | S3 Secret Access Key |
| `username` | text (天翼) | — | 天翼云盘登录手机号 |
| `password` | password (天翼) | — | 天翼云盘登录密码 |
| `sessionCookie` | textarea (天翼) | — | 已登录的 Cookie。Workers 出口无法访问 cloud.189.cn 或登录需要验证码时必须使用 |
| `rootDir` | text (天翼) | `-11` | 天翼云盘根目录 folderId |
| `prefix` | text | — | 桶内前缀，限制可访问范围 |
| `pathStyle` | select (S3) | Path-style | S3 URL 路径风格 |

### 天翼云盘配置说明

天翼云盘支持两种认证方式，使用 [天翼云盘 API](https://cloud.189.cn) 接入：

- **Cookie 模式（推荐）**：在 `sessionCookie` 字段粘贴浏览器登录天翼云盘后的 Cookie。当 Workers 出口无法访问 `cloud.189.cn`（账号密码登录会请求超时）或登录需要验证码时，只能使用该模式。Cookie 失效时插件会提示更新配置，不会自动回退到密码登录。
- **账号密码模式**：在 `username` 字段填写登录手机号，`password` 字段填写登录密码。插件通过 RSA 加密登录获取 session，并在同一 Worker isolate 内按凭据哈希缓存 30 分钟（最多 64 个账号）；并发请求共享同一次登录。天翼返回 `InvalidSessionKey` 时会清除缓存并自动重新登录，插件配置变更时也会立即清除缓存。Worker 冷启动或请求落到新的 isolate 时仍需登录一次。

天翼云盘使用 folderId 而非路径来定位文件，因此首次访问目录时可能有额外延迟（路径解析需要逐层遍历）。

## 管理面板

启用插件后，管理员可在后台"管理"菜单中看到"WebDav"入口。管理面板提供：

- **目录浏览**：面包屑导航，进入/退出子目录
- **文件管理**：上传、下载、删除（支持多选批量删除）、重命名
- **文件夹操作**：新建文件夹
- **文件类型图标**：按扩展名显示不同图标

管理面板通过 session 认证（不需要额外登录），所有状态变更操作（上传、删除、重命名等）需要 CSRF token 验证。

## 工作流程

```
请求到达
  → init() 注册 owner-scoped route resolver；核心在缓存判断和 request:route 前同步当前 WebDAV 路径 claim
  → request:route hook 先处理 `/api/admin/webdav` 管理 API
  → 对协议入口检查 protocolEnabled（关闭则跳过，继续正常路由）
  → 匹配 routePath 前缀的请求进入 WebDAV 协议处理
  → 非 WebDAV 请求跳过，继续正常路由

认证
  → 解析 HTTP Basic Auth header
  → 调用 Typecho verifyPassword 验证凭据
  → 检查用户是否有 administrator 权限
  → 失败：记录 IP 失败次数 → 超阈值则封禁

路由
  → 从 URL path 中提取挂载目录名
  → 查找匹配的 StorageMount 配置
  → R2: 通过 env[bindingName] 获取 R2Bucket 对象
  → S3: 构造 AWS Signature V4 签名的 HTTP 请求
  → 天翼: 通过账号密码登录，session cookie 调用云盘 API

请求分派
  → PROPFIND: 列出目录/文件列表，返回 XML
  → GET: 读取文件内容并返回，目录返回 HTML 列表页
  → PUT: 上传文件
  → DELETE: 删除文件
  → MKCOL: 创建目录
  → COPY/MOVE: 复制/移动对象
```

## 注册的 Hook

| Hook | 类型 | 用途 |
|------|------|------|
| `plugin:config:beforeSave` | filter | 保存前校验挂载配置有效性，标准化所有配置字段 |
| `request:route` | filter | 分发 WebDAV 协议和 `/api/admin/webdav`；协议关闭时仅跳过 WebDAV 入口 |
| `admin:page` | filter | 注入 WebDAV 文件管理器 HTML 及内联 JS（面包屑导航、CRUD、拖拽上传） |
| `admin:footer` | filter | 向管理后台导航栏「管理」菜单注入 WebDav 入口 |

## 路由声明

WebDAV 在插件 `init()` 中通过 owner-scoped `registerRouteResolver` 声明协议入口。resolver 根据 `protocolEnabled` 和 `routePath` 返回当前有效的路径 claim；停用协议或修改路径后，核心会释放旧 claim 并同步新 claim。实际请求仍由 `request:route` hook 处理。

系统路由优先级保持不变：系统固定路由和系统路由表优先于插件路由。历史配置使用 `/dav` 时继续匹配 `/dav` 及其子路径，保证现有 WebDAV 客户端无需修改；配置改为其他路径后，旧路径不再作为 WebDAV 路由保留。

## 协议支持

| 方法 | 支持 |
|------|------|
| `OPTIONS` | 返回 Allow 头 |
| `PROPFIND` | Depth 0/1，返回多状态 XML |
| `GET` | 文件下载 + 目录 HTML 浏览 |
| `HEAD` | 文件元信息 |
| `PUT` | 文件上传 |
| `DELETE` | 文件/目录删除 |
| `MKCOL` | 创建目录 |
| `COPY` | 复制对象 |
| `MOVE` | 移动对象 |

## 依赖

- Cloudflare Workers R2 binding（R2 模式）
- AWS Signature V4（S3 模式）
- 天翼云盘 API（天翼模式）
- Typecho 用户表认证
