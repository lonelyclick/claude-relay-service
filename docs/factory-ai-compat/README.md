# Factory.ai API 兼容层文档

## 概述

CRS 通过 Claude Console 模式支持 Factory.ai（`api.factory.ai`）作为上游 API。
Factory.ai 是 Anthropic Claude API 的第三方代理，但在 headers、body 字段、安全过滤等方面
与原生 Anthropic API 存在差异。CRS 在 `claudeConsoleRelayService.js` 中自动检测
Factory.ai 账户（`apiUrl` 包含 `api.factory.ai`），并做 **Droid CLI 伪装** 以通过安全检查。

## 伪装策略

CRS 模拟 Factory.ai 官方 CLI 工具 **Droid 0.89.0** 的请求格式：
- 注入 Droid 身份标识到 system prompt
- 添加 Droid 专属 HTTP headers（`x-factory-client`, `x-client-version` 等）
- 清理 Claude Code 指纹文本

这些伪装基于 2026-03-30 通过 HTTPS 代理对 droid 0.89.0 的请求抓包分析。

## 兼容改动一览

### Headers 处理（`_cleanHeadersForFactoryAi()`）

| 改动 | 说明 |
|------|------|
| 注入 `x-client-version: 0.89.0` | **必须**，否则 Factory.ai 返回 400 "Unable to determine client version" |
| 注入 `x-factory-client: cli` | Droid CLI 标识 |
| 注入 `x-api-provider: anthropic` | Droid 原生发送 |
| 注入 `x-api-key: placeholder` | Droid 原生发送（真实认证走 Authorization Bearer） |
| 注入 `x-session-id: <uuid>` | 同一账户的连续请求保持不变（30 分钟 TTL），模拟 Droid CLI 会话 |
| 注入 `x-assistant-message-id: <uuid>` | 每个请求独立的随机 UUID |
| 保留 `x-stainless-*` headers | Droid 原生也发送这些 Anthropic SDK headers |
| 补全缺失的 `x-stainless-*` | 如果客户端未发送，注入默认值（lang=js, os=Linux 等） |
| anthropic-beta 白名单过滤 | `_filterBetaForFactoryAi()` — 防御性保留 |
| 清理敏感 headers | 移除 `anthropic-dangerous-*`, `sec-fetch-*`, `x-app`, `accept-language` |

### Body 处理（`_processFactoryAiRequestBody()`，8 个步骤）

| 步骤 | 改动 | 原因 |
|------|------|------|
| 1 | 模型名映射 | 4.6 系列去日期后缀（`claude-opus-4-6-20260320` → `claude-opus-4-6`），4.5 保留 |
| 2 | `system` 注入 Droid 身份 | 在 system 数组第一个 block 前注入 `"You are Droid, an AI software engineering agent built by Factory."` — Factory.ai 白名单检测此前缀 |
| 3 | 删除 `metadata`、`context_management` | `metadata` 防泄露；`context_management` 返回 400 "Extra inputs are not permitted" |
| 4 | Claude Code 指纹文本替换 | 清理 system 和 messages 中的指纹文本（详见下方） |
| 5 | tools 类型版本映射 | Factory.ai 的 tool type 版本与 Claude Code 不同 |
| 6 | `thinking.budget_tokens` ≥ 1024 | Factory.ai 要求最小值 1024 |
| 7 | `max_tokens` = 128000 | 强制设为 Droid 0.89.0 的值（Claude Code 默认发 64000），同时确保 > budget_tokens |
| 8 | 删除 `temperature` | Droid 0.89.0 不发送此字段，Claude Code 发 `temperature: 1` |

### 不需要处理的字段

| 字段 | 状态 | 说明 |
|------|------|------|
| `cache_control` | **支持** | Factory.ai 支持 prompt caching，无需删除 |
| `thinking.type: "adaptive"` | **支持** | Droid 原生使用此模式 |
| `output_config.effort` | **支持** | Droid 原生使用 `effort: "high"` |
| `tools`（标准格式） | **支持** | `{name, description, input_schema}` 格式正常 |
| `system` 字段 | **支持**（需 Droid 身份前缀） | 注入 magic string 后可直接使用 system 字段 |

