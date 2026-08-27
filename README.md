# custom-provider

> [!NOTE]
> 这是一个 [pi](https://github.com/anthropics/claude-code) 的第三方扩展，用于在 TUI 或 RPC（Telegram 等）环境下统一管理模型 Provider。

[![npm version](https://img.shields.io/npm/v/custom-provider-pi)](https://www.npmjs.com/package/custom-provider-pi)
[![license](https://img.shields.io/npm/l/custom-provider-pi)](LICENSE)
[![pi package](https://img.shields.io/badge/pi-package-violet)](#installation)

## 概述

`custom-provider` 为 pi 提供了一个统一的 Provider 管理入口 `/custom-provider`，支持：

- **10 个子命令**：`add` / `remove` / `refresh` / `list` / `test` / `config` / `enable` / `disable` / `prune` / `help`
- **简单/自定义双模式添加**：简单模式只需 URL 即可自动探测协议与模型列表；自定义模式支持代理、多 Key 负载均衡、请求头模板、多模态、高级配置等
- **非交互式添加**：flags / JSON 参数，适用于脚本、Telegram RPC 等场景
- **多协议混用**：同一 Provider 内不同模型走不同协议（OpenAI / Anthropic / Google）
- **自动探测**：输入 URL 自动尝试多种协议路径，检测协议类型与可用模型
- **模型过滤与修剪**：添加时按关键字过滤，事后随时修剪
- **负载均衡**：多 Key 轮询 + 429 自动冷却（指数退避）
- **请求头模板**：一键应用 Claude Code / Codex / OpenCode 等客户端的完整请求头集合
- **智能规格推断**：OpenRouter 实时目录（24h 缓存）→ 本地预设 → 协议级兜底，上下文窗口与输出上限自动修正退化数据

零运行时依赖，仅使用 Node.js 内置模块（`fs` / `child_process` / `http` / `https` / `os` / `path`）。

---

## 安装

### 方式一：扩展目录（最快）

```bash
cp custom-provider.ts ~/.pi/agent/extensions/
# 在 pi 中执行 /reload
```

### 方式二：npm 包

```bash
pi install npm:custom-provider-pi@latest
```

### 方式三：本地目录

```bash
pi install local:/path/to/custom-provider
```

`@earendil-works/pi-coding-agent` 仅做类型引用，由 pi 运行时捆绑，声明在 `peerDependencies`。

---

## 快速开始

### 简单添加（推荐新用户）

在 pi 中执行 `/custom-provider add`，依次输入：

1. **名称**：`deepseek`（唯一标识，仅字母/数字/中划线/下划线）
2. **端点 URL**：`https://api.deepseek.com/v1`
3. **选择「简单添加」**：自动探测协议与模型列表
4. 完成 — 模型已就绪，用 `/model` 切换

### 非交互式添加（脚本 / Telegram）

```bash
/custom-provider add deepseek \
    --base-url https://api.deepseek.com/v1 \
    --api-key $DEEPSEEK_API_KEY \
    --models deepseek-chat,deepseek-reasoner
```

---

## 命令参考

| 命令 | 说明 |
|---|---|
| `add [name] [flags]` | 添加 provider（交互引导或参数化） |
| `remove <name> [--yes]` | 删除 provider |
| `refresh [name]` | 重新拉取模型列表 |
| `list` | 列出所有 provider 及状态 |
| `test <name>` | 测试连通性（延迟 / 模型数 / LB 状态） |
| `config [edit\|path\|<name>]` | 查看或编辑配置 |
| `enable\|disable <name>` | 启用 / 禁用 provider |
| `prune <name> [--keep/--drop]` | 按关键字修剪模型列表 |
| `help` | 显示帮助 |

所有子命令支持 Tab 自动补全（provider 名大小写不敏感）。

---

## add 参数详解

### flags

| flag | 说明 |
|---|---|
| `--base-url` / `--url` | API 端点（自动清理 `/v1/models` 尾巴，补全 `/v1`） |
| `--api-key` / `--key` | API Key（`$ENV` / `!cmd` / 字面量 / `local`） |
| `--api TYPE` | 协议类型（`auto`/`openai-completions`/`openai-responses`/`anthropic-messages`/`google-generative-ai`） |
| `--models "a,b"` | 逗号分隔的模型 ID |
| `--model m` | 单个模型 ID（可多次累加） |
| `--profile <key>` | 完整请求头模板（`claude-code` / `codex` / `browser`） |
| `--ua <key\|string>` | 单独设置 User-Agent（预设键或原始字符串） |
| `--header "K: V"` | 自定义请求头（可多次，支持 `$ENV`） |
| `--headers '{"k":"v"}'` | JSON 形式设置请求头 |
| `--proxy <URL>` | HTTP/SOCKS 代理地址 |
| `--lb-keys "$K1,$K2"` | 多 Key 负载均衡 |
| `--lb-cooldown N` | 冷却时间（秒，默认 60） |
| `--model-api "id:协议"` | 按模型覆盖协议（可多次） |
| `--model-base-url "id:url"` | 按模型覆盖端点（可多次） |
| `--auth-header` | 开启 Bearer 认证（非标准 API） |
| `--compat '{...}'` | 协议兼容选项 |
| `--overrides '{"id":{...}}'` | 按模型覆盖（`reasoning` / `input` / `contextWindow` / `maxTokens` / `cost`） |
| `--force` / `-f` | 覆盖已存在的 provider |
| `--json '{...}'` | 完整配置 JSON |

### JSON 模式

```bash
/custom-provider add --json '{
  "name": "gw",
  "baseUrl": "https://gw.example.com/v1",
  "apiKey": "$MY_KEY",
  "lbKeys": ["$K1", "$K2"],
  "lbCooldown": 30,
  "headers": { "X-Custom": "value" },
  "models": ["gpt-4o", { "id": "claude-x", "api": "anthropic-messages" }]
}'
```

---

## 核心功能

### 双协议混用

同一 provider 内不同模型可走不同协议（如 OpenAI 网关同时转发 Anthropic 模型）。

**协议决定优先级**：模型 `api` 字段 > provider 级 `api` > 按 URL 自动推断。

```bash
# 方式 1：--model-api flags
/custom-provider add gw --base-url https://gw.example.com/v1 \
    --models gpt-4o,claude-x \
    --model-api claude-x:anthropic-messages \
    --model-base-url claude-x:https://api.anthropic.com

# 方式 2：JSON
/custom-provider add --json '{
  "name": "gw",
  "baseUrl": "https://gw.example.com/v1",
  "models": [
    "gpt-4o",
    { "id": "claude-x", "api": "anthropic-messages", "baseUrl": "https://api.anthropic.com" }
  ]
}'
```

### 请求头模板

不同客户端（Claude Code / Codex / OpenCode 等）携带的请求头集合不同。`--profile` 可一键应用完整模板：

| 模板 | 包含 |
|---|---|
| `browser` | 仅 User-Agent（Chrome 131） |
| `claude-code` | UA + `anthropic-version` + `x-app` + `content-type` + `anthropic-dangerous-direct-browser-access` |
| `codex` | UA + `accept: application/json` |
| `opencode` / `cursor` / `windsurf` | 各客户端 UA |

```bash
/custom-provider add relay --base-url https://gw.example.com \
    --profile claude-code --models claude-sonnet-4
```

**优先级**：`--header`/`--headers`（显式）> `--profile`（模板）> `--ua` > 默认浏览器 UA。

请求头值支持 `$ENV` / `!cmd` 插值，支持 JSON 对象或逐行 `Key: Value` 两种格式。敏感头（`authorization` / `x-api-key` / `anthropic-beta` 等）允许设置但会警告。

### User-Agent 预设

| 预设 | UA |
|---|---|
| `browser`（默认） | `Mozilla/5.0 ... Chrome/131.0.0.0 Safari/537.36` |
| `claude-code` | `claude-code/2.1.237` |
| `codex` | `codex_cli_rs/0.148.0 (cli)` |
| `opencode` | `opencode/1.18.19` |
| `cursor` | `Cursor/3.16.0 (Windows; 64bit)` |
| `windsurf` | `Windsurf/2.0.0 (Windows)` |
| `openwebui` | `OpenWebUI/0.11.0` |
| `chatgpt` | `...Chrome/131.0.0.0 ...ChatGPT-Desktop/1.2025.0` |

### 负载均衡

多 Key 轮询 + 429 自动冷却（指数退避）：

```bash
/custom-provider add relay --base-url https://api.gw.com/v1 \
    --lb-keys "$KEY_A,$KEY_B,sk-plain" --lb-cooldown 60 --models gpt-4o
```

- 触发 429 时该 Key 自动进入冷却（默认 60s，连续 429 指数退避，上限 10 分钟）
- 成功请求重置退避计数
- `list` 显示活跃 Key 数：`3 Key（2 活跃 / 60s 冷却）`
- 单 key 模式完全向后兼容（`apiKey` 字符串）

### 代理

```bash
/custom-provider add my --base-url https://api.deepseek.com/v1 \
    --api-key $KEY --models deepseek-chat --proxy http://127.0.0.1:7890
```

> [!NOTE]
> Node.js `fetch` 需要 `NODE_USE_ENV_PROXY=1` 才读取代理环境变量；传统 `http.request` 不读取。

### 多模态（图片输入）

默认 `input: ["text"]`（纯文本）。pi 会自动识别已知的多模态模型并开启图片输入：

1. **OpenRouter 目录**：`architecture.input_modalities` 含 `image` 时自动标记
2. **内置模式匹配**：`gpt-4o` / `claude-*` / `gemini-*` / `grok-4+` / `glm-4v` / `qwen-vl` / `minimax-m*` 及 ID 含 `vision` 的模型
3. **显式覆盖**：模型对象写 `input: ["text", "image"]` 或 `["text"]`

**为什么默认不开**：向不支持图片的模型发图会收到上游 404（如 deepseek-v4-flash-0731 非 vision 版）。未知模型保守处理为纯文本；已知视觉模型自动开启，无需手动配置。

**强制指定**：

```bash
/custom-provider add my --base-url ... \
    --overrides '{"mymodel":{"input":["text","image"]}}'
```

### 上下文窗口与规格推断

模型的 `contextWindow` / `maxTokens` 通过三级策略自动填充：

1. **显式配置**：用户在模型对象中写的值（最高优先）
2. **OpenRouter 实时目录**：自动归一化模型 ID（去 `[1m]` 后缀、@版本、路径前缀），24h 磁盘缓存
3. **协议级兜底**：Anthropic 200K / OpenAI 258K / Google 1M / 其他 128K

**数据卫生**：社区目录对不公布输出上限的模型常给退化值（`maxTokens == contextWindow`），本扩展会自动钳到 `min(32K, ⌊ctx/4⌋)`，保证输入预算至少留 3/4 窗口。

---

## 其他子命令

### prune — 模型修剪

```bash
/custom-provider prune cpa                          # 交互式筛选
/custom-provider prune cpa --keep "deepseek,glm"    # 只保留匹配项
/custom-provider prune cpa --drop "qwen,mini"       # 排除匹配项
```

大小写不敏感；`--keep` / `--drop` 可组合；过滤为空时不修改。

### enable / disable

```bash
/custom-provider disable cpa    # 立即注销，配置保留
/custom-provider enable cpa     # 重新注册
```

禁用的 provider 在 `list` / `config` 中仍可见，但在 `/model` 选择器和请求中消失。

### config

```bash
/custom-provider config             # 配置摘要 + 路径
/custom-provider config cpa         # 完整 JSON 详情
/custom-provider config edit        # 编辑器（保存即校验并重注册）
/custom-provider config path        # 仅输出路径
```

### test — 连通性测试

```
✅ relay
  端点: https://api.gw.com/v1
  协议: openai-completions
  延迟: 187ms
  模型: 52 个
  示例: gpt-4o, claude-sonnet-4, deepseek-v4-flash, ... (+48)
  LB: 2/3 Key 活跃
```

支持已配置 provider 或临时端点（`test --base-url URL --api-key KEY`）。

---

## 配置文件

路径：`~/.pi/agent/custom-providers.json`

```jsonc
{
  "providers": [
    {
      "name": "deepseek",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "$DEEPSEEK_API_KEY",     // $ENV / !cmd / 字面量 / local
      "api": "openai-completions",
      "enabled": true,
      "lbKeys": ["$K1", "$K2"],          // 可选：多 Key 负载均衡
      "lbCooldown": 60,
      "proxy": "http://127.0.0.1:7890",  // 可选：代理
      "headers": { "X-Custom": "value" },
      "models": [
        "deepseek-chat",                                      // 字符串 = provider 默认协议
        { "id": "claude-x", "api": "anthropic-messages" },    // 对象 = 按模型覆盖
        { "id": "vision-1", "input": ["text", "image"],       // 多模态
          "contextWindow": 200000, "maxTokens": 16384,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
      ]
    }
  ]
}
```

---

## 安全注意事项

- `apiKey` 与 `headers` **明文存储**，请勿将 `custom-providers.json` 同步到公开仓库
- `!command` 特性会执行 shell 命令，仅编辑可信配置
- 建议敏感值使用 `$ENV` 引用而非字面量
- Linux / macOS 下可收紧文件权限：`chmod 600 ~/.pi/agent/custom-providers.json`

---

## 开发

```bash
npm install          # 安装 devDependencies（typescript / @types/node）
npm run typecheck    # tsc --noEmit
```

运行时零第三方依赖。类型检查需要 `@earendil-works/pi-coding-agent`（peerDependency）。

## 许可证

[MIT](LICENSE)
