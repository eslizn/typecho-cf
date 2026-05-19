# WebDAV

Typecho-CF WebDAV 协议插件，通过 WebDAV 协议挂载和访问 S3/R2 存储后端，支持多挂载点。

## 功能

- **WebDAV 协议完整实现** — PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE
- **多后端支持** — Cloudflare R2（通过 Workers binding）和 Amazon S3 兼容存储（通过 AWS Signature V4）
- **多挂载点** — 一个入口路由下可配置多个存储后端，各自映射为一级子目录
- **Basic Auth 认证** — 基于 Typecho 用户表的 HTTP Basic 认证
- **登录失败封禁** — 按 IP 统计 Basic Auth 失败次数，超阈值后临时封禁
- **浏览器目录浏览** — GET 请求目录时返回 HTML 文件列表
- **前缀限制** — 每个挂载可配置桶内前缀，限制可访问范围

## 配置参数

### 基础配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `routePath` | text | `/webdav` | WebDAV 入口路径 |
| `failBanEnabled` | select | 启用 | 登录失败封禁开关 |
| `failBanMaxFailures` | text | `5` | 失败次数阈值 |
| `failBanWindowSeconds` | text | `300` | 统计窗口（秒） |
| `failBanSeconds` | text | `900` | 封禁时长（秒） |

### 挂载配置（repeatable，可添加多个）

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `mount` | text | — | 挂载目录名，空或 `/` 表示根目录 |
| `provider` | select | `r2` | 存储类型：R2 或 S3 兼容 |
| `bindingName` | select (R2) | `BUCKET` | R2 Bucket 绑定名（从 wrangler.toml 自动读取） |
| `endpoint` | text (S3) | — | S3 Endpoint URL |
| `bucket` | text (S3) | — | S3 Bucket 名称 |
| `region` | text (S3) | `us-east-1` | S3 Region |
| `accessKeyId` | text (S3) | — | S3 Access Key ID |
| `secretAccessKey` | password (S3) | — | S3 Secret Access Key |
| `prefix` | text | — | 桶内前缀，限制可访问范围 |
| `pathStyle` | select (S3) | Path-style | S3 URL 路径风格 |

## 工作流程

```
请求到达
  → route:request hook 拦截匹配 routePath 前缀的请求
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

请求分派
  → PROPFIND: 列出目录/文件列表，返回 XML
  → GET: 读取文件内容并返回，目录返回 HTML 列表页
  → PUT: 上传文件
  → DELETE: 删除文件
  → MKCOL: 创建目录（写入空对象作为占位）
  → COPY/MOVE: 复制/移动对象
```

## 注册的 Hook

| Hook | 类型 | 用途 |
|------|------|------|
| `plugin:config:beforeSave` | filter | 保存前校验挂载配置有效性 |
| `route:request` | call | 拦截 WebDAV 请求并处理，返回 Response 时中止后续路由 |

## 协议支持

| 方法 | 支持 |
|------|------|
| `OPTIONS` | 返回 Allow 头 |
| `PROPFIND` | Depth 0/1，返回多状态 XML |
| `GET` | 文件下载 + 目录 HTML 浏览 |
| `HEAD` | 文件元信息 |
| `PUT` | 文件上传（含 If-None-Match: * 防覆盖） |
| `DELETE` | 文件/目录删除 |
| `MKCOL` | 创建目录 |
| `COPY` | 复制对象 |
| `MOVE` | 移动对象 |

## 依赖

- Cloudflare Workers R2 binding（R2 模式）
- AWS Signature V4（S3 模式）
- Typecho 用户表认证