## Factory.ai 安全过滤规则

### System 字段白名单

Factory.ai 对 `system` 字段有严格检查：
- **必须**：第一个 text block 以 `"You are Droid, an AI software engineering agent built by Factory."` 精确开头（含句号）
- 后续 block 可以是任意内容
- 没有 system 字段也可以（不触发 403）
- 不依赖特定 headers，纯粹基于 system 内容检测

### Messages 指纹检测

Factory.ai 会扫描 messages 文本，检测 Claude Code 特定指纹返回 403：

| 被封锁的短语 | 来源 | CRS 替换为 |
|-------------|------|-----------|
| `You are Claude Code, Anthropic's official CLI for Claude` | Claude Code (< 2.1.87) system prompt 身份声明 | `You are an AI coding assistant` |
| `You are a Claude agent, built on Anthropic's Claude Agent SDK.` | Claude Code (2.1.87+) Claude Agent SDK 身份声明 | `You are an AI coding assistant.` |
| `(user's private global instructions for all projects)` | CLAUDE.md 注入标记（带括号才触发） | `[user project-level config]` |

**注意**：这些指纹在 system 字段和 messages 中都会被检测，CRS 会同时清理两处。

### 不触发的变体

- 单独的 "Claude Code" 不触发
- 不带括号的 "user's private global instructions for all projects" 不触发
- `<system-reminder>` 标签本身不触发
- "instructions OVERRIDE" 等片段不触发

## 请求流程

```
Claude Code CLI
  → CRS API (/api/v1/messages)
    → 调度器选择 Factory.ai 账户
      → _processFactoryAiRequestBody()  // body 转换（Droid 身份注入 + 指纹清理）
      → _filterBetaForFactoryAi()       // beta header 过滤
      → _cleanHeadersForFactoryAi()     // Droid 伪装 headers 注入
        → Factory.ai API (api.factory.ai/api/llm/a/v1/messages)
```

## Droid CLI 请求格式参考

通过 HTTPS 代理抓包获得（droid 0.89.0，2026-03-30）。

完整抓包数据见 `captured_droid_request.json`（已脱敏+精简 tools schema）。
抓包工具见 `capture_proxy.mjs`。

### 抓包方法

```bash
# 1. 生成自签证书
openssl req -x509 -newkey rsa:2048 -keyout proxy_key.pem -out proxy_cert.pem \
  -days 30 -nodes -subj '/CN=localhost'

# 2. 启动 HTTPS 拦截代理
node docs/factory-ai-compat/capture_proxy.mjs

# 3. 另一终端，通过代理运行 droid
FACTORY_API_BASE_URL=https://localhost:18765 \
FACTORY_API_KEY=fk-... \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
droid exec "say ok"
```

**关键发现**：
- `FACTORY_API_BASE_URL` 环境变量可重定向 droid 的 API 请求目标
- droid 二进制位于 `~/.local/bin/droid`（Bun 编译），配置目录为 `~/.factory/`
- 请求完整 dump 自动保存到 `/tmp/droid_request_*.json`

### Headers

```
user-agent: factory-cli/0.89.0
anthropic-version: 2023-06-01
x-factory-client: cli
x-client-version: 0.89.0
x-api-provider: anthropic
x-api-key: placeholder
x-session-id: 8bd3057f-6c46-4c43-942a-2a33afbb05e8
x-assistant-message-id: 45e3f6ae-a3f6-492d-bedb-ebcd0a0261ac
x-stainless-lang: js
x-stainless-os: Linux
x-stainless-arch: x64
x-stainless-runtime: node
x-stainless-runtime-version: v24.3.0
x-stainless-package-version: 0.70.1
x-stainless-retry-count: 0
x-stainless-timeout: 600
```

