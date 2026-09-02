import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import https from "https";
import http from "http";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "custom-providers.json");
const SPEC_CACHE_PATH = join(homedir(), ".pi", "agent", "model-specs-cache.json");
// LB 429 冷却状态落盘路径：冷却纯内存会在 /clear、/fork、重启后丢失，
// 导致池子误以为所有 Key 都新鲜、挨个再撞一遍 429（对小时级冷却代价很大）
const LB_COOLDOWN_PATH = join(homedir(), ".pi", "agent", "lb-cooldowns.json");

// 远程规格缓存有效期（毫秒）：24 小时
const SPEC_CACHE_TTL = 24 * 60 * 60 * 1000;
// OpenRouter 公开模型目录（含各模型真实 context_length / max_completion_tokens，无需 key）
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

// 默认浏览器 UA：部分中转/反代服务（如 Cloudflare WAF）会按 User-Agent 指纹拦截
// SDK 请求（OpenAI/JS、Anthropic/JS 等）。未显式配置 UA 时默认使用浏览器 UA 规避。
// 官方 API（OpenAI/Anthropic/DeepSeek 等）不校验 UA，此默认值对其无副作用。
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// 预设 User-Agent：部分中转/反代服务会按 UA 指纹拦截非浏览器/SDK 请求。
// 版本号取各 CLI/工具当前最新稳定版（2026-08 查询），反代一般只校验前缀关键字。
const UA_PRESETS: Record<string, string> = {
  "browser": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  // 真实 Claude Code 发送格式为 claude-code/<版本>（无后缀）
  "claude-code": "claude-code/2.1.237",
  "codex": "codex_cli_rs/0.148.0 (cli)",
  "opencode": "opencode/1.18.19",
  "cursor": "Cursor/3.16.0 (Windows; 64bit)",
  "windsurf": "Windsurf/2.0.0 (Windows)",
  "openwebui": "OpenWebUI/0.11.0",
  "chatgpt": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 ChatGPT-Desktop/1.2025.0",
};

// 请求头模板（借鉴 LiveAgent：按客户端/CLI 预设整组请求头，而非只预设 UA）：
// 不同客户端携带的头集合不同（Claude Code 有 x-app/anthropic-version/X-Stainless-* 等）。
// Apply template headers; or select"custom"逐头输入。
interface HeaderPreset {
  label: string;
  key?: string; // undefined = custom
  headers: Record<string, string>;
}
const HEADER_PRESETS: HeaderPreset[] = [
  { label: "浏览器（默认，仅 UA）", key: "browser", headers: { "User-Agent": UA_PRESETS.browser } },
  {
    label: "Claude Code CLI",
    key: "claude-code",
    headers: {
      "User-Agent": UA_PRESETS["claude-code"],
      "x-app": "cli",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
    },
  },
  {
    label: "Codex CLI",
    key: "codex",
    headers: { "User-Agent": UA_PRESETS.codex, "accept": "application/json" },
  },
  { label: "OpenCode CLI", key: "opencode", headers: { "User-Agent": UA_PRESETS.opencode } },
  { label: "Cursor IDE", key: "cursor", headers: { "User-Agent": UA_PRESETS.cursor } },
  { label: "Windsurf IDE", key: "windsurf", headers: { "User-Agent": UA_PRESETS.windsurf } },
  {
    label: "OpenWebUI",
    key: "openwebui",
    headers: { "User-Agent": UA_PRESETS.openwebui, "accept": "application/json" },
  },
  { label: "ChatGPT Desktop", key: "chatgpt", headers: { "User-Agent": UA_PRESETS.chatgpt } },
  { label: "custom（逐头输入）", key: undefined, headers: {} },
];

// 头名校验：HTTP token 字符集（含 ASCII 特殊符号，无空格/换行）
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// 头值严格校验：仅允许可见 ASCII，拒绝所有控制字符（包括制表符）防止注入
const HEADER_VALUE_RE = /^[\x20-\x7e]*$/;
// 设置这些头可能覆盖认证/协议逻辑：允许但给予提示
const SENSITIVE_HEADER_HINTS = ["authorization", "x-api-key", "x-goog-api-key", "anthropic-beta", "host", "content-length"];

// 合法的 provider 名称：小写字母/数字/中划线/下划线，长度 1-32
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) return false;
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

// ---- 远程规格查询（OpenRouter 公开目录，带磁盘缓存）----

// 输出上限处置（借鉴 LiveAgent normalizeModelLimits）
// Community catalogs may provide degraded values for models"output==window"，
// 照单全收会把"window-output-reserve"的输入预算挤成零。处理：钳到保守上限，
// 并保底留 3/4 窗口给输入。
const MAX_OUTPUT_TOKEN_CAP = 32000;

function normalizeModelLimits(ctx: number, out: number): { contextWindow: number; maxTokens: number } {
  if (ctx <= 0) return { contextWindow: ctx, maxTokens: out };
  if (out < ctx) return { contextWindow: ctx, maxTokens: out };
  return {
    contextWindow: ctx,
    maxTokens: Math.min(MAX_OUTPUT_TOKEN_CAP, Math.max(1, Math.floor(ctx / 4))),
  };
}

// 长上下文后缀约定：部分中转用 [1m] 标记模型为 1M 长上下文形态
function hasLongContextSuffix(modelId: string): boolean {
  return /\[1m\]$/i.test(modelId.trim());
}

// 官方 Anthropic/Vertex/Bedrock 端点不支持 1M 上下文（1M 仅第三方中转可用）
function isOfficialAnthropicEndpoint(baseUrl: string | undefined): boolean {
  const lower = (baseUrl ?? "").toLowerCase();
  return (
    lower.includes("api.anthropic.com") ||
    lower.includes("aiplatform.googleapis.com") ||
    lower.includes("vertexai.googleapis.com") ||
    lower.includes("amazonaws.com")
  );
}

// 按协议/API 类型的未知模型兜底限额（借鉴 LiveAgent PROVIDER_FALLBACK_LIMITS）
const PROVIDER_FALLBACK: Record<string, { contextWindow: number; maxTokens: number }> = {
  "anthropic-messages": { contextWindow: 200000, maxTokens: 32000 },
  "google-generative-ai": { contextWindow: 1048576, maxTokens: 65536 },
  "openai-completions": { contextWindow: 258000, maxTokens: 32000 },
  "openai-responses": { contextWindow: 258000, maxTokens: 32000 },
};
const FALLBACK_DEFAULT: { contextWindow: number; maxTokens: number } = {
  contextWindow: 128000,
  maxTokens: 32000,
};

// 远程规格表：normalize 后的模型 id -> { contextWindow, maxTokens }
let remoteSpecStore: Map<string, { contextWindow: number; maxTokens: number }> | null = null;

// 归一化候选链（借鉴 LiveAgent normalizeModelIdCandidates）：
// 原始 id → 小写 → 去 @版本 → 去 [1m] 后缀 → 去日期段 → 去变体词 → 剥路径前缀。
// 候选链让目录命中覆盖中转常见的装饰：bailian/deepseek-v4-pro、xxx@20250601、xxx[1m] 等。
function normalizeModelIdCandidates(modelId: string): string[] {
  const candidates: string[] = [];
  const push = (v: string) => {
    if (v && !candidates.includes(v)) candidates.push(v);
  };
  const raw = modelId.trim();
  push(raw);
  const lower = raw.toLowerCase();
  push(lower);
  const withoutAt = lower.split("@")[0];
  push(withoutAt);
  const withoutSuffix = withoutAt.replace(/\[1m\]$/i, "");
  push(withoutSuffix);
  push(withoutSuffix.replace(/-20\d{6}$/, "")); // 日期段 -20250601
  push(withoutSuffix.replace(/-\d{2,9}$/, "")); // 日期/序号 -0731
  push(
    withoutSuffix.replace(
      /-(?:latest|recent|free|preview|stable|thinking|reasoning|turbo|hi|highspeed|dev|beta|auto|labs)$/,
      ""
    )
  );
  // 路径前缀（bailian/x → x）放链尾：所有精确形态查空后才剥前缀
  const lastSegment = withoutSuffix.split("/").pop() ?? "";
  if (lastSegment && lastSegment !== withoutSuffix) {
    push(lastSegment);
    push(lastSegment.replace(/-20\d{6}$/, ""));
  }
  return candidates;
}

// 将 OpenRouter 模型目录灌入远程规格表（同 id 多条时取更大上下文）
function ingestRemoteModels(data: any[]): void {
  if (!remoteSpecStore) remoteSpecStore = new Map();
  for (const m of data) {
    const ctx = m.context_length;
    // 部分模型未公布 max_completion_tokens（如 grok-4.5），给保守默认避免整条被跳过
    const rawOut = (m.top_provider?.max_completion_tokens ?? m.max_completion_tokens) ?? 131072;
    if (!ctx) continue;
    // 入库即卫生化：输出吃满窗口的退化数据钳到保守上限，避免输入预算被挤成零
    const limited = normalizeModelLimits(Number(ctx), rawOut);
    const key = normalizeModelIdCandidates(m.id)[4] ?? m.id.toLowerCase(); // 去 @ 与 [1m] 后的规范形
    const prev = remoteSpecStore.get(key);
    if (
      !prev ||
      limited.contextWindow > prev.contextWindow ||
      (limited.contextWindow === prev.contextWindow && limited.maxTokens > prev.maxTokens)
    ) {
      remoteSpecStore.set(key, limited);
    }
  }
}

function loadSpecCache(): void {
  try {
    if (!existsSync(SPEC_CACHE_PATH)) return;
    const raw = JSON.parse(readFileSync(SPEC_CACHE_PATH, "utf8"));
    const fetchedAt = raw.fetchedAt || 0;
    if (Date.now() - fetchedAt > SPEC_CACHE_TTL) {
      console.log(`[custom-provider] 规格缓存已过期（>24h），将后台刷新`);
      return;
    }
    if (!Array.isArray(raw.specs)) {
      console.warn(`[custom-provider] 规格缓存格式错误，已忽略`);
      return;
    }
    remoteSpecStore = new Map(raw.specs);
    console.log(`[custom-provider] 加载规格缓存: ${remoteSpecStore.size} 个模型`);
  } catch (error) {
    console.warn(`[custom-provider] 读取规格缓存失败，将使用预设降级:`, error instanceof Error ? error.message : String(error));
    remoteSpecStore = null;
  }
}

function saveSpecCache(): void {
  try {
    if (!remoteSpecStore) return;
    const cacheData = {
      fetchedAt: Date.now(),
      specs: [...remoteSpecStore.entries()],
      version: 1, // 添加版本号，便于未来迁移
    };
    writeFileSync(SPEC_CACHE_PATH, JSON.stringify(cacheData), "utf8");
    console.log(`[custom-provider] 保存规格缓存: ${remoteSpecStore.size} 个模型`);
  } catch (error) {
    console.warn(`[custom-provider] 保存规格缓存失败:`, error instanceof Error ? error.message : String(error));
  }
}

