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
- **负载均衡**：多 Key 轮询 + 429 自动冷却（固定时长、冷却期内不参与轮询，全部冷却才兜底）；支持 roundrobin / sticky 两种调度模式
- **请求头模板**：一键应用 Claude Code / Codex / OpenCode 等客户端的完整请求头集合
- **智能规格推断**：OpenRouter 实时目录（24h 缓存）→ 本地预设 → 协议级兜底，上下文窗口与输出上限自动修正退化数据

零运行时依赖，仅使用 Node.js 内置模块（`fs` / `child_process` / `http` / `https` / `os` / `path`）。

> [!IMPORTANT]
> **安全更新**：v0.1.5+ 已禁用 `!command` 特性（命令注入风险）并修复 HTTP 头注入、并发竞态等问题。详见 [SECURITY-FIXES.md](SECURITY-FIXES.md)。

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
| `--proxy <URL\|disable>` | 代理配置（URL 或 `disable`，支持 `$ENV`） |
| `--lb-keys "$K1,$K2"` | 多 Key 负载均衡（429 后自动冷却，冷却期结束后重新参与轮询） |
| `--lb-cooldown N` | 冷却时间（秒，默认 60） |
| `--lb-cooldowns "30,120"` | 按 Key 冷却时间（秒，与 lbKeys 一一对应，可选） |
| `--lb-mode roundrobin\|sticky` | 调度模式：roundrobin 每个请求轮询，sticky 粘住一个 Key 直到 429（默认 roundrobin） |
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
  "lbCooldowns": [30, 120],
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

多 Key 负载均衡 + 429 自动冷却（固定时长）），支持两种调度模式：

```bash
# roundrobin（默认）：每个请求轮询下一个可用 Key
/custom-provider add relay --base-url https://api.gw.com/v1 \
    --lb-keys "$KEY_A,$KEY_B,sk-plain" --lb-cooldown 60 --models gpt-4o

# sticky：粘住一个 Key 使用，直到它 429 冷却才切换下一个可用 Key
#  （某 Key 成功调用后冷却清零，sticky 仍保持当前 Key，不回切）
/custom-provider add relay --base-url https://api.gw.com/v1 \
    --lb-keys "$K_A,$K_B" --lb-mode sticky --models gpt-4o
```

**调度模式**（`lbMode: "roundrobin" | "sticky"`）：
- `roundrobin`（默认）：每个请求按序轮流使用下一个未冷却的 Key，平摊请求
- `sticky`：优先沿用当前 Key；仅当它 429 进入冷却时才切换到下一个可用 Key 并继续粘住

- 触发 429 时该 Key 自动进入冷却，时长固定为配置的 `lbCooldown`（下限 60 秒），不做指数放大/退避
- 冷却期内该 Key 绝不参与轮询；冷却期结束后自动重新进入轮询池
- 只要还有任一 Key 未冷却就正常轮询；全部 Key 都 429 冷却时，才强行使用最早恢复的 Key 兜底
- 某 Key 成功调用后其冷却期清零（立即恢复参与轮询），直到下次 429 再重新计冷却
- 可按 Key 单独设置冷却：`lbCooldowns: [30, 120]`（与 lbKeys 一一对应；JSON 或添加时用 `--lb-cooldowns "30,120"`，缺失项回退 `lbCooldown`）
- `list` 显示活跃 Key 数与模式：`3 Key（2 活跃 / 60s 冷却 / roundrobin）`，并逐个列出 Key 状态（API Key 已脱敏为 `sk-abcd...1234`）
- 单 key 模式完全向后兼容（`apiKey` 字符串）

#### 页脚状态栏

当前 provider 的 Key 池状态常驻显示在 pi 页脚，每秒刷新：

```
CLINE(S) ##@###                          6 Key 全可用，当前请求在用 #3
CLINE(S) X#@### [==--------] 47m10s      #1 冷却中，进度条为其冷却进度
CLINE(S) XX@### [==--------] 47m10s      挂 2 个，倒计时跟最快恢复的那个
! CLINE(S) XXXXXX [========--] 11m59s    全池冷却，"!" 提示已无可用 Key
OPENROUTER(R) X#X@ [=---------] 59s      roundrobin 下冷却位置可能不相邻
```

- 名称后缀标出调度模式：`(S)` sticky / `(R)` roundrobin
- 点阵每字符对应一个 Key：`@` 当前请求正在使用 / `#` 可用 / `X` 冷却中；Key 超过 12 个退化为计数（`4/20`）
- 进度条是最快恢复的那个 Key 的冷却进度，末尾为其精确剩余时间
- 只显示当前选中模型所属 provider 的池，切模型自动跟随；当前 provider 未配置负载均衡时不占用页脚

#### 冷却状态持久化

冷却状态落盘至 `~/.pi/agent/lb-cooldowns.json`，`/clear`、`/fork` 与重启 pi 后自动恢复，避免把仍在冷却的 Key 再撞一遍 429。文件中只保存 Key 的 sha256 指纹，不含明文凭证；已过期的冷却在重建 Key 池时直接丢弃。

### 代理配置（每个 provider 独立）

每个 provider 可以独立配置代理，互不干扰：

```bash
# 不配置 proxy → 继承 process.env 的 HTTPS_PROXY 等环境变量（默认行为）
/custom-provider add local --base-url http://localhost:8080/v1 --models llama-3

# 指定代理地址 → 该 provider 走指定代理
/custom-provider add overseas --base-url https://api.openai.com/v1 \
    --api-key $OPENAI_KEY --models gpt-4 --proxy http://127.0.0.1:7890

# 明确禁用代理 → 覆盖环境变量，该 provider 不走代理
/custom-provider add cn-api --base-url https://api.deepseek.com/v1 \
    --api-key $DEEPSEEK_KEY --models deepseek-chat --proxy disable

# 从环境变量读取代理地址
/custom-provider add flexible --base-url https://api.example.com/v1 \
    --api-key $KEY --models model-x --proxy '$MY_PROXY_URL'
```

**工作原理**：

- 代理配置通过 pi-ai SDK 的 `env` 字段传递，每个请求独立设置
- 支持 `http://` 和 `https://` 协议（不支持 SOCKS，pi-ai SDK 限制）
- `proxy: "disable"` 会在请求中设置 `NO_PROXY=*`，强制不走代理
- 不配置时，SDK 读取 `process.env` 的 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`

**JSON 配置示例**：

```json
{
  "providers": [
    {
      "name": "overseas",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "$OPENAI_KEY",
      "proxy": "http://127.0.0.1:7890",
      "models": ["gpt-4"]
    },
    {
      "name": "local",
      "baseUrl": "http://localhost:8080/v1",
      "apiKey": "local",
      "proxy": "disable",
      "models": ["llama-3"]
    }
  ]
}
```

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
      "proxy": "http://127.0.0.1:7890",  // 可选：代理（URL / "disable" / 不配置=继承环境变量）
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