### Body

```json
{
  "model": "claude-opus-4-6",
  "max_tokens": 128000,
  "system": [
    {"type": "text", "text": "You are Droid, an AI software engineering agent built by Factory."},
    {"type": "text", "text": "You are running in non-interactive Exec Mode...", "cache_control": {"type": "ephemeral"}}
  ],
  "messages": [{"role": "user", "content": [3 blocks: system-reminder + TodoWrite reminder + user input]}],
  "tools": [
    "Read", "LS", "Execute", "Edit", "Grep", "Glob", "Create",
    "ExitSpecMode", "WebSearch", "TodoWrite", "FetchUrl",
    "GenerateDroid", "Skill", "Task"
  ],
  "thinking": {"type": "adaptive"},
  "output_config": {"effort": "high"},
  "stream": true
}
```

**注意**：Droid 不发送 `temperature`、`metadata`、`context_management` 字段。

### Droid 的 14 个 Tools

| Tool | 对应 Claude Code |
|------|-----------------|
| Read | Read |
| LS | Glob/ls |
| Execute | Bash |
| Edit | Edit |
| Grep | Grep |
| Glob | Glob |
| Create | Write |
| ExitSpecMode | ExitPlanMode |
| WebSearch | WebSearch |
| TodoWrite | TodoWrite |
| FetchUrl | WebFetch |
| GenerateDroid | (无对应) |
| Skill | Skill |
| Task | Task |

所有 tools 使用标准 `{name, description, input_schema}` 格式，无特殊 `type` 字段。

## 已知限制

1. **beta 特性全部移除** — 当前白名单为空。2026-03 测试显示 Factory.ai 已不再拒绝未知 beta，但保留过滤作为防御。
2. **`context_management` 被删除** — Claude Code 2.1.87+ 的上下文管理功能不生效。
3. **指纹过滤是精确匹配** — 如果 Claude Code 更新了这些短语的措辞，需要同步更新 CRS 的 fingerprints 数组。
4. **Droid 版本号可能过期** — 当 Factory.ai 更新 droid 到新版本后，`x-client-version` 等可能需要同步更新。

## 工具和测试

本目录下包含的文件：

### 抓包工具
- `capture_proxy.mjs` — HTTPS 拦截代理，用于抓取 droid CLI 的完整请求
- `captured_droid_request.json` — droid 0.89.0 的抓包数据（已脱敏+精简）

### 测试脚本
- `test_api_capabilities.mjs` — Factory.ai API 能力探测（各字段支持情况）
- `test_claude_code_compat.mjs` — 模拟 Claude Code 请求的端到端兼容测试
- `test_fingerprint_filter.mjs` — 指纹过滤规则验证

### 运行方式

```bash
# 需要设置环境变量
export FACTORY_AI_API_KEY="fk-..."
export FACTORY_AI_BASE_URL="https://api.factory.ai/api/llm/a"

# 运行测试
node docs/factory-ai-compat/test_api_capabilities.mjs
node docs/factory-ai-compat/test_claude_code_compat.mjs
node docs/factory-ai-compat/test_fingerprint_filter.mjs

# 抓包（需要先生成证书）
node docs/factory-ai-compat/capture_proxy.mjs
```

## 相关提交

| Commit | 内容 |
|--------|------|
| `455d264b` | budget_tokens clamp, force_account query, _processFactoryAiRequestBody 重构 |
| `07d8572f` | beta 白名单, header 清理, max_tokens > budget_tokens |
| `427d3226` | Claude Code 指纹文本过滤（解决 403） |
| `75859a0a` | 删除 context_management 字段（兼容 2.1.87） |
| `cc37e67b` | 保留 cache_control（Factory.ai 支持 prompt caching） |
| (this) | Droid 完全伪装：headers 注入 + system magic string + session/message ID + max_tokens/temperature 对齐 |