// 从 OpenRouter 拉取模型目录并刷新本地规格表；失败静默降级（不影响已有配置/预设）
async function refreshRemoteSpecs(): Promise<void> {
  try {
    // 模型目录较大（~700KB），放宽超时到 30s；后台异步执行不阻塞启动
    const json = await httpGet(OPENROUTER_MODELS_URL, undefined, undefined, 30000);
    if (!json?.data || !Array.isArray(json.data)) throw new Error("OpenRouter 响应格式异常");
    ingestRemoteModels(json.data);
    saveSpecCache();
  } catch (error) {
    console.error(
      `[custom-provider] 拉取模型规格失败（使用缓存/预设降级）: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

// 查询模型规格：远程实时表 → 本地已知预设 → undefined
function lookupModelSpec(modelId: string): { contextWindow: number; maxTokens: number; vision?: boolean } | undefined {
  if (remoteSpecStore && remoteSpecStore.size > 0) {
    // 候选链逐形态命中：deepseek-v4-flash-free → deepseek-v4-flash → deepseek-v4 …
    for (const candidate of normalizeModelIdCandidates(modelId)) {
      const hit = remoteSpecStore.get(candidate);
      if (hit) return hit;
      // 渐进去尾段（- 连接）：最后一个候选之后逐步剥段
      let probe = candidate;
      for (let i = 0; i < 6 && probe; i++) {
        const idx = probe.lastIndexOf("-");
        if (idx <= 0) break;
        probe = probe.slice(0, idx);
        const h = remoteSpecStore.get(probe);
        if (h) return h;
      }
    }
  }
  return getKnownSpec(modelId);
}

// ---- 本地已知规格预设（离线兜底；远程规格优先于它）----
const KNOWN_SPECS: Record<string, { contextWindow: number; maxTokens: number }> = {
  // DeepSeek V4（1M 上下文为输入+输出共享预算）
  "deepseek-v4-flash": { contextWindow: 1000000, maxTokens: 384000 },
  "deepseek-v4-pro": { contextWindow: 1000000, maxTokens: 384000 },
  // 智谱 GLM-5 系列
  "glm-5": { contextWindow: 200000, maxTokens: 131072 },
  "glm-5.1": { contextWindow: 200000, maxTokens: 131072 },
  "glm-5.2": { contextWindow: 200000, maxTokens: 131072 },
  "glm-5.3": { contextWindow: 200000, maxTokens: 131072 },
  // xAI Grok（4.5/4.6 输出上限未官宣，取 128K 保守值）
  "grok-4.5": { contextWindow: 500000, maxTokens: 131072 },
  "grok-4.6": { contextWindow: 500000, maxTokens: 131072 },
  // 腾讯混元 Hy3
  "hy3": { contextWindow: 256000, maxTokens: 131072 },
  "hy3-preview": { contextWindow: 256000, maxTokens: 131072 },
  // MiniMax M2.x 系列（官方未公布超大上下文，保守 256K）
  "mimo-v2": { contextWindow: 262144, maxTokens: 65536 },
  "mimo-v2.1": { contextWindow: 262144, maxTokens: 65536 },
  "mimo-v2.5": { contextWindow: 262144, maxTokens: 65536 },
  "minimax-m2": { contextWindow: 262144, maxTokens: 65536 },
};

function getKnownSpec(modelId: string): { contextWindow: number; maxTokens: number } | undefined {
  const candidates = normalizeModelIdCandidates(modelId);
  for (const c of candidates) {
    if (KNOWN_SPECS[c]) return KNOWN_SPECS[c];
  }
  // 前缀匹配兜底（deepseek-v4-flash-free → deepseek-v4-flash）
  const key = Object.keys(KNOWN_SPECS).find((k) =>
    candidates.some((c) => c === k || c.startsWith(k + "-") || c.startsWith(k + "_") || c.startsWith(k + ":"))
  );
  return key ? KNOWN_SPECS[key] : undefined;
}

interface IModel {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  headers?: Record<string, string>;
  compat?: Record<string, any>;
}

interface IProvider {
  name: string;
  baseUrl: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: Record<string, any>;
  /** 代理配置：
   * - "disable": 明确不走代理（覆盖全局环境变量）
   * - "http://host:port" 或 "https://host:port": 该 provider 走指定代理
   * - 不配置: 继承 process.env 的 HTTPS_PROXY 等环境变量（默认行为）
   * - 支持 $ENV 引用和 !cmd 执行
   */
  proxy?: "disable" | string;
  /** 多 Key 负载均衡：逗号分隔的 API Key 列表（支持 $ENV / !cmd 引用） */
  lbKeys?: string[];
  /** 负载均衡默认冷却时间（秒），不填默认 60 */
  lbCooldown?: number;
  /** 负载均衡按 Key 冷却时间（秒），与 lbKeys 一一对应，不填用 lbCooldown */
  lbCooldowns?: number[];
  /**
   * 负载均衡 Key 调度模式：
   * - "roundrobin"（默认）：每个请求轮询下一个可用 Key
   * - "sticky"：粘住当前 Key 使用，直到它 429 进入冷却才切换到下一个可用 Key
   */
  lbMode?: "roundrobin" | "sticky";
  /** false 表示已禁用（不注册、不出现在 /model）；缺失视为启用 */
  enabled?: boolean;
  models: (string | IModel)[];
}

interface IConfig {
  providers: IProvider[];
  /** 已废弃：改用 provider 级的 proxy 参数直接指定代理 URL */
  proxyUrl?: string;
}

function loadConfig(): IConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return { providers: [] };
    const raw = readFileSync(CONFIG_PATH, "utf8");
    if (!raw.trim()) {
      console.warn(`[custom-provider] 配置文件为空: ${CONFIG_PATH}`);
      return { providers: [] };
    }
    const config = JSON.parse(raw) as IConfig;
    if (!config || typeof config !== "object" || !Array.isArray(config.providers)) {
      console.error(`[custom-provider] 配置文件格式错误: ${CONFIG_PATH}，期望 {providers: [...]}）`);
      return { providers: [] };
    }
    return config;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error(`[custom-provider] 配置文件 JSON 解析失败: ${CONFIG_PATH}`);
      console.error(`  错误: ${error.message}`);
      console.error(`  请检查 JSON 格式是否正确，或删除该文件重新配置`);
    } else {
      console.error(`[custom-provider] 读取配置文件失败: ${CONFIG_PATH}`, error);
    }
    return { providers: [] };
  }
}

function saveConfig(config: IConfig): void {
  try {
    const dir = join(homedir(), ".pi", "agent");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  } catch (error) {
    throw new Error(`保存配置失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveValue(raw: string | undefined): string {
  if (!raw) return "local";

  // 环境变量插值: $VAR 或 ${VAR}
  if (raw.startsWith("$")) {
    const varName = raw.startsWith("${") && raw.endsWith("}")
      ? raw.slice(2, -1)
      : raw.slice(1);
    const value = process.env[varName];
    if (!value) {
      console.warn(`[custom-provider] 环境变量 ${varName} 未设置或为空`);
      return "";
    }
    return value;
  }

  // 命令执行: !command（已禁用，安全风险过高）
  // 保留此代码块仅用于向后兼容性说明，实际不执行
  if (raw.startsWith("!")) {
    console.error(`[custom-provider] 命令执行已禁用（安全风险）: ${raw}`);
    console.error(`[custom-provider] 请改用环境变量: export MY_VAR=$(${raw.slice(1)})`);
    return "";
  }

  return raw;
}

// 仅用于探测请求（如拉取模型列表）时获取真实值；存储与注册保留原始 $VAR/!cmd 引用，
// 交由 pi 在每次请求时动态解析，环境变量变更可即时生效。
function resolveHeaders(headers?: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    resolved[key] = resolveValue(value);
  }
  return resolved;
}

function inferApi(baseUrl: string, explicitApi?: string): string {
  if (explicitApi) return explicitApi;

  const lower = baseUrl.toLowerCase();
  if (lower.includes("generativelanguage") || lower.includes("generativeai")) {
    return "google-generative-ai";
  }
  if (lower.includes("anthropic")) {
    return "anthropic-messages";
  }
  return "openai-completions";
}

// 去掉 baseUrl 中用户可能粘贴的多余路径段，返回"规范根地址"（不含 /v1）
function stripBasePath(baseUrl: string): string {
  return baseUrl
    .replace(/\/+$/, "")
    .replace(/\/v1\/models\/?$/i, "")
    .replace(/\/chat\/completions\/?$/i, "")
    .replace(/\/models\/?$/i, "")
    .replace(/\/+$/, "");
}

function normalizeBaseUrl(baseUrl: string, api: string): string {
  const root = stripBasePath(baseUrl);

  // 已经包含版本号后缀（/v1、/v4、/v1beta 等）或特殊版本路径段 → 不再追加
  // 覆盖智谱 /api/paas/v4、Google /v1beta 等风格
  if (/\/v\d+(?:beta)?(?:\/|$)/i.test(root)) return root;

  switch (api) {
    case "openai-completions":
    case "openai-responses":
    case "anthropic-messages":
      return /\/v1$/i.test(root) ? root : `${root}/v1`;

    case "google-generative-ai":
      if (!/(\/v1|\/v1beta)(\/|$)/i.test(root)) return `${root}/v1`;
      return root;

    default:
      return root;
  }
}

function prepareModel(raw: string | IModel, provider: IProvider): ProviderModelConfig {
  const src = typeof raw === "string" ? { id: raw } : raw;
  if (!src.id) {
    throw new Error(`provider "${provider.name}" 下存在缺少 id 的模型`);
  }

  // 协议：模型级覆盖 > provider 级
  const modelApi = (src.api as string | undefined) ?? inferApi(provider.baseUrl, provider.api);
  const spec = lookupModelSpec(src.id);

  // 规格填充优先级：显式配置 > [1m] 长上下文规则 > 远程实时规格 > 本地预设 > 按协议兜底
  const hasExplicitCtx = src.contextWindow !== undefined;
  const hasExplicitMax = src.maxTokens !== undefined;
  let contextWindow: number | undefined = src.contextWindow;
  let maxTokens: number | undefined = src.maxTokens;

  if (!hasExplicitCtx) {
    if (hasLongContextSuffix(src.id)) {
      // [1m] 后缀：Anthropic 兼容中转的 1M 形态。
      // 官方端点（api.anthropic.com / Vertex / Bedrock）不支持 1M，钳回 200K
      contextWindow = isOfficialAnthropicEndpoint(provider.baseUrl)
        ? Math.min(spec?.contextWindow ?? 200000, 200000)
        : 1000000;
    } else {
      contextWindow = spec?.contextWindow ?? PROVIDER_FALLBACK[modelApi]?.contextWindow ?? FALLBACK_DEFAULT.contextWindow;
    }
  }
  if (!hasExplicitMax) {
    maxTokens = spec?.maxTokens ?? PROVIDER_FALLBACK[modelApi]?.maxTokens ?? FALLBACK_DEFAULT.maxTokens;
  }

  // 数据卫生：非显式的输出值若吃满/超过窗口（社区目录退化数据），
  // 舞到保守上限并保底留 3/4 窗口给输入，避免 pi 的上下文预算被挤成零。
  // 显式用户配置完全信任，不自动钳。
  if (!hasExplicitMax && maxTokens! >= contextWindow!) {
    const limited = normalizeModelLimits(contextWindow!, maxTokens!);
    contextWindow = limited.contextWindow;
    maxTokens = limited.maxTokens;
  }

  const model: ProviderModelConfig = {
    id: src.id,
    name: src.name ?? src.id,
    reasoning: src.reasoning ?? false,
    input: src.input ?? ["text", "image"],
    contextWindow: contextWindow!,
    maxTokens: maxTokens!,
    cost: {
      input: src.cost?.input ?? 0,
      output: src.cost?.output ?? 0,
      cacheRead: src.cost?.cacheRead ?? 0,
      cacheWrite: src.cost?.cacheWrite ?? 0,
    },
  };
  if (src.api) model.api = src.api as any;
  if (src.baseUrl) model.baseUrl = src.baseUrl;
  if (src.headers) model.headers = src.headers;
  if (src.compat) model.compat = src.compat as any;
  return model;
}

function buildProviderConfig(provider: IProvider): ProviderConfig {
  const api = inferApi(provider.baseUrl, provider.api);

  // 请求头原样透传（保留 $ENV / ${ENV} / !cmd 引用），pi 在每次请求时动态解析，
  // 避免把解析结果明文固化为死值。
  const providerHeaders: Record<string, string> = { ...(provider.headers ?? {}) };

  // WAF 指纹加固：未显式设置 User-Agent 时，默认补浏览器 UA
  if (!hasHeader(providerHeaders, "user-agent")) {
    providerHeaders["User-Agent"] = DEFAULT_USER_AGENT;
  }

  const providerConfig: ProviderConfig = {
    name: provider.name,
    baseUrl: provider.baseUrl,
    // LB 模式：apiKey 用占位符（SDK 生成 Bearer <placeholder>，before_provider_headers 替换）
    // LB 模式：apiKey 用第一个 key 的原始值作占位（保证 pi 鉴权检查通过，
    // before_provider_headers 会在发送前替换为轮询到的真实 key）
    apiKey: provider.lbKeys && provider.lbKeys.length > 0
      ? resolveValue(provider.lbKeys[0]) || "lb-pool"
      : (provider.apiKey ?? "local"),
    models: provider.models.map((m) => prepareModel(m, provider)),
  };

  // LB 模式：注入 X-LB-POOL 标记头（before_provider_headers 检测此标记识别 LB 请求）
  if (provider.lbKeys && provider.lbKeys.length > 0) {
    providerHeaders["X-LB-POOL"] = provider.name;
  }

  // 代理配置：注入 X-PROXY-CONFIG 标记头（before_provider_request 检测此标记注入 env）
  if (provider.proxy && typeof provider.proxy === "string") {
    providerHeaders["X-PROXY-CONFIG"] = provider.proxy;
  }

  if (Object.keys(providerHeaders).length > 0) {
    providerConfig.headers = providerHeaders;
  }

  // authHeader：LB 模式强制 true（保证 Authorization 头存在供 hook 覆盖）
  if (provider.lbKeys && provider.lbKeys.length > 0) {
    providerConfig.authHeader = true;
  } else if (provider.authHeader) {
    providerConfig.authHeader = true;
  }

  const baseCompat = provider.compat || {};
  providerConfig.models!.forEach((model) => {
    if (!model.api) model.api = api as any;
    if (!model.baseUrl) model.baseUrl = provider.baseUrl;
    if (!model.compat) model.compat = {};
    Object.assign(model.compat, baseCompat, model.compat);
  });

  return providerConfig;
}

async function fetchModels(
  baseUrl: string,
  apiKey: string,
  api: string,
  headers?: Record<string, string>
): Promise<string[]> {
  const cleanBase = stripBasePath(baseUrl);
  // 已包含版本段（/v1、/v4、/api/paas/v4）则不追加 /v1
  const hasVersion = /\/v\d+(?:beta)?(?:\/|$)/i.test(cleanBase);
  const v1Base = hasVersion ? cleanBase : `${cleanBase}/v1`;

  // 尝试多种端点路径
  const endpoints = api === "google-generative-ai"
    ? [`${v1Base}/models`]
    : [
        `${v1Base}/models`,     // 标准 /v1/models
        `${cleanBase}/models`,  // 已含版本或原始路径
        `${cleanBase}/v4/models`, // 智谱 /api/paas/v4 后追加
        `${cleanBase}/api/models`,
      ];

  // 按协议组装认证头：anthropic 用 x-api-key，google 用 x-goog-api-key，其余 Bearer
  const requestHeaders: Record<string, string> = { ...resolveHeaders(headers) };
  let bearerKey = apiKey;
  if (api === "anthropic-messages") {
    if (apiKey) requestHeaders["x-api-key"] = apiKey;
    requestHeaders["anthropic-version"] = "2023-06-01";
    bearerKey = "";
  } else if (api === "google-generative-ai") {
    if (apiKey) requestHeaders["x-goog-api-key"] = apiKey;
    bearerKey = "";
  }

  const attempts: string[] = [];

  for (const url of endpoints) {
    try {
      const json = await httpGet(url, bearerKey, requestHeaders);

      // 使用统一的解析函数
      const models = parseModelListResponse(json);

      if (models.length > 0) {
        return models;
      }
      attempts.push(`${url} -> 响应中未找到模型列表`);
    } catch (error) {
      attempts.push(`${url} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `拉取模型列表失败（已尝试 ${endpoints.length} 个端点）:\n${attempts.join("\n")}`
  );
}

function httpGet(
  url: string,
  apiKey?: string,
  extraHeaders?: Record<string, string>,
  timeoutMs = 10000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const lib = urlObj.protocol === "https:" ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        "Content-Type": "application/json",
        ...(extraHeaders ?? {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let data = "";
      const onData = (chunk: any) => (data += chunk);
      const onEnd = () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON 解析失败: ${e}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || "Unknown error"}`));
        }
      };

      res.on("data", onData);
      res.on("end", onEnd);

      // 清理：超时时移除事件监听器
      req.once("timeout", () => {
        res.removeListener("data", onData);
        res.removeListener("end", onEnd);
      });
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`请求超时（${timeoutMs}ms）`));
    });
    req.end();
  });
}

// 从响应中解析模型列表（支持多种格式）
function parseModelListResponse(json: any): string[] {
  let models: string[] = [];
  if (json.data && Array.isArray(json.data)) {
    models = json.data.map((m: any) => m.id || m.name).filter(Boolean);
  } else if (Array.isArray(json)) {
    models = json.map((m: any) => m.id || m.name || m).filter(Boolean);
  } else if (json.models && Array.isArray(json.models)) {
    models = json.models.map((m: any) => m.id || m.name || m).filter(Boolean);
  }
  return models;
}
async function probeEndpoint(
  url: string,
  apiKey?: string,
  headers?: Record<string, string>
): Promise<{ api: string; models: string[] } | null> {
  const base = url.replace(/\/+$/, "");
  const resolvedKey = apiKey ? resolveValue(apiKey) : "";

  // 按常见端点路径尝试（OpenAI 兼容最多，其次 Anthropic/Google）
  const attempts = [
    { ep: `${base}/v1/models`, api: "openai-completions" },
    { ep: `${base}/models`, api: "openai-completions" },
    { ep: `${base}/v4/models`, api: "openai-completions" }, // 智谱风格 /api/paas/v4
    { ep: `${base}/v1/models`, api: "anthropic-messages", useXApiKey: true },
  ];

  for (const { ep, api, useXApiKey } of attempts) {
    try {
      const authHeaders: Record<string, string> = {};
      if (useXApiKey && resolvedKey) {
        authHeaders["x-api-key"] = resolvedKey;
        authHeaders["anthropic-version"] = "2023-06-01";
      }
      const mergedHeaders = { ...resolveHeaders(headers), ...authHeaders };
      const json = await httpGet(ep, useXApiKey ? undefined : resolvedKey, Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined, 8000);
      // 使用统一的解析函数
      const models = parseModelListResponse(json);
      if (models.length > 0) return { api, models };
    } catch {
      continue;
    }
  }
  return null;
}

