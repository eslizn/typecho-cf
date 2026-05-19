# Scribe

Typecho-CF AI 写作助手插件，接入 OpenAI 兼容 LLM，在编辑器中生成、润色和纠错正文。

## 功能

- **生成** — 根据标题和正文上下文，调用 LLM 续写或生成文章草稿
- **润色** — 保持原意前提下优化表达、结构和可读性
- **纠错** — 修正语法、用词和格式问题
- **风格参考** — 自动采样最近 N 篇已发布文章作为作者风格样本
- **多语言输出** — 支持中/英/日/韩及自动检测
- **附件感知** — 可选将正文图片以 `image_url` 发送给视觉模型

## 配置参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `endpoint` | text | `https://open.bigmodel.cn/api/paas/v4/` | OpenAI 兼容 Base URL |
| `apiKey` | password | — | LLM 服务商 API Key |
| `model` | text | `glm-4.7-flash` | 模型名称 |
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
  → 校验 endpoint + apiKey + model（通过 /models API）
  → 失败则阻止保存并返回错误信息

编辑器页面加载
  → admin:writePost:bottom / admin:writePage:bottom hook 注入 AI 按钮 UI
  → 按钮组：生成 / 润色 / 纠错
  → 发送时收集标题、正文、附件 ID

用户点击操作
  → plugin:<id>:action hook 触发（generate/polish/correct）
  → 读取风格样本（最近 N 篇已发布文章）
  → 构建 system prompt（含风格样本、输出语言、目标读者、篇幅、事实策略等）
  → 调用 LLM（stream 模式），逐步返回生成内容
  → 将结果写入编辑器
```

## 注册的 Hook

| Hook | 类型 | 用途 |
|------|------|------|
| `admin:writePost:bottom` | filter | 文章编辑器底部注入 AI 操作按钮 |
| `admin:writePage:bottom` | filter | 页面编辑器底部注入 AI 操作按钮 |
| `plugin:config:beforeSave` | filter | 保存前验证 LLM endpoint 和 model 可用性 |
| `plugin:<id>:action` | action | 处理 generate/polish/correct 操作 |

## 依赖

- OpenAI 兼容 LLM API（如智谱 GLM、DeepSeek、OpenAI 等）
- `drizzle-orm`（读取风格样本文章）
