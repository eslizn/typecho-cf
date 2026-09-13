# Scribe

Typecho-CF AI 写作助手插件。模型、Provider 与 API Key 全部由 **AI 插件**（`typecho-plugin-ai`）统一维护，
Scribe 通过 `ai.chat.generate` capability 调用模型，并在配置页用下拉框直接选择 AI 插件里可用的对话模型。

## 功能

- **生成** — 根据标题和正文上下文，调用 AI 插件的模型生成文章草稿
- **润色** — 保持原意前提下优化表达、结构和可读性
- **纠错** — 修正语法、用词和格式问题
- **模型下拉** — 模型列表来自 AI 插件中「已启用 + 支持文本对话 + 已设置 Alias」的模型别名，跨 Provider 合并去重（`ai.models.list` capability）
- **风格参考** — 自动采样最近 N 篇已发布文章作为作者风格样本
- **多语言输出** — 支持中/英/日/韩及自动检测
- **附件感知** — 可选将正文图片以 `image_url` 发送给视觉模型
- **实时任务遥测** — 生成、润色、纠错期间显示当前任务、阶段、交互摘要、上行/下行 Token、Token/s、总用量和耗时

## 依赖

- **AI 插件 `typecho-plugin-ai` 必须先启用**，并至少配置一个启用、支持文本对话且填写了 Alias 的模型（未设置 Alias 的模型不会被发布）
- 模型、Provider、API Key 的校验都在 AI 插件侧完成（保存 AI 插件配置时会请求 `/models`）

未启用 AI 插件时：配置页的模型下拉为空，保存会提示「未检测到 AI 插件的模型清单」；编辑器里的生成/润色/纠错会返回「AI 插件未启用或未提供 ai.chat.generate 能力」。

## 配置参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `model` | select | — | 模型下拉，选项由 AI 插件发布（`optionsSource: ai.models.list`） |
| `temperature` | text | `0.7` | 生成创造性控制 |
| `maxTokens` | text | `32000` | 单次最大输出 Token 数 |
| `stylePostCount` | text | `5` | 风格参考文章数，0 关闭 |
| `outputLanguage` | select | `auto` | 输出语言：自动/简体中文/繁体中文/English/日本語/한국어 |
| `targetAudience` | text | — | 目标读者描述，留空由模型推断 |
| `lengthPreset` | select | `balanced` | 篇幅策略：偏短/标准/深入 |
| `factPolicy` | select | `conservative` | 事实策略：保守/允许低风险常识推断 |
| `userPrompt` | textarea | — | 额外写作要求，每次请求附带 |
| `includeBodyAssets` | select | 关闭 | 发送正文图片和附件给模型 |

## 工作流程

```
配置保存
  → plugin:config:beforeSave hook 触发
  → 通过 ai.models.list capability 校验所选模型仍在 AI 插件目录中
  → 失败则阻止保存并返回错误信息

编辑器页面加载
  → admin:writePost:bottom / admin:writePage:bottom hook 注入 AI 按钮 UI
  → 按钮组：生成 / 润色 / 纠错
  → 发送时收集标题、正文、附件 ID

用户点击操作
  → plugin:<id>:action hook 触发（generate/polish/correct）
  → 读取风格样本（最近 N 篇已发布文章）
  → 构建 system prompt（含风格样本、输出语言、目标读者、篇幅、事实策略等）
  → 通过 ai.chat.generate capability 请求 AI 插件（stream 模式）
  → 以 text/event-stream 返回 task/text/progress/done 事件
  → 把 text 分片逐步写入编辑器，同时更新实时任务和 Token 统计
```

### 实时状态区

编辑器状态区只展示固定的安全摘要，不回显标题、正文、Prompt、Provider URL 或密钥：

- 任务：AI 生成、AI 润色或 AI 纠错；
- 交互：整理上下文、向 LLM 请求并等待、接收生成内容、整理结果；
- 用量：上行/下行 Token、各自速率、总用量和耗时；
- Provider 返回精确 usage 时覆盖估算值；没有 usage 时显示“估算”，缺失字段显示 `—`。

SSE 连接使用 `Cache-Control: no-store`，异常时恢复操作前的正文。旧版能力实现如果忽略 `onProgress`，Scribe 会基于已收到的文本做受限估算并继续完成操作。

## 注册的 Hook

| Hook | 类型 | 用途 |
|------|------|------|
| `admin:writePost:bottom` | filter | 文章编辑器底部注入 AI 操作按钮 |
| `admin:writePage:bottom` | filter | 页面编辑器底部注入 AI 操作按钮 |
| `plugin:config:beforeSave` | filter | 保存前校验模型是否仍在 AI 插件目录中 |
| `plugin:<id>:action:authorize` | filter | 将 generate/polish/correct 的最低权限声明为 contributor |
| `plugin:<id>:action` | action | 处理 generate/polish/correct 操作 |

## 消费的 Capability

| Capability | 版本 | 提供方 | 用途 |
|------------|------|--------|------|
| `ai.chat.generate` | 1 | `typecho-plugin-ai` | 生成/润色/纠错的实际模型调用 |
| `ai.models.list` | 1 | `typecho-plugin-ai` | 模型下拉选项与保存前校验 |

## 迁移说明

1.0.0 中 Scribe 自带 `endpoint` / `apiKey` / 文本 `model` 配置；1.1.0 起这些字段被移除，
统一改为引用 AI 插件的模型。升级后请在 AI 插件中确认模型可用，然后在 Scribe 配置页重新选择模型。

## 依赖（技术）

- `drizzle-orm`（读取风格样本文章）