// ---- 名称校验 ----
function validateProviderName(name: string): string | null {
  if (!name) return "名称不能为空";
  if (name.length > 32) return "名称过长（最多 32 字符）";
  if (!NAME_RE.test(name)) {
    return "名称只能包含字母、数字、中划线、下划线，且不能以符号开头（如: deepseek, my-proxy, kimi_2）";
  }
  return null;
}

// 应用高级配置中的按模型覆盖（modelOverrides: { modelId: { reasoning, input, contextWindow, ... } }）
function applyModelOverrides(
  models: (string | IModel)[],
  overrides: Record<string, Partial<IModel>>
): (string | IModel)[] {
  return models.map((m) => {
    const id = typeof m === "string" ? m : m.id;
    const o = overrides?.[id];
    if (!o || typeof o !== "object") return m;
    if (typeof m === "string") return { id, ...o } as IModel;
    return { ...m, ...o };
  });
}

// ---- 命令行参数解析（/custom-provider 子命令 flags）----

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string[]>;
}

// 无需取值的布尔 flag
const BOOLEAN_FLAGS = new Set(["auth-header", "force", "yes"]);

function unquoteFlag(s: string): string {
  if (s.length >= 2) {
    const c = s[0];
    if ((c === '"' || c === "'") && s.endsWith(c)) return s.slice(1, -1);
  }
  return s;
}

// 解析 --key=value / --key value / 短 flag -f -y；引号包裹的值会被剥引号
function parseFlagArgs(args: string): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const tokens = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const addFlag = (key: string, value: string) => {
    const arr = flags.get(key) ?? [];
    arr.push(value);
    flags.set(key, arr);
  };
  const SHORT_ALIAS: Record<string, string> = { f: "force", y: "yes" };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq >= 0) {
        addFlag(tok.slice(2, eq).toLowerCase(), unquoteFlag(tok.slice(eq + 1)));
      } else {
        const key = tok.slice(2).toLowerCase();
        if (BOOLEAN_FLAGS.has(key)) {
          addFlag(key, "true");
        } else {
          const next = tokens[i + 1];
          if (next !== undefined && !next.startsWith("-")) {
            addFlag(key, unquoteFlag(next));
            i++;
          } else {
            addFlag(key, "true"); // 无值 flag 视为 true
          }
        }
      }
    } else if (/^-[a-z]$/i.test(tok)) {
      addFlag(SHORT_ALIAS[tok.slice(1).toLowerCase()] ?? tok.slice(1).toLowerCase(), "true");
    } else {
      positional.push(unquoteFlag(tok));
    }
  }
  return { positional, flags };
}

// 取 flag 的值：按名字顺序取第一个存在的，多值时取最后（后者覆盖前者）
function getFlag(flags: Map<string, string[]>, ...names: string[]): string | undefined {
  for (const n of names) {
    const arr = flags.get(n);
    if (arr && arr.length > 0) return arr[arr.length - 1];
  }
  return undefined;
}

