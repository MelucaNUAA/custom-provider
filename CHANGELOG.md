# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.13] - 2026-09-02

### ✨ Added

- **页脚状态栏实时显示 Key 池状态**：负载均衡的冷却状态过去只能靠 `/custom-provider list` 手动查，现在常驻显示在 pi 页脚，每秒刷新

```
CLINE(S) ##@###                          6 Key 全可用，当前请求在用 #3
CLINE(S) X#@### [==--------] 47m10s      #1 冷却中，进度条为其冷却进度
CLINE(S) XX@### [==--------] 47m10s      挂 2 个，倒计时跟最快恢复的那个
! CLINE(S) XXXXXX [========--] 11m59s    全池冷却，"!" 提示已无可用 Key
```

  - 名称后缀标出调度模式：`(S)` sticky / `(R)` roundrobin
  - 点阵每字符对应一个 Key：`@` 当前请求正在使用 / `#` 可用 / `X` 冷却中；Key 超过 12 个退化为计数
  - 进度条是最快恢复的那个 Key 的冷却进度，末尾为其精确剩余时间（`47s` / `2m03s` / `1h05m`）
  - 只显示当前选中模型所属 provider 的池，切模型（`/model`、`Ctrl+P`、会话恢复）自动跟随
  - 当前 provider 未配置负载均衡时不占用页脚

- **429 冷却状态持久化**：冷却状态过去纯内存保存，`/clear`、`/fork` 或重启 pi 后全部丢失，导致池子误以为所有 Key 都新鲜、把仍在冷却的 Key 再撞一遍 429（对小时级冷却代价尤其大）
  - 落盘至 `~/.pi/agent/lb-cooldowns.json`，仅在 429 时写入
  - 磁盘上只保存 Key 的 sha256 指纹（前 12 位），不含任何明文凭证片段
  - 重建 Key 池时按指纹恢复，已过期的冷却直接丢弃

### 🔒 Security

- **API Key 脱敏**：`list` / `config` / `test` 过去会完整打印明文 API Key，截图或粘贴日志时会泄漏凭证。现在统一显示为 `sk-abcd...1234`（首 7 位 + 末 4 位）

### 🐛 Fixed

- 429 日志的 Key 编号由 0-based 改为 1-based，与 `list` 展示的 `#1` / `#2` 对齐；同时补充冷却结束时刻

---

## [0.1.12] - 2026-09-01

### ✨ Added

- **新增 sticky 调度模式**：负载均衡现在支持两种 Key 调度模式（`lbMode`）：
  - `roundrobin`（默认）：每个请求按序轮询下一个可用 Key，平摊请求
  - `sticky`：粘住一个 Key 使用，直到它触发 429 进入冷却才切换到下一个可用 Key；该 Key 成功调用后冷却清零但仍保持粘住（不回切）
  - 可通过 JSON `lbMode: "sticky"`、命令 `--lb-mode sticky` 或交互向导选择
  - `list` / `config` 的负载均衡行会显示当前模式

---

## [0.1.11] - 2026-09-01

### ✨ Added

- **查看单个 Key 冷却状态**：`list` / `config` / `test` 命令现在展示每个 API Key 的详细状态
  - 未冷却：`可用（未冷却）`
  - 冷却中：`冷却中 → HH:MM:SS（剩余 hh:mm:ss）`，即该 Key 的 `cooldownEnd`（冷却结束的确切时刻与剩余时长）

例如运行 `/custom-provider list`：

```
负载均衡: 3 Key（2 活跃 / 86400s 冷却）
      #1 sk-AAA：冷却中 → 11:57:40（剩余 24:00:00）
      #2 sk-BBB：冷却中 → 11:58:40（剩余 00:01:00）
      #3 sk-CCC：可用（未冷却）
```

`cooldownEnd` 就是每行“冷却中 → ”后的时刻（该 Key 冷却结束、重新进入轮询池的时间）。

---

## [0.1.10] - 2026-09-01

### ✨ Added