export default function customProviderExtension(pi: ExtensionAPI) {
  const registerProviders = () => {
    const config = loadConfig();
    config.providers.forEach((provider) => {
      if (provider.enabled === false) return;
      try {
        const providerConfig = buildProviderConfig(provider);
        pi.registerProvider(provider.name, providerConfig);
      } catch (error) {
        console.error(`[custom-provider] 注册 provider "${provider.name}" 失败:`, error);
      }
    });
  };

  // 保存配置并注册 provider；注册失败时回滚磁盘配置，避免"文件已写入但运行态不一致"
  const persistProvider = (
    config: IConfig,
    provider: IProvider,
    ctx: { ui: { notify(m: string, t?: "info" | "warning" | "error"): void } }
  ): boolean => {
    const previous = JSON.parse(JSON.stringify(config.providers));
    const idx = findProviderIndex(config, provider.name);
    if (idx >= 0) {
      // 覆盖时保留原有禁用状态（除非新配置显式指定 enabled）
      if (config.providers[idx].enabled === false && provider.enabled === undefined) {
        provider.enabled = false;
      }
      config.providers[idx] = provider;
    } else {
      config.providers.push(provider);
    }

    try {
      saveConfig(config);
      loadLBPools(); // 同步刷新 LB key 池
    } catch (error) {
      ctx.ui.notify(`保存配置失败: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }

    try {
      const providerConfig = buildProviderConfig(provider);
      pi.registerProvider(provider.name, providerConfig);
      return true;
    } catch (error) {
      config.providers = previous;
      try {
        saveConfig(config);
      } catch {
        /* 回滚写失败时保留现状 */
      }
      ctx.ui.notify(
        `注册 provider "${provider.name}" 失败，已回滚保存: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error"
      );
      return false;
    }
  };

  // 大小写不敏感的 provider 查找（优先精确匹配）
  const findProviderIndex = (config: IConfig, name: string): number => {
    const exact = config.providers.findIndex((p) => p.name === name);
    if (exact >= 0) return exact;
    const lower = name.toLowerCase();
    return config.providers.findIndex((p) => p.name.toLowerCase() === lower);
  };

  // 非交互式添加：/add-provider '{"name":"...","baseUrl":"...","apiKey":"...",...}'
  const addProviderFromJson = (jsonText: string, ctx: any): boolean => {
    let data: any;
    try {
      data = JSON.parse(jsonText);
    } catch (error) {
      ctx.ui.notify(`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }

    const name = String(data.name ?? "").trim();
    const nameErr = validateProviderName(name);
    if (nameErr) {
      ctx.ui.notify(`名称无效: ${nameErr}`, "error");
      return false;
    }
    const baseUrl = String(data.baseUrl ?? "").trim();
    if (!baseUrl) {
      ctx.ui.notify("缺少必填字段 baseUrl", "error");
      return false;
    }
    const models: (string | IModel)[] = Array.isArray(data.models) ? data.models.filter(Boolean) : [];
    if (models.length === 0) {
      ctx.ui.notify("model 列表不能为空（models 需为数组）", "error");
      return false;
    }

    const provider: IProvider = {
      name,
      baseUrl,
      apiKey: data.apiKey !== undefined ? String(data.apiKey) : "local",
      models,
    };
    if (data.api) provider.api = String(data.api);
    // 统一 /v1 归一化（与交互路径一致），根据显式 api 或 URL 推断协议
    const apiForNormalize = provider.api ?? inferApi(provider.baseUrl);
    const normalized = normalizeBaseUrl(provider.baseUrl, apiForNormalize);
    if (normalized !== provider.baseUrl) {
      provider.baseUrl = normalized;
      console.log(`[custom-provider] 已自动调整端点: → ${normalized}`);
    }
    if (typeof data.authHeader === "boolean") provider.authHeader = data.authHeader;
    if (typeof data.proxy === "string" && data.proxy.trim()) {
      // 支持 "disable" 或直接指定代理 URL
      provider.proxy = data.proxy.trim();
    }
    if (typeof data.enabled === "boolean") provider.enabled = data.enabled;
    // 多 Key 负载均衡（JSON 路径）：lbKeys: ["$KEY_A","sk-plain"], lbCooldown: 30
    if (Array.isArray(data.lbKeys) && (data.lbKeys as string[]).length > 0) {
      provider.lbKeys = (data.lbKeys as string[]).map(String).filter(Boolean);
      if (typeof data.lbCooldown === "number" && data.lbCooldown > 0) {
        provider.lbCooldown = data.lbCooldown;
      }
      if (Array.isArray(data.lbCooldowns)) {
        provider.lbCooldowns = (data.lbCooldowns as unknown[]).map(Number);
      }
      if (data.lbMode === "roundrobin" || data.lbMode === "sticky") {
        provider.lbMode = data.lbMode;
      }
    }
    if (data.headers && typeof data.headers === "object") {
      // 与 flags/向导同一套校验：拒绝非法名称/值（含 CR/LF 注入）
      const bad = Object.entries(data.headers).find(([k, v]) => {
        const val = String(v);
        return !HEADER_NAME_RE.test(k) || !HEADER_VALUE_RE.test(val) || val === "";
      });
      if (bad) {
        ctx.ui.notify(`请求头 ${bad[0]} 名称或值含非法字符（不允许换行/非 ASCII/空值）`, "error");
        return false;
      }
      provider.headers = data.headers;
    }
    if (data.compat && typeof data.compat === "object") provider.compat = data.compat;

    const config = loadConfig();
    const ok = persistProvider(config, provider, ctx);
    if (ok) {
      const msg = `Provider "${name}" 已添加并注册，共 ${models.length} 个模型`;
      if (ctx.ui.notify) ctx.ui.notify(msg, "info");
      else console.log(`[custom-provider] ${msg}`);
    }
    return ok;
  };

  // 参数归一化：兼容字符串与数组两种调用形态
  const toArgText = (args: unknown): string =>
    Array.isArray(args) ? args.join(" ") : typeof args === "string" ? args : "";

  // 先读本地规格缓存并同步注册（离线也可用：缓存 → 预设 → 默认）
  loadSpecCache();
  registerProviders();

  // 后台拉取 OpenRouter 最新模型规格；成功后热更新注册，使配置立即使用真实规格
  refreshRemoteSpecs().then(() => {
    registerProviders();
  });

  // 监听 session_start 以支持热重载
  pi.on("session_start", (_event: any, ctx: any) => {
    registerProviders();
    loadLBPools();
    startLBStatus(ctx); // 启动页脚冷却倒计时
  });

  // 会话结束（含 /clear、/fork 触发的重建）：清理定时器与页脚残留
  pi.on("session_shutdown", () => {
    stopLBStatus();
  });

  // ================= 负载均衡（LBKeyPool）=================
  // 多 Key 轮询 + 429 自动冷却（默认 60s）
  // 通过 before_provider_headers 替换 Authorization / after_provider_response 冷却
  // 原理：LB 模式的 provider 在 headers 里注入 X-LB-POOL: <name> 标记头，
  // before_provider_headers 检测此标记 → 识别为 LB 请求 → 替换 Authorization

  // 429 / 限流错误识别（覆盖各家上游常见文案：429、rate limit、too many requests 等）
  const RATE_LIMIT_RE = /\b429\b|rate\s*limit|too\s+many\s+requests|resource\s*exhausted|quota\s*exceeded/i;

  const LB_BAR_WIDTH = 10;  // 状态栏冷却进度条格数
  const LB_DOTS_MAX = 12;   // Key 点阵最多渲染多少个，超过退化成计数
  // 点阵符号：全 ASCII，避免终端代码页差异导致方块或宽度错位
  const LB_DOT_CURRENT = "@"; // 当前请求正在使用的 Key
  const LB_DOT_READY = "#";   // 可用
  const LB_DOT_COOLING = "X"; // 冷却中

  // 毫秒拆成 时/分/秒
  const splitDuration = (ms: number): { h: number; m: number; s: number } => ({
    h: Math.floor(ms / 3600000),
    m: Math.floor((ms % 3600000) / 60000),
    s: Math.floor((ms % 60000) / 1000),
  });

  /** 完整格式 HH:MM:SS，用于 list / config / test 的详情行 */
  const formatHMS = (ms: number): string => {
    const { h, m, s } = splitDuration(ms);
    return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
  };

  /** 紧凑格式（47s / 2m03s / 1h05m），用于空间有限的页脚状态栏 */
  const formatCompact = (ms: number): string => {
    const { h, m, s } = splitDuration(ms);
    if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
    return `${s}s`;
  };

  /** Key 脱敏：list / config / test 只显示首尾，避免完整凭证被打到终端或截图里 */
  const maskKey = (key: string): string => {
    if (key.length <= 12) return `${key.slice(0, 2)}***`;
    return `${key.slice(0, 7)}...${key.slice(-4)}`;
  };

  /** Key 指纹：冷却状态落盘时用它做索引，磁盘上不出现任何明文凭证片段 */
  const keyFingerprint = (key: string): string =>
    createHash("sha256").update(key).digest("hex").slice(0, 12);

  /**
   * 读取落盘的冷却状态：{ [provider]: { [keyFingerprint]: 冷却结束时间戳 } }。
   * 文件损坏/不存在时返回空表 —— 冷却状态可再生，不值得因它中断启动。
   */
  const loadCooldownStore = (): Record<string, Record<string, number>> => {
    try {
      if (!existsSync(LB_COOLDOWN_PATH)) return {};
      const parsed = JSON.parse(readFileSync(LB_COOLDOWN_PATH, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return parsed as Record<string, Record<string, number>>;
    } catch {
      return {}; // 损坏就当没有，下次 429 会重新写入
    }
  };

  class LBKeyPool {
    keys: string[];           // 解析后的 key 值
    cooldownMs: number;       // 默认冷却毫秒
    cursor: number = 0;       // 轮询游标（roundrobin 用）
    cooldownEnd: number[];    // 每个 key 的冷却结束时间戳
    cooldownStart: number[];  // 每个 key 的冷却起始时间戳（仅用于状态栏进度条）
    perKeyCooldowns: (number | null | undefined)[]; // 每 key 的冷却覆盖
    mode: "roundrobin" | "sticky"; // 调度模式
    stickyIdx: number = -1;   // sticky 模式：当前粘住的 key 索引（-1 表示未定）
    lastUsedIdx: number = -1; // 最近一次请求实际选中的 key 索引（仅用于状态栏标记）

    constructor(keys: string[], defaultCooldownSec: number, perKey?: (number | null | undefined)[], mode?: "roundrobin" | "sticky") {
      this.keys = keys;
      this.cooldownMs = defaultCooldownSec * 1000;
      this.cooldownEnd = new Array(keys.length).fill(0);
      this.cooldownStart = new Array(keys.length).fill(0);
      this.perKeyCooldowns = perKey ?? [];
      this.mode = mode ?? "roundrobin";
    }

    /**
     * 调度选择 Key：
     * - roundrobin：每次从游标起取下一个未冷却 Key，平摊到所有 Key。
     * - sticky：粘住 stickyIdx 直到它 429 冷却，冷却后切换到下一个可用 Key 继续粘住。
     * 全部 Key 均冷却中时返回 null —— 绝不挑选冷却中的 Key。
     */
    pick(): { key: string; index: number } | null {
      const n = this.keys.length;
      const now = Date.now();
      if (this.mode === "sticky") {
        // 若当前粘住的 Key 可用，就一直用它
        if (this.stickyIdx >= 0 && this.stickyIdx < n && this.cooldownEnd[this.stickyIdx] <= now) {
          return { key: this.keys[this.stickyIdx], index: this.stickyIdx };
        }
        // 当前 Key 冷却中（或未定）：从它之后找下一个可用 Key，成为新的粘住目标
        const start = this.stickyIdx >= 0 ? this.stickyIdx + 1 : 0;
        for (let i = 0; i < n; i++) {
          const idx = (start + i) % n;
          if (this.cooldownEnd[idx] <= now) {
            this.stickyIdx = idx;
            return { key: this.keys[idx], index: idx };
          }
        }
        return null; // 全部冷却中
      }
      // roundrobin：从游标起取下一个未冷却 Key
      for (let i = 0; i < n; i++) {
        const idx = (this.cursor + i) % n;
        if (this.cooldownEnd[idx] <= now) {
          this.cursor = (idx + 1) % n; // 下次从下一个开始，天然轮询
          return { key: this.keys[idx], index: idx };
        }
      }
      return null; // 全部冷却中：冷却期内不参与轮询
    }

    /**
     * 全部 Key 都 429 冷却中时的兜底：强行使用最早恢复（冷却最快结束）的 Key。
     * 仅当没有其它可用 Key 时才启用，正常情况下不会被调用。
     */
    fallbackPick(): { key: string; index: number } {
      let bestIdx = 0;
      for (let i = 1; i < this.keys.length; i++) {
        if (this.cooldownEnd[i] < this.cooldownEnd[bestIdx]) bestIdx = i;
      }
      if (this.mode === "sticky") {
        this.stickyIdx = bestIdx;
      } else {
        this.cursor = (bestIdx + 1) % this.keys.length;
      }
      return { key: this.keys[bestIdx], index: bestIdx };
    }

    /**
     * 触发 429：该 Key 冷却固定为配置的时长（下限 60 秒），不做指数放大/退避。
     * 冷却期内该 Key 绝不参与轮询。
     */
    on429(idx: number): number {
      const base = this.perKeyCooldowns[idx] ?? this.cooldownMs;
      const cooldown = Math.max(base, 60_000); // 下限 60 秒
      const now = Date.now();
      this.cooldownStart[idx] = now;
      this.cooldownEnd[idx] = now + cooldown;
      return this.cooldownEnd[idx];
    }

    /** 该 Key 成功调用：冷却期清零（立即恢复参与轮询），下次 429 再重新计冷却 */
    onSuccess(idx: number): void {
      this.cooldownEnd[idx] = 0;
      this.cooldownStart[idx] = 0;
    }

    /** 从落盘状态恢复冷却（按 Key 指纹匹配，已过期的直接丢弃） */
    restore(saved: Record<string, number> | undefined): void {
      if (!saved) return;
      const now = Date.now();
      this.keys.forEach((k, i) => {
        const end = saved[keyFingerprint(k)];
        if (typeof end === "number" && end > now) {
          this.cooldownEnd[i] = end;
          // 起始时间未落盘，按默认冷却倒推，仅影响进度条观感
          this.cooldownStart[i] = end - (this.perKeyCooldowns[i] ?? this.cooldownMs);
        }
      });
    }

    /** 导出仍在冷却中的 Key，供落盘（磁盘上只有指纹，没有明文 Key） */
    snapshot(): Record<string, number> {
      const now = Date.now();
      const out: Record<string, number> = {};
      this.keys.forEach((k, i) => {
        if (this.cooldownEnd[i] > now) out[keyFingerprint(k)] = this.cooldownEnd[i];
      });
      return out;
    }

    activeCount(): number {
      const now = Date.now();
      return this.keys.filter((_, i) => this.cooldownEnd[i] <= now).length;
    }

    /**
     * 每个 key 的详细状态行：当前是否冷却中，及冷却结束的确切时间/剩余时长。
     * 用于 list / test 展示。returns lines like "13:05:22 (~58s)" 或 "可用"。
     */
    statusLines(): string[] {
      const now = Date.now();
      return this.keys.map((k, i) => {
        const end = this.cooldownEnd[i];
        if (end <= now) return `      #${i + 1} ${maskKey(k)}：可用（未冷却）`;
        const endTime = new Date(end);
        const hhEnd = String(endTime.getHours()).padStart(2, "0");
        const mmEnd = String(endTime.getMinutes()).padStart(2, "0");
        const ssEnd = String(endTime.getSeconds()).padStart(2, "0");
        return `      #${i + 1} ${maskKey(k)}：冷却中 -> ${hhEnd}:${mmEnd}:${ssEnd}（剩余 ${formatHMS(end - now)}）`;
      });
    }

    /**
     * 单行池状态，供页脚状态栏常驻显示。
     * provider 名后缀标出调度模式：'(S)' sticky / '(R)' roundrobin。
     * 点阵每字符对应一个 Key：'@' 当前请求正在用 / '#' 可用 / 'X' 冷却中。
     * 全部可用："CLINE(S) ##@###"
     * 有冷却："CLINE(S) X#@### [====------] 47s"，在点阵基础上追加：
     *   - 进度条是最快恢复的那个 Key 的冷却进度，'=' 已过去 / '-' 还剩
     *   - 末尾是该 Key 的精确剩余时间
     * 全部 Key 冷却时加 "!" 前缀 —— 此时轮询已无可用 Key，请求会硬撞 429。
     */
    poolStatus(name: string): string {
      const now = Date.now();
      const n = this.keys.length;
      const cooling: number[] = [];
      for (let i = 0; i < n; i++) {
        if (this.cooldownEnd[i] > now) cooling.push(i);
      }
      const label = `${name}${this.mode === "sticky" ? "(S)" : "(R)"}`;

      // Key 太多时点阵会撑爆状态栏，退化成计数
      const dots =
        n <= LB_DOTS_MAX
          ? this.keys
              .map((_, i) => {
                if (this.cooldownEnd[i] > now) return LB_DOT_COOLING;
                return i === this.lastUsedIdx ? LB_DOT_CURRENT : LB_DOT_READY;
              })
              .join("")
          : `${n - cooling.length}/${n}`;
      if (cooling.length === 0) return `${label} ${dots}`; // 全部可用，不显示进度条

      // 最快恢复的 Key：它决定了池子多久后重新可用
      const soonest = cooling.reduce((a, b) => (this.cooldownEnd[a] <= this.cooldownEnd[b] ? a : b));
      const end = this.cooldownEnd[soonest];
      const start = this.cooldownStart[soonest] || end - this.cooldownMs;
      const elapsed = Math.min(1, Math.max(0, (now - start) / Math.max(1, end - start)));
      const filled = Math.round(elapsed * LB_BAR_WIDTH);
      const bar = "=".repeat(filled) + "-".repeat(LB_BAR_WIDTH - filled);

      const alert = cooling.length === n ? "! " : ""; // 全池冷却，无 Key 可用
      return `${alert}${label} ${dots} [${bar}] ${formatCompact(end - now)}`;
    }
  }

  // 运行时 LB 状态：provider name → key pool
  let lbPools: Map<string, LBKeyPool> = new Map();
  // 请求-响应关联：model ID → { poolName, keyIdx }
  // after_provider_response 只能拿到上游响应，无法读取请求头，
  // 因此在 before_provider_headers 中将选中的 key 信息存入此 Map：
  //  - after_provider_response 通过 ctx.model.id 取回（HTTP 2xx 成功 / 裸 429 响应）
  //  - message_end 通过 event.message.model 取回（SDK 对 429 直接抛错、无响应事件，
  //    但错误会作为 assistant 消息结束，errorMessage 含 "429/rate limit" 等字样）
  const lbInflight: Map<string, { poolName: string; keyIdx: number; ts: number }> = new Map();

  function loadLBPools(): void {
    lbPools.clear();
    const config = loadConfig();
    const savedCooldowns = loadCooldownStore();
    for (const provider of config.providers) {
      if (provider.enabled === false) continue;
      // 优先从 IProvider.lbKeys 读取；兼容旧格式 compat.lb.keys
      const keys: string[] = provider.lbKeys ?? (provider.compat?.lb?.keys as string[] | undefined) ?? [];
      const defaultCooldown = provider.lbCooldown ?? (provider.compat?.lb?.cooldown as number | undefined) ?? 60;
      // 按 Key 冷却覆盖：与 lbKeys 一一对应；兼容旧格式 compat.lb.cooldowns
      const rawPerKey = provider.lbCooldowns ?? (provider.compat?.lb?.cooldowns as number[] | undefined);
      // 调度模式：默认 roundrobin，兼容旧格式 compat.lb.mode
      const lbMode: "roundrobin" | "sticky" =
        provider.lbMode ?? (provider.compat?.lb?.mode as "roundrobin" | "sticky" | undefined) ?? "roundrobin";
      if (keys.length > 0) {
        const resolved = keys.map(resolveValue);
        const keptIdx: number[] = [];
        const keptKeys: string[] = [];
        resolved.forEach((v, i) => {
          if (v) {
            keptKeys.push(v);
            keptIdx.push(i);
          }
        });
        if (keptKeys.length === 0) continue;
        // 按保留的 Key 对齐冷却数组（缺失/非法项回退默认冷却）
        const perKey: (number | null | undefined)[] | undefined = rawPerKey
          ? keptIdx.map((i) => {
              const c = rawPerKey[i];
              return typeof c === "number" && c > 0 ? c : null;
            })
          : undefined;
        const pool = new LBKeyPool(keptKeys, defaultCooldown, perKey, lbMode);
        // 恢复 /clear、/fork、重启前未走完的冷却，避免刚恢复就把冷却中的 Key 再撞一遍
        pool.restore(savedCooldowns[provider.name]);
        lbPools.set(provider.name, pool);
      }
    }
  }

  // 加载 LB 池 + 注册事件（启动时执行一次）
  loadLBPools();

  /**
   * 冷却状态落盘（仅在 429 时调用，频率很低）。
   * 落盘失败只告警不抛错：冷却状态可再生，不值得中断正在进行的请求。
   */
  const persistCooldowns = (): void => {
    try {
      const store: Record<string, Record<string, number>> = {};
      for (const [name, pool] of lbPools) {
        const snap = pool.snapshot();
        if (Object.keys(snap).length > 0) store[name] = snap;
      }
      const dir = join(homedir(), ".pi", "agent");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(LB_COOLDOWN_PATH, JSON.stringify(store, null, 2), "utf8");
    } catch (error) {
      console.warn(
        `[custom-provider] 冷却状态落盘失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // ================= 页脚状态栏：LB Key 池状态 =================
  // 429 冷却是纯内存状态，此前只能靠 /custom-provider list 手动查。
  // 这里每秒把当前 provider 的 Key 池状态刷到 pi 页脚（点阵 + 冷却倒计时）。

  const LB_STATUS_ID = "custom-provider-lb";
  let lbStatusTimer: ReturnType<typeof setInterval> | null = null;
  let lbStatusCtx: any = null;
  let lbStatusLast: string | undefined; // 上次写入的文本，用于跳过无变化的重绘
  let lbCurrentProvider: string | undefined; // 当前选中模型所属 provider（= 注册时的 provider.name）

  const renderLBStatus = (): void => {
    if (!lbStatusCtx) return;
    // 只显示当前选中模型所属 provider 的池：状态栏空间有限，
    // 其它 provider 的冷却与当下这次对话无关，查详情用 /custom-provider list
    const pool = lbCurrentProvider ? lbPools.get(lbCurrentProvider) : undefined;
    const text = pool && lbCurrentProvider ? pool.poolStatus(lbCurrentProvider) : undefined;
    if (text === lbStatusLast) return; // 内容未变，不重绘
    lbStatusLast = text;
    lbStatusCtx.ui.setStatus(LB_STATUS_ID, text);
  };

  // 幂等：重复调用只保留一个定时器；session_shutdown 后可再次 start
  const stopLBStatus = (): void => {
    if (lbStatusTimer) {
      clearInterval(lbStatusTimer);
      lbStatusTimer = null;
    }
    if (lbStatusCtx && lbStatusLast !== undefined) {
      lbStatusCtx.ui.setStatus(LB_STATUS_ID, undefined); // 清除页脚，避免残留
    }
    lbStatusLast = undefined;
    lbStatusCtx = null;
  };

  const startLBStatus = (ctx: any): void => {
    stopLBStatus();
    if (!ctx?.hasUI) return; // print / JSON 模式没有 TUI，不起定时器
    lbStatusCtx = ctx;
    lbCurrentProvider = ctx.model?.provider; // 会话恢复时的当前模型
    lbStatusTimer = setInterval(renderLBStatus, 1000);
    lbStatusTimer.unref?.(); // 不阻塞进程退出
    renderLBStatus();
  };

  // 切模型（/model、Ctrl+P、会话恢复）：状态栏跟着切到新 provider 的池
  pi.on("model_select", (event: any) => {
    lbCurrentProvider = event.model?.provider;
    renderLBStatus();
  });

  // ================= 代理与负载均衡钩子 =================

  // before_provider_request：注入代理配置到请求的 env 字段
  pi.on("before_provider_request", (event, ctx) => {
    // 从 model.headers 中提取 X-PROXY-CONFIG（buildProviderConfig 时注入）
    const model = ctx.model;
    if (!model?.headers) return;

    const proxyConfig = model.headers["X-PROXY-CONFIG"] as string | undefined;
    if (!proxyConfig) return;

    // 解析代理配置
    const resolved = resolveValue(proxyConfig);

    // 注入到请求 payload 的 env 字段（pi-ai SDK 会读取）
    // 注意：event.payload 是即将发送给 SDK 的请求选项对象
    const payload = event.payload as any;
    if (!payload) return;

    // 初始化 env 字段
    if (!payload.env) {
      payload.env = {};
    }

    if (resolved === "disable") {
      // 明确禁用代理：清空代理环境变量
      payload.env.HTTPS_PROXY = "";
      payload.env.HTTP_PROXY = "";
      payload.env.ALL_PROXY = "";
      payload.env.NO_PROXY = "*";
    } else if (resolved) {
      // 设置代理 URL
      payload.env.HTTPS_PROXY = resolved;
      payload.env.HTTP_PROXY = resolved;
      payload.env.ALL_PROXY = resolved;
    }
    // 不配置 proxy 时：不修改 payload.env，继承 process.env（SDK 默认行为）
  });

  // before_provider_headers：LB key 轮询
  pi.on("before_provider_headers", (event, ctx) => {
    // 移除标记头（不转发给上游）
    delete event.headers["X-PROXY-CONFIG"];

    // ---- LB key 轮询 ----
    const poolName = event.headers["X-LB-POOL"] as string | undefined;
    if (!poolName) return;
    const pool = lbPools.get(poolName);
    if (!pool) return;

    // 严格轮询：只选未冷却的 Key；若全部 Key 都 429 冷却中，则强行使用最早恢复的 Key
    const picked = pool.pick() ?? pool.fallbackPick();

    const { key, index: keyIdx } = picked;
    pool.lastUsedIdx = keyIdx; // 状态栏用 '*' 标出这次实际发出去的是哪个 Key
    // 替换 Authorization 为真实 key（SDK 已发送 Bearer $LB）
    event.headers["Authorization"] = `Bearer ${key}`;
    // 清除标记头（不转发给上游）
    delete event.headers["X-LB-POOL"];

    // 通过 ctx.model.id 将选中的 key 信息传递给 after_provider_response / message_end
    // 注意：ctx 由 runner.createContext() 提供，model 在请求期间始终可用
    const modelId = ctx.model?.id;
    if (modelId) {
      lbInflight.set(modelId, { poolName, keyIdx, ts: Date.now() });
    }
    renderLBStatus(); // 立即把 '*' 挪到新选中的 Key 上
  });

  pi.on("after_provider_response", (event, ctx) => {
    // 从 lbInflight Map 中取回 before_provider_headers 存入的 key 信息
    const modelId = ctx.model?.id;
    if (!modelId) return;
    const info = lbInflight.get(modelId);
    if (!info) return;
    lbInflight.delete(modelId);

    const pool = lbPools.get(info.poolName);
    if (!pool) return;

    if (event.status === 429) {
      const end = pool.on429(info.keyIdx);
      persistCooldowns();
      renderLBStatus(); // 立即刷新页脚倒计时，不等下一个 tick
      console.warn(
        `[custom-provider] LB key #${info.keyIdx + 1} (${info.poolName}) 上游返回 429，` +
        `冷却至 ${new Date(end).toLocaleTimeString()}`
      );
    } else if (event.status >= 200 && event.status < 300) {
      pool.onSuccess(info.keyIdx);
      renderLBStatus(); // 冷却解除也要同步清掉页脚
    }
  });

  // message_end：429 错误兜底检测。
  // SDK 对 429 直接抛错（after_provider_response 收不到响应事件），但错误会以
  // stopReason:"error" 的 assistant 消息结束，这里从 errorMessage 识别限流并冷却对应 Key。
  // 其他结束（成功/中断/非限流错误）仅清理关联，不触发冷却。
  pi.on("message_end", (event) => {
    const msg = event.message as {
      model?: unknown;
      stopReason?: unknown;
      errorMessage?: unknown;
    };
    if (typeof msg.model !== "string") return;
    const info = lbInflight.get(msg.model);
    if (!info) return;
    lbInflight.delete(msg.model);

    if (
      msg.stopReason === "error" &&
      typeof msg.errorMessage === "string" &&
      RATE_LIMIT_RE.test(msg.errorMessage)
    ) {
      const pool = lbPools.get(info.poolName);
      if (pool) {
        const end = pool.on429(info.keyIdx);
        persistCooldowns();
        renderLBStatus(); // 立即刷新页脚倒计时，不等下一个 tick
        console.warn(
          `[custom-provider] LB key #${info.keyIdx + 1} (${info.poolName}) 触发 429，` +
          `冷却至 ${new Date(end).toLocaleTimeString()}（${msg.errorMessage.slice(0, 120)}）`
        );
      }
    }
  });