- **负载均衡 429 冷却重写**：多 API Key 冷却期语义修正
  - 触发 429 后该 Key 进入固定时长冷却（`lbCooldown`，下限 60 秒），不做指数放大/退避
  - 冷却期内该 Key **绝不参与轮询**，冷却期结束后自动重新进入轮询池
  - 仍有任一未冷却 Key 时只从可用 Key 中轮询；全部 Key 都 429 冷却时才强行使用最早恢复的 Key 兜底
  - 某 Key 成功调用后其冷却期清零（立即恢复参与轮询），直到下次 429 重新计冷却
  - 新增按 Key 独立冷却配置 `lbCooldowns: [30, 120]`（与 `lbKeys` 一一对应），缺失项回退 `lbCooldown`

### 🐛 Fixed

- **429 检测通路修复**（关键）：此前 `after_provider_response` 只在 2xx 流开始时触发，SDK 对 429 直接抛错导致冷却逻辑实际从未生效；新增 `message_end` 从错误消息（errorMessage 含 429/rate limit 等）识别限流并关联到对应 Key
- **`pick()` 竞态/语义修复**：移除自旋锁 `picking` 造成的并发 null 与占位符 Key 泄漏；全部冷却时不再返回冷却中的 Key
- 移除旧的 30s 等待上限（`waitForAvailable`），全部冷却时直接立即使用最早恢复 Key，避免请求长时间挂起

---

## [0.1.5] - 2026-08-28

### 🔒 Security

- **[CRITICAL]** Removed `!command` execution feature to prevent command injection vulnerabilities
- **[CRITICAL]** Strengthened HTTP header validation to prevent header injection attacks (removed tab character support)
- **[CRITICAL]** Fixed race conditions in load balancer key pool (concurrent requests now safe)

### ✨ Added

- Per-provider proxy configuration (replaces global proxy setting)
  - Support for three modes: inherit env vars / specify URL / explicit disable
  - Each provider's proxy is isolated, no interference
  - Works through `payload.env` injection, no global side effects
- Warning logs when environment variables are undefined or empty
- Detailed error messages for JSON parsing failures
- Version field in spec cache for future migration support

### 🔧 Changed

- **[BREAKING]** `!command` feature disabled (use environment variables instead)
- **[BREAKING]** Global `proxyUrl` config deprecated (use per-provider `proxy` instead)
- HTTP header values now strictly limited to visible ASCII characters
- `LBKeyPool.pick()` now returns `{key, index}` instead of just key
- Improved cache loading/saving with detailed logs
- Enhanced error handling throughout codebase

### 🐛 Fixed

- Resource leak in `httpGet()` - event listeners now properly cleaned up on timeout
- Race condition in load balancer causing wrong keys to be marked as cooling down
- Global state pollution from `lastUsedPool`/`lastUsedKeyIdx` variables
- Silent failures when JSON config files are corrupted

### 🔨 Refactored

- Extracted `parseModelListResponse()` to eliminate code duplication
- Unified model list parsing across multiple endpoints
- Improved logging consistency and clarity

### 📚 Documentation

- Added `SECURITY-FIXES.md` with detailed security fix explanations
- Added `CHANGELOG-proxy.md` for proxy configuration migration guide
- Added `example-proxy-setup.md` with real-world proxy setup scenarios
- Added `REVIEW-SUMMARY.md` with full code review results
- Updated `README.md` with security update notice and proxy documentation

### 🔄 Migration Guide

#### Command Execution Removal

```bash
# Old (insecure, no longer works)
"apiKey": "!cat ~/.secrets/api-key"

# New (recommended)
export MY_API_KEY=$(cat ~/.secrets/api-key)
"apiKey": "$MY_API_KEY"
```

#### Proxy Configuration

```bash
# Old (global proxy)
{
  "proxyUrl": "http://127.0.0.1:7890",
  "providers": [
    {"name": "a", "proxy": "enable"}
  ]
}

# New (per-provider)
{
  "providers": [
    {"name": "a", "proxy": "http://127.0.0.1:7890"}
  ]
}
```

## [0.1.4] - 2026-08-XX

### Added

- Initial release with core functionality
- Multi-protocol support (OpenAI / Anthropic / Google)
- Load balancing with multiple API keys
- Request header templates
- Model spec caching from OpenRouter

---

## Links

- [npm package](https://www.npmjs.com/package/custom-provider-pi)
- [GitHub issues](https://github.com/yourusername/custom-provider-pi/issues)