// ================= 子命令实现 =================

  // 交互式过滤模型列表（按关键字保留/排除）；返回 null 表示保留全部
  const filterModelsInteractive = async (
    ctx: any,
    models: (string | IModel)[]
  ): Promise<(string | IModel)[] | null> => {
    if (models.length === 0 || !ctx.hasUI) return null;
    const idOf = (m: string | IModel) => (typeof m === "string" ? m : m.id).toLowerCase();

    const mode = await ctx.ui.select(
      `共拉取 ${models.length} 个模型，如何处理？`,
      ["全部保留", "按关键字保留", "按关键字排除"]
    );
    if (!mode || mode === "全部保留") return null;

    const kwInput = await ctx.ui.input(
      mode === "按关键字保留"
        ? "保留含任一关键字的模型（逗号分隔，如: deepseek,glm；留空=全部）"
        : "排除含任一关键字的模型（逗号分隔，如: qwen,mini；留空=不排除）",
      mode === "按关键字保留" ? "deepseek,glm" : "qwen,mini"
    );
    if (!kwInput || !kwInput.trim()) return null;
    const keywords = kwInput.split(",").map((s: string) => s.trim().toLowerCase()).filter(Boolean);
    if (keywords.length === 0) return null;

    const filtered = models.filter((m) => {
      const id = idOf(m);
      return mode === "按关键字保留"
        ? keywords.some((k: string) => id.includes(k))
        : !keywords.some((k: string) => id.includes(k));
    });

    ctx.ui.notify(`过滤后剩 ${filtered.length} 个（原 ${models.length} 个）`, "info");
    if (filtered.length === 0) {
      const keepAll = await ctx.ui.confirm(
        "过滤结果为空",
        "选择 Yes 保留全部模型，No 取消本次操作"
      );
      if (keepAll) return null;
      await ctx.ui.notify("已取消", "info");
      return null;
    }
    const ok = await ctx.ui.confirm(
      `确认写入这 ${filtered.length} 个模型？`,
      "选择 Yes 仅保存过滤后的模型，No 保留全部"
    );
    return ok ? filtered : null;
  };

  // 交互式添加向导（TUI/RPC 对话引导）
  const doAddInteractive = async (ctx: any, nameDefault: string): Promise<void> => {
    try {
      // ---- 1. 名称 ----
      const name = await ctx.ui.input(
        `Provider 名称（字母/数字/-/_，必填）`,
        nameDefault || "deepseek"
      );
      if (!name) return;

      const nameErr = validateProviderName(name);
      if (nameErr) {
        ctx.ui.notify(`名称无效: ${nameErr}`, "error");
        return;
      }

      // 提前检查重名，避免用户填完所有信息才发现已存在
      const early = loadConfig();
      const existingIndex = early.providers.findIndex((p) => p.name === name);
      if (existingIndex >= 0) {
        const ok = await ctx.ui.confirm(
          `Provider "${name}" 已存在，是否覆盖？`,
          "选择 Yes 覆盖现有配置（模型详情将按本次输入重建），No 取消本次操作"
        );
        if (!ok) {
          ctx.ui.notify("已取消", "info");
          return;
        }
      }

      // ---- 选择添加方式：简单（自动探测+模型）/ custom（完整配置）----
      const addMode = await ctx.ui.select(
        "添加方式？",
        ["简单添加（自动探测协议 + 模型列表）", "custom配置（代理/LB/请求头模板/高级选项）"]
      );
      if (!addMode) return;

      // ================= 简单添加路径（4 步完成）=================
      if (addMode.startsWith("简单")) {
        // 1. URL
        const simpleUrl = await ctx.ui.input(
          "API 端点 URL（粘贴完整地址，自动探测协议和模型）",
          "https://api.deepseek.com/v1"
        );
        if (!simpleUrl) return;

        // 2. API Key（留空 = local 无认证）
        const simpleKeyInput = await ctx.ui.input(
          "API Key（留空 = 无认证本地服务，支持 $ENV 环境变量）",
          "$DEEPSEEK_API_KEY"
        );
        const simpleApiKey = simpleKeyInput?.trim() || "local";

        // 3. 探测
        ctx.ui.notify("正在探测端点…", "info");
        const probeResult = await probeEndpoint(simpleUrl, simpleApiKey);

        let simpleModels: (string | IModel)[] = [];
        if (probeResult) {
          simpleModels = probeResult.models;
          ctx.ui.notify(`✅ 检测到 ${probeResult.api} 协议，发现 ${simpleModels.length} 个模型`, "info");
          // 如果模型过多，提供过滤
          if (simpleModels.length > 10 && ctx.hasUI) {
            const filtered = await filterModelsInteractive(ctx, simpleModels);
            if (filtered) simpleModels = filtered;
          }
        } else {
          // 探测失败：手动输入
          const fallback = await ctx.ui.input(
            "自动探测失败，请手动输入模型 ID（逗号分隔，可留空取消）",
            "deepseek-chat,deepseek-reasoner"
          );
          if (fallback && fallback.trim()) {
            simpleModels = fallback.split(",").map((s: string) => s.trim()).filter(Boolean);
          }
        }

        if (simpleModels.length === 0) {
          ctx.ui.notify("未提供模型，取消添加", "warning");
          return;
        }

        // 3. 保存
        const simpleProvider: IProvider = {
          name,
          baseUrl: normalizeBaseUrl(simpleUrl, probeResult?.api ?? inferApi(simpleUrl)),
          apiKey: simpleApiKey,
          models: simpleModels,
        };
        const simpleConfig = loadConfig();
        const simpleOk = persistProvider(simpleConfig, simpleProvider, ctx);
        if (simpleOk) {
          ctx.ui.notify(
            `✅ Provider "${name}" 已添加，共 ${simpleModels.length} 个模型。用 /model 选择模型`,
            "info"
          );
        }
        return;
      }

      // ================= custom配置路径（完整向导 2-10 步）=================
      // ---- 2. 端点 ----
      const baseUrl = await ctx.ui.input(
        "API 端点 URL（完整地址，通常含 /v1；粘贴 /v1/models 也会被自动清理）",
        "https://api.deepseek.com/v1"
      );
      if (!baseUrl) return;

      // ---- 3. API Key ----
      const apiKeyInput = await ctx.ui.input(
        "API Key（支持 $ENV 环境变量 / !命令 / 字面量 sk-xxx / 留空表示无认证本地服务）",
        "$DEEPSEEK_API_KEY"
      );
      const apiKey = apiKeyInput || "local";

      // 提前解析校验：空结果（env 未设置 / 命令输出空）静默会导致请求 401，先警告
      const resolvedKey = resolveValue(apiKey);
      if (resolvedKey === "" && apiKey !== "local") {
        const origin = apiKey.startsWith("$")
          ? `环境变量 ${apiKey} 未设置或为空`
          : apiKey.startsWith("!")
            ? "命令执行无输出"
            : "API Key 为空";
        const proceed = await ctx.ui.confirm(
          `${origin}，解析结果为空`,
          "保存后请求可能无认证（401）。仍要继续吗？选择 No 可重新输入"
        );
        if (!proceed) {
          ctx.ui.notify("已取消添加", "info");
          return;
        }
      }

      // ---- 4. 协议类型 ----
      const apiType = await ctx.ui.select(
        "API protocol type (auto-detect recommended)",
        ["自动推断", "openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]
      );
      if (!apiType) return;

      // 所有路径都做 /v1 归一化（自动推断先推断协议，再按协议规范化）
      const inferredApi =
        apiType === "自动推断" ? inferApi(baseUrl) : apiType;
      const finalBaseUrl = normalizeBaseUrl(baseUrl, inferredApi);
      if (finalBaseUrl !== baseUrl) {
        ctx.ui.notify(`已自动调整端点: ${baseUrl} → ${finalBaseUrl}`, "info");
      }

      // ---- 4.5 代理配置（每个 provider 独立配置）----
      const proxyChoice = await ctx.ui.select(
        "代理配置？",
        ["不走代理（继承环境变量）", "指定代理地址", "明确禁用代理（disable）"]
      );
      let proxyMode: string | undefined;
      if (proxyChoice && proxyChoice.startsWith("指定")) {
        const proxyInput = await ctx.ui.input(
          "代理地址（http://host:port 或 https://host:port，支持 $ENV 引用）",
          "http://127.0.0.1:7890"
        );
        const url = proxyInput?.trim();
        if (url) {
          proxyMode = url;
          ctx.ui.notify(`该 provider 将走代理: ${url}`, "info");
        } else {
          ctx.ui.notify("未提供代理地址，跳过代理配置", "info");
        }
      } else if (proxyChoice && proxyChoice.startsWith("明确")) {
        proxyMode = "disable";
        ctx.ui.notify("该 provider 将明确不走代理（覆盖环境变量）", "info");
      }

      // ---- 4.6 多 Key 负载均衡（应对 RPM/RTM 限制；选 Yes 输入多个 API Key）----
      const needLB = await ctx.ui.confirm(
        "需要多 Key 负载均衡？",
        "应对 RPM/RTM 等限流：多个 Key 轮询，受限后自动冷却 60s 再恢复"
      );
      let lbKeys: string[] | undefined;
      let lbCooldown: number | undefined;
      let lbMode: "roundrobin" | "sticky" | undefined;
      if (needLB) {
        const lbInput = await ctx.ui.input(
          "API Keys（逗号分隔，支持 $ENV / !cmd 引用）",
          "$KEY_A,$KEY_B,sk-plain-c"
        );
        if (lbInput && lbInput.trim()) {
          lbKeys = lbInput.split(",").map((s: string) => s.trim()).filter(Boolean);
          const cdInput = await ctx.ui.input(
            "默认冷却时间（秒），受限后自动暂停该 Key，恢复后重新参与轮询",
            "60"
          );
          const cd = Number(cdInput?.trim() || "60");
          if (cd > 0) lbCooldown = cd;
          const modeChoice = await ctx.ui.select(
            "Key 调度模式？",
            ["roundrobin：每个请求轮询下一个可用 Key", "sticky：粘住一个 Key 直到它 429 才切换"]
          );
          if (modeChoice && String(modeChoice).includes("sticky")) lbMode = "sticky";
        }
        if (lbKeys && lbKeys.length > 0) {
          ctx.ui.notify(`已启用 ${lbKeys.length} Key 负载均衡（${lbMode ?? "roundrobin"}），冷却 ${lbCooldown ?? 60}s`, "info");
        }
      }

      // ---- 5. 是否自动拉取模型 ----
      const autoFetch = await ctx.ui.confirm(
        "自动从 /v1/models 拉取模型列表？",
        "若服务支持模型列表端点可自动获取；否则将手动输入"
      );

      // ---- 6. 请求头模板（预设整组请求头，不同 CLI 头集合不同；选"custom"逐头输入）----
      const presetLabels = HEADER_PRESETS.map((p) => p.label);
      const presetChoice = await ctx.ui.select(
        "请求头模板？",
        presetLabels
      );

      let customHeaders: Record<string, string> | undefined;

      // 校验并写入一组请求头（名称/值合法性校验 + 敏感头提示）
      const applyHeaderSet = (raw: Record<string, string>, source: string) => {
        let ok = true;
        for (const [k, v] of Object.entries(raw)) {
          const val = String(v);
          if (!HEADER_NAME_RE.test(k) || !HEADER_VALUE_RE.test(val)) {
            ctx.ui.notify(`${source}: 请求头 ${k} 名称或值含非法字符（不允许换行/非 ASCII）→ 已跳过`, "error");
            ok = false;
            continue;
          }
          if (SENSITIVE_HEADER_HINTS.includes(k.toLowerCase())) {
            ctx.ui.notify(`${source}: ${k} 属于敏感头，设置后可能覆盖认证/协议逻辑，请确认服务端要求`, "warning");
          }
          customHeaders = customHeaders ?? {};
          customHeaders[k] = val; // 值保留 $ENV 引用，pi 请求时动态解析
        }
        return ok;
      };

      if (presetChoice) {
        const preset = HEADER_PRESETS.find((p) => p.label === presetChoice);
        if (preset?.key) {
          if (preset.key !== "browser") {
            applyHeaderSet({ ...preset.headers }, `模板"${preset.label}"`);
            ctx.ui.notify(
              `已应用请求头模板"${preset.label}": ${Object.keys(preset.headers).join(", ")}`,
              "info"
            );
          } // 浏览器模板 = 不写头，由 pi 自动补充浏览器 UA
        } else {
          // custom：JSON 对象，或每行 "Key: Value"（值支持 $ENV）
          const headersInput = await ctx.ui.input(
            'custom请求头（JSON 对象，或每行 "Key: Value"：值支持 $ENV；留空取消）',
            '{"X-API-Key": "$MY_API_KEY"}'
          );
          if (headersInput && headersInput.trim()) {
            const t = headersInput.trim();
            try {
              const parsed = JSON.parse(t);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                applyHeaderSet({ ...parsed }, "custom请求头");
              } else {
                ctx.ui.notify("JSON 需为对象（{...}）", "error");
              }
            } catch {
              // 非 JSON：按行解析 "Key: Value"
              const lines = t.split(/\r\n|\r|\n/);

              const kv: Record<string, string> = {};
              let parseOk = true;
              for (const line of lines) {
                if (!line.trim()) continue;
                const idx = line.indexOf(":");
                if (idx <= 0) {
                  ctx.ui.notify(`无法解析行: ${line}`, "error");
                  parseOk = false;
                  break;
                }
                kv[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
              }
              if (parseOk) applyHeaderSet(kv, "custom请求头");
            }
          }
        }
      }

      // ---- 7. 补充/覆盖请求头（在模板/custom基础上追加，可覆盖；无需直接跳过）----
      const needMore = await ctx.ui.confirm(
        "需要补充/覆盖请求头吗？",
        "在现有头部上追加或覆盖（如 X-API-Key），值支持 $ENV 插值"
      );
      if (needMore) {
        const headersInput = await ctx.ui.input(
          "请求头 JSON（合并进现有头部，可覆盖模板值）",
          '{"X-API-Key": "$MY_API_KEY"}'
        );
        if (headersInput && headersInput.trim()) {
          try {
            const parsed = JSON.parse(headersInput);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              applyHeaderSet({ ...parsed }, "补充请求头");
            } else {
              ctx.ui.notify("JSON 需为对象", "error");
            }
          } catch {
            ctx.ui.notify("JSON 格式错误，已跳过", "error");
          }
        }
      }

      // ---- 8. 高级配置      // ---- 8. 高级配置：authHeader / compat / 按模型覆盖（vision、reasoning、cost 等）----
      const advancedSkeleton = {
        authHeader: false,
        compat: {},
        modelOverrides: {},
      };
      const needAdvanced = await ctx.ui.confirm(
        "需要高级配置吗？",
        "如 authHeader、compat、按模型覆盖（input 图像、reasoning、contextWindow、cost、maxTokens、api 协议）。支持双协议混用: modelOverrides 里给单个模型设 api + baseUrl"
      );
      let authHeader = false;
      let compat: Record<string, any> | undefined;
      let modelOverrides: Record<string, Partial<IModel>> | undefined;
      if (needAdvanced) {
        const advText = await ctx.ui.editor(
          "高级配置 JSON（对象字段：authHeader / compat / modelOverrides，直接编辑或留空跳过）",
          JSON.stringify(advancedSkeleton, null, 2)
        );
        if (advText && advText.trim()) {
          try {
            const adv = JSON.parse(advText);
            if (typeof adv.authHeader === "boolean") authHeader = adv.authHeader;
            if (adv.compat && typeof adv.compat === "object") compat = adv.compat;
            if (adv.modelOverrides && typeof adv.modelOverrides === "object") {
              modelOverrides = adv.modelOverrides;
            }
            if (adv.authHeader) {
              ctx.ui.notify(
                "authHeader=true 已开启：将以 Authorization: Bearer <API Key> 发送认证",
                "info"
              );
            }
          } catch {
            ctx.ui.notify("高级配置 JSON 格式错误，已忽略", "error");
          }
        }
      }

      // ---- 9. 收集模型 ----
      let models: (string | IModel)[] = [];
      if (autoFetch) {
        ctx.ui.notify("正在拉取模型列表…", "info");
        try {
          const modelIds = await fetchModels(finalBaseUrl, resolvedKey, inferredApi, customHeaders);
          models = modelIds;
          ctx.ui.notify(`成功拉取 ${models.length} 个模型`, "info");
          // 过滤：避免把渠道全量模型写入（按关键字保留/排除）
          if (ctx.hasUI && models.length > 0) {
            const filtered = await filterModelsInteractive(ctx, models);
            if (filtered) models = filtered;
          }
        } catch (error) {
          ctx.ui.notify(
            `${error instanceof Error ? error.message : String(error)}\n可手动输入模型，或重新检查端点/Key`,
            "error"
          );
          const fallback = await ctx.ui.input(
            "手动输入模型 ID（逗号分隔，可留空取消）",
            "model-a,model-b"
          );
          if (fallback && fallback.trim()) {
            models = fallback.split(",").map((s: string) => s.trim()).filter(Boolean);
          }
        }
      } else {
        const input = await ctx.ui.input(
          "模型 ID（逗号分隔，可留空取消）",
          "deepseek-chat,deepseek-reasoner"
        );
        if (input && input.trim()) {
          models = input.split(",").map((s: string) => s.trim()).filter(Boolean);
        }
      }

      if (models.length === 0) {
        ctx.ui.notify("未提供模型，取消添加", "warning");
        return;
      }

      // 手动输入时提供连通性测试（自动拉取成功则已证明连通）
      if (!autoFetch) {
        const test = await ctx.ui.confirm(
          "测试连接？",
          `将请求 ${finalBaseUrl}/models 验证端点与 API Key`
        );
        if (test) {
          ctx.ui.notify("测试中…", "info");
          try {
            const ids = await fetchModels(finalBaseUrl, resolvedKey, inferredApi, customHeaders);
            ctx.ui.notify(`连接正常，检测到 ${ids.length} 个模型`, "info");
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            const keep = await ctx.ui.confirm(
              "连接测试失败",
              `${msg}\n仍要保存此配置吗？`
            );
            if (!keep) {
              ctx.ui.notify("已取消添加", "info");
              return;
            }
          }
        }
      }

      // ---- 10. 应用高级覆盖并持久化 ----
      if (modelOverrides) {
        models = applyModelOverrides(models, modelOverrides);
      }

      // ---- 10.1 Anthropic 1M 长上下文提示：
      // 含 [1m] 后缀或大窗口模型的 anthropic-messages 中转，需要携带
      // anthropic-beta: context-1m-2025-08-07 请求头，1M 窗口才生效（官方端点不支持）
      const hasLongCtxModel =
        inferredApi === "anthropic-messages" &&
        !isOfficialAnthropicEndpoint(finalBaseUrl) &&
        models.some((m) => hasLongContextSuffix(typeof m === "string" ? m : m.id));
      if (hasLongCtxModel && !hasHeader(customHeaders, "anthropic-beta")) {
        const addBeta = await ctx.ui.confirm(
          "检测到 1M 长上下文模型（[1m]）",
          "将自动添加请求头 anthropic-beta: context-1m-2025-08-07，否则 1M 窗口不生效（官方端点不支持此头）。要添加吗？"
        );
        if (addBeta) {
          if (!customHeaders) customHeaders = {};
          customHeaders["anthropic-beta"] = "context-1m-2025-08-07";
        }
      }

      const newProvider: IProvider = {
        name,
        baseUrl: finalBaseUrl,
        apiKey,
        models,
      };
      if (proxyMode) newProvider.proxy = proxyMode;
      if (lbKeys && lbKeys.length > 0) {
        newProvider.lbKeys = lbKeys;
        if (lbCooldown) newProvider.lbCooldown = lbCooldown;
        if (lbMode) newProvider.lbMode = lbMode;
      }

      if (apiType !== "自动推断" || inferredApi !== "openai-completions") {
        // 显式选择的协议，或自动推断出的非默认协议，需存盘保证幂等
        newProvider.api = inferredApi;
      }
      if (authHeader) newProvider.authHeader = true;
      if (customHeaders && Object.keys(customHeaders).length > 0) {
        newProvider.headers = customHeaders;
      }
      if (compat && Object.keys(compat).length > 0) {
        newProvider.compat = compat;
      }

      const ok = persistProvider(loadConfig(), newProvider, ctx);
      if (ok) {
        ctx.ui.notify(
          `Provider "${name}" 已添加并注册，共 ${models.length} 个模型。用 /model 选择模型`,
          "info"
        );
      }
    } catch (error) {
      ctx.ui.notify(
        `添加失败: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    }
  };

  // 由 flags 组装（无交互）Provider 配置；失败返回 null 并已通知原因
  const buildProviderFromFlags = (parsed: ParsedArgs, ctx: any): IProvider | null => {
    const { positional, flags } = parsed;
    const name = getFlag(flags, "name") || positional[0];
    if (!name || validateProviderName(name)) {
      ctx.ui.notify(`名称无效: ${validateProviderName(name) ?? "缺少名称（--name 或位置参数）"}`, "error");
      return null;
    }
    const baseUrl = getFlag(flags, "base-url", "url");
    if (!baseUrl) {
      ctx.ui.notify("缺少 --base-url", "error");
      return null;
    }
    const apiKey = getFlag(flags, "api-key", "key") ?? "local";
    const apiRaw = getFlag(flags, "api");
    const api = !apiRaw || apiRaw === "auto" ? inferApi(baseUrl) : apiRaw;

    let models: (string | IModel)[] = [];
    const modelsCsv = getFlag(flags, "models");
    if (modelsCsv) models = modelsCsv.split(",").map((s) => s.trim()).filter(Boolean);
    for (const m of flags.get("model") ?? []) {
      if (m.trim()) models.push(m.trim());
    }
    if (models.length === 0) {
      ctx.ui.notify("缺少 --models（逗号分隔）或 --model（可多次）", "error");
      return null;
    }

    // --model-api "模型id:协议" 与 --model-base-url "模型id:url"（可重复）:
    // 让单个模型覆盖协议/端点（如同一网关内部分模型走 anthropic 协议）
    const modelApiPairs = flags.get("model-api") ?? [];
    const modelBaseUrlPairs = flags.get("model-base-url") ?? [];
    if (modelApiPairs.length > 0 || modelBaseUrlPairs.length > 0) {
      const byId = new Map<string, Partial<IModel>>();
      const applyPair = (pair: string, key: "api" | "baseUrl", label: string): boolean => {
        const idx = pair.indexOf(":");
        if (idx <= 0) {
          ctx.ui.notify(`${label} 格式错误（应为 "模型id:值"）: ${pair}`, "error");
          return false;
        }
        const id = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        if (!id || !val) {
          ctx.ui.notify(`${label} 格式错误（模型id与值不能为空）: ${pair}`, "error");
          return false;
        }
        const entry = byId.get(id) ?? {};
        if (key === "api" && !/^(?:(?:openai-completions|openai-responses|anthropic-messages|google-generative-ai|auto))$/.test(val)) {
          ctx.ui.notify(`未知协议类型: ${val}（可选: openai-completions / openai-responses / anthropic-messages / google-generative-ai）`, "error");
          return false;
        }
        entry[key] = val;
        byId.set(id, entry);
        return true;
      };
      for (const p of modelApiPairs) {
        if (!applyPair(p, "api", "--model-api")) return null;
      }
      for (const p of modelBaseUrlPairs) {
        if (!applyPair(p, "baseUrl", "--model-base-url")) return null;
      }
      if (byId.size > 0) {
        models = models.map((m) => {
          const id = typeof m === "string" ? m : m.id;
          const patch = byId.get(id);
          if (!patch) return m;
          return typeof m === "string" ? ({ id, ...patch } as IModel) : { ...m, ...patch };
        });
      }
    }

    const headers: Record<string, string> = {};
    for (const h of flags.get("header") ?? []) {
      const idx = h.indexOf(":");
      if (idx <= 0) {
        ctx.ui.notify(`--header 格式错误（应为 "Name: value"）: ${h}`, "error");
        return null;
      }
      headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    }
    const headersJson = getFlag(flags, "headers");
    if (headersJson) {
      try {
        const obj = JSON.parse(headersJson);
        if (typeof obj === "object" && obj !== null) Object.assign(headers, obj);
        else {
          ctx.ui.notify("--headers 需为 JSON 对象", "error");
          return null;
        }
      } catch {
        ctx.ui.notify("--headers JSON 解析失败", "error");
        return null;
      }
    }

    const provider: IProvider = {
      name,
      baseUrl: normalizeBaseUrl(baseUrl, api),
      apiKey,
      models,
    };
    const proxyFlag = getFlag(flags, "proxy");
    if (proxyFlag) {
      // 支持 "disable" 或直接指定代理 URL
      provider.proxy = proxyFlag === "disable" ? "disable" : proxyFlag;
    }
    if (apiRaw && apiRaw !== "auto") provider.api = apiRaw;
    else if (api !== "openai-completions") provider.api = api;
    if (getFlag(flags, "auth-header")) provider.authHeader = true;
    const lbKeysFlag = getFlag(flags, "lb-keys");
    if (lbKeysFlag) {
      provider.lbKeys = lbKeysFlag.split(",").map((s) => s.trim()).filter(Boolean);
      const lbCooldownFlag = getFlag(flags, "lb-cooldown");
      if (lbCooldownFlag) {
        const n = Number(lbCooldownFlag);
        if (n > 0) provider.lbCooldown = n;
      }
      const lbCooldownsFlag = getFlag(flags, "lb-cooldowns");
      if (lbCooldownsFlag) {
        // 与 lbKeys 一一对应；非法项记 NaN（落盘时变 null，运行时回退默认冷却）
        provider.lbCooldowns = lbCooldownsFlag.split(",").map((s) => {
          const n = Number(s.trim());
          return Number.isFinite(n) && n > 0 ? n : NaN;
        });
      }
      const lbModeFlag = getFlag(flags, "lb-mode");
      if (lbModeFlag === "sticky") provider.lbMode = "sticky";
      else if (lbModeFlag === "roundrobin") provider.lbMode = "roundrobin";
    }

    const compatJson = getFlag(flags, "compat");
    if (compatJson) {
      try {
        const obj = JSON.parse(compatJson);
        if (obj && typeof obj === "object") provider.compat = obj;
        else {
          ctx.ui.notify("--compat 需为 JSON 对象", "error");
          return null;
        }
      } catch {
        ctx.ui.notify("--compat JSON 解析失败", "error");
        return null;
      }
    }

    const overridesJson = getFlag(flags, "overrides");
    if (overridesJson) {
      try {
        const obj = JSON.parse(overridesJson);
        if (obj && typeof obj === "object") {
          provider.models = applyModelOverrides(provider.models, obj);
        } else {
          ctx.ui.notify("--overrides 需为 JSON 对象", "error");
          return null;
        }
      } catch {
        ctx.ui.notify("--overrides JSON 解析失败", "error");
        return null;
      }
    }

    // --profile 应用完整请求头模板（不覆盖 --header/--headers 显式写入的头）
    const profileFlag = getFlag(flags, "profile");
    if (profileFlag) {
      const preset = HEADER_PRESETS.find((p) => p.key === profileFlag.toLowerCase());
      if (!preset || preset.key === undefined) {
        const keys = HEADER_PRESETS.filter((p) => p.key).map((p) => p.key).join(", ");
        ctx.ui.notify(`未知模板 "${profileFlag}"，可用: ${keys}`, "error");
        return null;
      }
      if (preset.key !== "browser") {
        const lowerKeys = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
        for (const [k, v] of Object.entries(preset.headers)) {
          if (!lowerKeys.has(k.toLowerCase())) headers[k] = v; // 不覆盖显式
        }
      }
    }

    // --ua 预设 User-Agent（preset 键名或原始字符串）；显式 headers 里已有 User-Agent 则不覆盖
    const uaFlag = getFlag(flags, "ua", "user-agent");
    if (uaFlag && !hasHeader(headers, "user-agent") && !profileFlag) {
      const presetKey = uaFlag.toLowerCase();
      if (UA_PRESETS[presetKey]) {
        headers["User-Agent"] = UA_PRESETS[presetKey];
      } else {
        headers["User-Agent"] = uaFlag;
      }
    }

    if (Object.keys(headers).length > 0) provider.headers = headers;
    return provider;
  };

  // add：JSON / flags 非交互 / 交互向导 三种路径
  const doAdd = async (argText: string, ctx: any): Promise<void> => {
    const t = argText.trim();

    // 路径 1：JSON 参数（位置参数或 --json）
    if (t.startsWith("{")) {
      addProviderFromJson(t, ctx);
      return;
    }
    const parsed = parseFlagArgs(t);
    const jsonFlag = getFlag(parsed.flags, "json");
    if (jsonFlag) {
      addProviderFromJson(jsonFlag, ctx);
      return;
    }

    const baseUrl = getFlag(parsed.flags, "base-url", "url");
    const modelsCsv = getFlag(parsed.flags, "models");
    const modelFlags = parsed.flags.get("model") ?? [];
    const hasModels = !!modelsCsv || modelFlags.length > 0;

    // 路径 2：flags 非交互添加
    if (baseUrl && hasModels) {
      const provider = buildProviderFromFlags(parsed, ctx);
      if (!provider) return;

      const config = loadConfig();
      const exists = config.providers.some((p) => p.name === provider.name);
      if (exists && !getFlag(parsed.flags, "force") && !getFlag(parsed.flags, "yes")) {
        if (ctx.hasUI) {
          const ok = await ctx.ui.confirm(
            `Provider "${provider.name}" 已存在，是否覆盖？`,
            "选择 Yes 覆盖现有配置，No 取消（--force 可跳过此确认）"
          );
          if (!ok) {
            ctx.ui.notify("已取消", "info");
            return;
          }
        } else {
          ctx.ui.notify(`已存在 provider "${provider.name}"，如需覆盖请加 --force`, "error");
          return;
        }
      }

      const ok = persistProvider(config, provider, ctx);
      if (ok) {
        ctx.ui.notify(
          `Provider "${provider.name}" 已添加并注册，共 ${provider.models.length} 个模型。用 /model 选择模型`,
          "info"
        );
      }
      return;
    }

    // 路径 3：交互向导
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "非交互环境请用参数添加: /custom-provider add --name x --base-url URL --models a,b [--api-key $K] [--api TYPE] [--force]，或用 --json '{...}'",
        "warning"
      );
      return;
    }
    await doAddInteractive(ctx, getFlag(parsed.flags, "name") || parsed.positional[0] || "deepseek");
  };

  // remove：按名称删除（--yes / -y 跳过确认）
  const doRemove = async (argText: string, ctx: any): Promise<void> => {
    const config = loadConfig();
    if (config.providers.length === 0) {
      ctx.ui.notify("暂无已配置的 provider，请先用 /custom-provider add 添加", "warning");
      return;
    }

    const parsed = parseFlagArgs(argText);
    let name = parsed.positional[0] || getFlag(parsed.flags, "name");
    if (!name && ctx.hasUI) {
      const selected = await ctx.ui.select(
        "选择要删除的 Provider",
        config.providers.map((p) => p.name)
      );
      if (!selected) return;
      name = selected;
    }
    if (!name) {
      ctx.ui.notify("请指定名称: /custom-provider remove <名称> [--yes]", "warning");
      return;
    }

    const idx = findProviderIndex(config, name);
    if (idx < 0) {
      ctx.ui.notify(`未找到 provider "${name}"`, "error");
      return;
    }

    if (ctx.hasUI && !getFlag(parsed.flags, "yes")) {
      const ok = await ctx.ui.confirm(
        `删除 Provider "${name}"？（共 ${config.providers[idx].models.length} 个模型）`,
        "将同时注销该 provider，不可撤销；--yes 可跳过确认"
      );
      if (!ok) {
        ctx.ui.notify("已取消", "info");
        return;
      }
    }

    config.providers.splice(idx, 1);
    try {
      saveConfig(config);
      pi.unregisterProvider(name);
      lbPools.delete(name); // 同步移除 LB 池
      ctx.ui.notify(`Provider "${name}" 已删除并注销`, "info");
    } catch (error) {
      ctx.ui.notify(`删除失败: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  // refresh：重拉模型列表（保留已存在模型的详细配置）
  const doRefresh = async (argText: string, ctx: any): Promise<void> => {
    const config = loadConfig();
    if (config.providers.length === 0) {
      ctx.ui.notify("暂无已配置的 provider，请先用 /custom-provider add 添加", "warning");
      return;
    }

    const parsed = parseFlagArgs(argText);
    const argName = parsed.positional[0] || getFlag(parsed.flags, "name");
    let target: IProvider | undefined;
    if (argName) {
      const argIdx = findProviderIndex(config, argName);
      if (argIdx < 0) {
        ctx.ui.notify(`未找到 provider "${argName}"`, "error");
        return;
      }
      target = config.providers[argIdx];
    } else if (ctx.hasUI) {
      const selected = await ctx.ui.select(
        "选择要刷新模型的 Provider",
        config.providers.map((p) => p.name)
      );
      if (!selected) return;
      target = config.providers.find((p) => p.name === selected);
    } else {
      target = config.providers[0];
    }
    if (!target) return;

    if (target.enabled === false) {
      ctx.ui.notify(`Provider "${target.name}" 已禁用，请先 /custom-provider enable ${target.name}`, "warning");
      return;
    }

    ctx.ui.notify(`正在从 ${target.baseUrl} 拉取模型列表…`, "info");
    try {
      const apiKey = resolveValue(target.apiKey);
      const api = inferApi(target.baseUrl, target.api);
      const modelIds = await fetchModels(target.baseUrl, apiKey, api, target.headers);

      if (modelIds.length === 0) {
        ctx.ui.notify("端点未返回任何模型", "error");
        return;
      }

      // 合并：保留已存在模型的详细配置（contextWindow/maxTokens 等），新模型用默认配置
      const existing = new Map(
        target.models.map((m) => [typeof m === "string" ? m : m.id, m])
      );
      target.models = modelIds.map((id) => existing.get(id) ?? id);

      const ok = persistProvider(config, target, ctx);
      if (ok) {
        ctx.ui.notify(
          `已更新 provider "${target.name}"，共 ${target.models.length} 个模型。用 /model 切换`,
          "info"
        );
      }
    } catch (error) {
      ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  // list：列出全部 provider
  const doList = (ctx: any): void => {
    const config = loadConfig();
    if (config.providers.length === 0) {
      ctx.ui.notify("暂无已配置的 provider，用 /custom-provider add 添加", "info");
      return;
    }
    const lines = config.providers.map((p) => {
      const api = p.api ?? inferApi(p.baseUrl);
      const state = p.enabled === false ? "✗ 禁用" : "✓ 启用";
      const ids = p.models.map((m) => (typeof m === "string" ? m : m.id));
      const preview =
        ids.length <= 4 ? ids.join(", ") : `${ids.slice(0, 4).join(", ")}, …（共 ${ids.length} 个）`;
      const proxyLine = p.proxy ? `\n  代理: ${p.proxy}` : "";
      const lbPool = lbPools.get(p.name);
      const lbLine = lbPool ? `\n  负载均衡: ${lbPool.keys.length} Key（${lbPool.activeCount()} 活跃 / ${lbPool.cooldownMs / 1000}s 冷却 / ${lbPool.mode === "sticky" ? "sticky" : "roundrobin"}）` : "";
      const lbDetail = lbPool ? `\n${lbPool.statusLines().join("\n")}` : "";
      return `• ${p.name}  [${state}] [${api}]\n  端点: ${p.baseUrl}${proxyLine}${lbLine}${lbDetail}\n  模型: ${preview}`;
    });
    ctx.ui.notify(`已配置 ${config.providers.length} 个 provider:\n\n${lines.join("\n\n")}\n\n启用/禁用: /custom-provider enable|disable <名称>` , "info");
  };

  // test：测试连通性 + 延迟 + LB 状态 + 模型概览
  const doTest = async (argText: string, ctx: any): Promise<void> => {
    const parsed = parseFlagArgs(argText);
    const name = parsed.positional[0] || getFlag(parsed.flags, "name");
    const tmpBaseUrl = getFlag(parsed.flags, "base-url", "url");

    let baseUrl: string;
    let apiKey: string;
    let api: string;
    let headers: Record<string, string> | undefined;
    let label: string;
    let lbKeyCount = 0;
    let lbActiveCount = 0;
    let lbDetailLines: string[] = [];

    if (tmpBaseUrl) {
      baseUrl = tmpBaseUrl;
      apiKey = getFlag(parsed.flags, "api-key", "key") ?? "";
      const apiRaw = getFlag(parsed.flags, "api");
      api = !apiRaw || apiRaw === "auto" ? inferApi(baseUrl) : apiRaw;
      label = name || baseUrl;
    } else {
      if (!name) {
        ctx.ui.notify("请指定名称: /custom-provider test <名称>，或提供临时端点: test --base-url URL --api-key KEY", "warning");
        return;
      }
      const config = loadConfig();
      const pIdx = findProviderIndex(config, name);
      if (pIdx < 0) {
        ctx.ui.notify(`未找到 provider "${name}"`, "error");
        return;
      }
      const p = config.providers[pIdx];
      if (p.enabled === false) {
        ctx.ui.notify(`Provider "${name}" 已禁用，请先 /custom-provider enable ${name}`, "warning");
        return;
      }
      baseUrl = p.baseUrl;
      apiKey = resolveValue(p.apiKey);
      api = inferApi(p.baseUrl, p.api);
      headers = p.headers;
      label = p.name;
      // LB 状态
      const pool = lbPools.get(p.name);
      if (pool) {
        lbKeyCount = pool.keys.length;
        lbActiveCount = pool.activeCount();
        lbDetailLines = pool.statusLines();
      }
    }

    ctx.ui.notify(`正在测试 ${label}（${baseUrl}）…`, "info");
    const t0 = Date.now();
    try {
      const ids = await fetchModels(baseUrl, apiKey, api, headers);
      const latency = Date.now() - t0;
      const statusParts = [
        `✅ ${label}`,
        `  端点: ${baseUrl}`,
        `  协议: ${api}`,
        `  延迟: ${latency}ms`,
        `  模型: ${ids.length} 个`,
      ];
      if (ids.length > 0) {
        const preview = ids.slice(0, 5).join(", ");
        statusParts.push(`  示例: ${preview}${ids.length > 5 ? ` ... (+${ids.length - 5})` : ""}`);
      }
      if (lbKeyCount > 0) {
        statusParts.push(`  LB: ${lbActiveCount}/${lbKeyCount} Key 活跃`);
        if (lbDetailLines.length > 0) statusParts.push(...lbDetailLines.map((l) => `  ${l.trim()}`));
      }
      ctx.ui.notify(statusParts.join("\n"), "info");
    } catch (error) {
      const latency = Date.now() - t0;
      ctx.ui.notify(
        `❌ ${label} 测试失败（${latency}ms）\n  ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    }
  };

  // prune：修剪已配置 provider 的模型列表（交互过滤，或 --keep/--drop 按关键字）
  const doPrune = async (argText: string, ctx: any): Promise<void> => {
    const config = loadConfig();
    if (config.providers.length === 0) {
      ctx.ui.notify("暂无已配置的 provider", "warning");
      return;
    }
    const parsed = parseFlagArgs(argText);
    let name = parsed.positional[0] || getFlag(parsed.flags, "name");
    if (!name && ctx.hasUI) {
      const selected = await ctx.ui.select(
        "选择要修剪模型的 Provider",
        config.providers.map((p) => p.name)
      );
      if (!selected) return;
      name = selected;
    }
    if (!name) {
      ctx.ui.notify("请指定名称: /custom-provider prune <名称> [--keep 关键词] [--drop 关键词]", "warning");
      return;
    }
    const idx = findProviderIndex(config, name);
    if (idx < 0) {
      ctx.ui.notify(`未找到 provider "${name}"`, "error");
      return;
    }
    const target = config.providers[idx];
    if (target.enabled === false) {
      ctx.ui.notify(`Provider "${name}" 已禁用，请先 /custom-provider enable ${name}`, "warning");
      return;
    }

    const keepKw = getFlag(parsed.flags, "keep");
    const dropKw = getFlag(parsed.flags, "drop");
    const originalCount = target.models.length;
    let models = target.models;

    if (keepKw || dropKw) {
      // 非交互：按关键字过滤（大小写不敏感子串匹配）
      const ks = (keepKw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const ds = (dropKw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (ks.length === 0 && ds.length === 0) {
        ctx.ui.notify("--keep/--drop 关键词不能为空", "error");
        return;
      }
      const filtered = models.filter((m) => {
        const id = (typeof m === "string" ? m : m.id).toLowerCase();
        if (ks.length > 0 && !ks.some((k) => id.includes(k))) return false;
        if (ds.length > 0 && ds.some((k) => id.includes(k))) return false;
        return true;
      });
      if (filtered.length === 0) {
        ctx.ui.notify(`过滤后为空（原 ${originalCount} 个），未做修改`, "warning");
        return;
      }
      if (filtered.length === originalCount) {
        ctx.ui.notify("过滤条件未命中任何模型，配置未变", "info");
        return;
      }
      target.models = filtered;
    } else if (ctx.hasUI) {
      const filtered = await filterModelsInteractive(ctx, target.models);
      if (!filtered || filtered.length === originalCount) return; // null = 保留全部
      target.models = filtered;
    } else {
      ctx.ui.notify(
        "非交互环境请用: prune <名称> --keep \"kw1,kw2\" 或 --drop \"kw1,kw2\"",
        "warning"
      );
      return;
    }

    const removed = originalCount - target.models.length;
    const ok = persistProvider(config, target, ctx);
    if (ok) {
      ctx.ui.notify(
        `Provider "${name}" 模型已修剪: ${originalCount} → ${target.models.length}（移除 ${removed} 个）`,
        "info"
      );
    }
  };

  // config：查看摘要 / 单个详情 / edit 编辑 / path 路径 / 重置（不实现 reset）
  const doConfig = async (argText: string, ctx: any): Promise<void> => {
    const parsed = parseFlagArgs(argText);
    const rawTarget = parsed.positional[0] || getFlag(parsed.flags, "name") || "";
    const target = rawTarget.toLowerCase();
    const config = loadConfig();

    if (target === "path") {
      ctx.ui.notify(`配置文件: ${CONFIG_PATH}`, "info");
      return;
    }

    if (target === "edit") {
      if (!ctx.hasUI) {
        ctx.ui.notify("config edit 需要交互环境（TUI/RPC），可直接编辑 JSON 文件后 /reload", "warning");
        return;
      }
      const text = await ctx.ui.editor(
        `编辑配置文件（JSON，保存即校验并重新注册）`,
        JSON.stringify(config, null, 2)
      );
      if (!text || !text.trim()) {
        ctx.ui.notify("已取消编辑", "info");
        return;
      }
      try {
        const next = JSON.parse(text);
        if (!Array.isArray(next.providers)) throw new Error("缺少 providers 数组");
        for (const p of next.providers) {
          if (!p || !p.name || !p.baseUrl) throw new Error("存在缺少 name/baseUrl 的 provider");
          if (!Array.isArray(p.models)) throw new Error(`provider "${p.name}" 的 models 需为数组`);
          const nameErr = validateProviderName(String(p.name));
          if (nameErr) throw new Error(`provider 名称无效: ${nameErr}`);
        }
        saveConfig(next);
        registerProviders(); // 全量重注册（自动跳过 enabled=false）
        ctx.ui.notify(`配置已保存并重新注册（${next.providers.length} 个 provider）`, "info");
      } catch (error) {
        ctx.ui.notify(
          `配置无效，未保存: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      }
      return;
    }

    if (!target) {
      if (config.providers.length === 0) {
        ctx.ui.notify(`配置文件: ${CONFIG_PATH}（当前无 provider）`, "info");
        return;
      }
      const lines = config.providers.map((p) => {
        const api = p.api ?? inferApi(p.baseUrl);
        const state = p.enabled === false ? "✗ 禁用" : "✓ 启用";
        const proxyLine = p.proxy ? `\n  代理: ${p.proxy}` : "";
        const lbPool = lbPools.get(p.name);
        const lbLine = lbPool ? `\n  负载均衡: ${lbPool.keys.length} Key（${lbPool.activeCount()} 活跃 / ${lbPool.cooldownMs / 1000}s 冷却 / ${lbPool.mode === "sticky" ? "sticky" : "roundrobin"}）` : "";
        const lbDetail = lbPool ? `\n${lbPool.statusLines().join("\n")}` : "";
        return `• ${p.name}  [${state}] [${api}]  ${p.models.length} 个模型\n  端点: ${p.baseUrl}${proxyLine}${lbLine}${lbDetail}`;
      });
      ctx.ui.notify(
        `配置文件: ${CONFIG_PATH}\n已配置 ${config.providers.length} 个 provider:\n\n${lines.join("\n\n")}\n\nconfig <name> 查看详情 · config edit 编辑 · config path 路径`,
        "info"
      );
      return;
    }

    const pIdx = findProviderIndex(config, rawTarget);
    if (pIdx < 0) {
      ctx.ui.notify(`未找到 provider "${rawTarget}"（可用: edit / path / provider 名称）`, "error");
      return;
    }
    const p = config.providers[pIdx];
    ctx.ui.notify(`Provider "${p.name}" 配置:\n${JSON.stringify(p, null, 2)}`, "info");
  };

  // enable / disable：切换启用状态（禁用者不注册，/model 中不再出现）
  const setEnabled = async (argText: string, ctx: any, enabled: boolean): Promise<void> => {
    const verb = enabled ? "enable" : "disable";
    const config = loadConfig();
    const parsed = parseFlagArgs(argText);
    let name = parsed.positional[0] || getFlag(parsed.flags, "name");

    if (!name && ctx.hasUI) {
      const options = config.providers
        .filter((p) => (enabled ? p.enabled === false : p.enabled !== false))
        .map((p) => p.name);
      if (options.length === 0) {
        ctx.ui.notify(
          config.providers.length === 0 ? "暂无已配置的 provider" : `没有需要 ${verb} 的 provider`,
          "warning"
        );
        return;
      }
      const selected = await ctx.ui.select(`选择要 ${verb} 的 Provider`, options);
      if (!selected) return;
      name = selected;
    }

    if (!name) {
      ctx.ui.notify(`请指定名称: /custom-provider ${verb} <名称>`, "warning");
      return;
    }

    const idx = findProviderIndex(config, name);
    if (idx < 0) {
      ctx.ui.notify(`未找到 provider "${name}"`, "error");
      return;
    }
    const p = config.providers[idx];
    const already = enabled ? p.enabled !== false : p.enabled === false;
    if (already) {
      ctx.ui.notify(`Provider "${name}" 已经是${enabled ? "启用" : "禁用"}状态`, "info");
      return;
    }

    if (enabled) {
      delete p.enabled; // 启用后配置里不残留 false
    } else {
      p.enabled = false;
    }

    try {
      saveConfig(config);
      if (enabled) {
        pi.registerProvider(p.name, buildProviderConfig(p));
        ctx.ui.notify(`Provider "${name}" 已启用并注册`, "info");
      } else {
        pi.unregisterProvider(p.name);
        ctx.ui.notify(`Provider "${name}" 已禁用并注销（配置保留，可随时 enable 恢复）`, "info");
      }
    } catch (error) {
      ctx.ui.notify(`操作失败: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  // 子命令参数补全
  const SUBCOMMANDS = ["add", "remove", "refresh", "list", "test", "config", "enable", "disable", "prune", "help"];
  const providerNameCompletions = () =>
    loadConfig().providers.map((p) => ({ value: p.name, label: p.name }));

  const HELP_TEXT = [
    "custom-provider —— 管理第三方 Provider",
    "",
    "用法:",
    "  /custom-provider add [名称] [flags]   交互引导或参数添加",
    "  /custom-provider remove <名称>        删除（--yes 跳过确认）",
    "  /custom-provider refresh [名称]       重新拉取模型列表",
    "  /custom-provider list                 列出所有 provider（含启用状态）",
    "  /custom-provider test <名称>          测试连接（或传 --base-url 测临时端点）",
    "  /custom-provider config [edit|path|<名称>]  查看/编辑配置",
    "  /custom-provider prune <名称> [--keep/--drop 关键词]  修剪模型列表（避免全量保留）",
    "  /custom-provider enable|disable <名称> 启用/禁用 provider",
    "  /custom-provider help                 显示本帮助",
    "",
    "add 常用 flags:",
    "  --name · --base-url/--url · --api-key/--key · --api TYPE",
    "  --models \"m1,m2\" · --model m（可多次）",
    "  --header \"K: V\"（可多次）· --headers '{\"k\":\"v\"}'",
    "  --profile <模板键>（完整请求头模板：claude-code / codex / browser 等）",
    "  --ua <预设键|原始UA>（如 claude-code / codex / browser）",
    "  --proxy <URL|disable>（指定代理地址或明确禁用，如 http://127.0.0.1:7890 或 disable，支持 $ENV）",
    "  --auth-header",
    "  --lb-keys \"$K1,$K2\"（多 Key 负载均衡）· --lb-cooldown 60（默认冷却秒数）· --lb-cooldowns \"30,120\"（按 Key 冷却秒数，与 lbKeys 对齐）· --lb-mode sticky（黏住一个 Key 直到 429）",
    "  --model-api 'id:协议'（可多次，如 claude-x:anthropic-messages）",
    "  --model-base-url 'id:url'（和 --model-api 搭配混用双协议）",
    "  --compat '{...}' · --overrides '{\"modelId\":{...}}'",
    "  --force（覆盖已存在）· --json '{...}'（完整配置）",
    "  ",
    "代理配置说明:",
    "  - proxy: \"http://127.0.0.1:7890\" → 该 provider 走指定代理",
    "  - proxy: \"disable\" → 明确不走代理（覆盖环境变量）",
    "  - 不配置 proxy → 继承 process.env 的 HTTPS_PROXY 等环境变量",
    "  - 每个 provider 的代理配置互相独立，互不干扰",
    "  ",
    "负载均衡示例（同渠道多 Key 轮询，429 后自动冷却 60s）:",
    "  /custom-provider add relay --base-url https://api.gw.com/v1 \\",
    "      --lb-keys \"$KEY_A,$KEY_B,sk-plain\" --lb-cooldown 60 --force",
    "  JSON: --json '{\"name\":\"relay\",\"baseUrl\":\"...\",\"lbKeys\":[\"k1\",\"k2\"],\"lbCooldown\":30}'",
    "  ",
    "代理配置示例:",
    "  /custom-provider add overseas --base-url https://api.openai.com/v1 \\",
    "      --api-key $OPENAI_KEY --models gpt-4 --proxy http://127.0.0.1:7890",
    "  /custom-provider add local --base-url http://localhost:8080/v1 \\",
    "      --models llama-3 --proxy disable",
    "  ",
"示例:",
    "  /custom-provider add deepseek --base-url https://api.deepseek.com/v1 \\",
    "      --api-key $DEEPSEEK_API_KEY --models deepseek-chat,deepseek-reasoner",
    "  /custom-provider add --json '{\"name\":\"x\",\"baseUrl\":\"...\",\"models\":[\"a\"]}'",
    "  /custom-provider test --base-url http://localhost:8080/v1 --api-key local",
  ].join("\n");

  pi.registerCommand("custom-provider", {
    description: "管理第三方 Provider：add / remove / refresh / list / test / help",
    getArgumentCompletions: (prefix: string) => {
      // 注意: pi 会用 item.value 替换整个参数段（命令名后的全部文本），
      // So value must be"subcommand + full-name"的完整参数，label 才是用于显示的名称。
      const trimmed = prefix.trim();
      const match = trimmed.match(/^(\S+)(?:\s+(.*))?$/);
      const first = (match?.[1] ?? "").toLowerCase();
      // 子命令后需要 provider 名（remove/refresh/test/enable/disable）
      if (
        SUBCOMMANDS.includes(first) &&
        first !== "add" &&
        first !== "list" &&
        first !== "help" &&
        first !== "config"
      ) {
        const rest = match?.[2] ?? "";
        const items = providerNameCompletions()
          .filter((i) => i.value.toLowerCase().startsWith(rest.toLowerCase()))
          .map((i) => ({ value: `${first} ${i.value}`, label: i.label }));
        return items.length > 0 ? items : null;
      }
      if (first === "config") {
        const rest = match?.[2] ?? "";
        const extras = ["edit", "path"].map((s) => ({ value: `config ${s}`, label: s }));
        const providerItems = providerNameCompletions().map((i) => ({
          value: `config ${i.value}`,
          label: i.label,
        }));
        const items = [...extras, ...providerItems].filter((i) =>
          i.value.toLowerCase().startsWith(trimmed.toLowerCase())
        );
        return items.length > 0 ? items : null;
      }
      if (first === "add") {
        // 补全 --ua 预设键（value 保留完整参数段：add --ua <键>）
        const uaMatch = trimmed.match(/^add\s+--ua\s*(.*)$/i);
        if (uaMatch) {
          const p = uaMatch[1].toLowerCase();
          const items = Object.keys(UA_PRESETS)
            .filter((k) => k.toLowerCase().startsWith(p))
            .map((k) => ({
              value: `add --ua ${k}`,
              label: k,
              description: UA_PRESETS[k].slice(0, 60),
            }));
          return items.length > 0 ? items : null;
        }
      }
      const items = SUBCOMMANDS.filter((s) => s.startsWith(first)).map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const t = toArgText(args).trim();
      const parsed = parseFlagArgs(t);
      const sub = (parsed.positional[0] || "").toLowerCase();
      // 去掉子命令本身，剩余参数交给对应实现
      const rest = t.replace(/^\S+/, "").trim();

      switch (sub) {
        case "add":
          await doAdd(rest, ctx);
          break;
        case "remove":
          await doRemove(rest, ctx);
          break;
        case "refresh":
          await doRefresh(rest, ctx);
          break;
        case "list":
          doList(ctx);
          break;
        case "test":
          await doTest(rest, ctx);
          break;
        case "config":
          await doConfig(rest, ctx);
          break;
        case "enable":
          await setEnabled(rest, ctx, true);
          break;
        case "disable":
          await setEnabled(rest, ctx, false);
          break;
        case "prune":
          await doPrune(rest, ctx);
          break;
        case "help":
          ctx.ui.notify(HELP_TEXT, "info");
          break;
        default:
          ctx.ui.notify(sub ? `未知子命令 "${sub}"，可用: ${SUBCOMMANDS.join(" / ")}` : HELP_TEXT, sub ? "error" : "info");
      }
    },
  });
}