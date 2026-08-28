# 代理配置重构 - 变更说明

## 改动概述

将代理配置从**进程级环境变量修改**改为**请求级 env 字段注入**，实现每个 provider 独立、互不干扰的代理配置。

## 主要变更

### 1. 类型定义更新

**IProvider 接口**：
```typescript
// 旧：proxy: "enable" | "disable" | string
// 新：proxy: "disable" | string

/** 代理配置：
 * - "disable": 明确不走代理（覆盖全局环境变量）
 * - "http://host:port" 或 "https://host:port": 该 provider 走指定代理
 * - 不配置: 继承 process.env 的 HTTPS_PROXY 等环境变量（默认行为）
 * - 支持 $ENV 引用和 !cmd 执行
 */
proxy?: "disable" | string;
```

**IConfig 接口**：
```typescript
// 全局 proxyUrl 字段已废弃，但保留向后兼容
/** 已废弃：改用 provider 级的 proxy 参数直接指定代理 URL */
proxyUrl?: string;
```

### 2. 核心实现变更

#### buildProviderConfig() - 注入标记头

```typescript
// 代理配置：注入 X-PROXY-CONFIG 标记头（before_provider_request 检测此标记注入 env）
if (provider.proxy && typeof provider.proxy === "string") {
  providerHeaders["X-PROXY-CONFIG"] = provider.proxy;
}
```

#### before_provider_request 钩子 - env 注入

**旧实现（before_provider_headers）**：
- 修改进程级 `process.env.HTTPS_PROXY`
- 并发请求时存在竞态条件
- 需要保存和恢复环境变量状态

**新实现（before_provider_request）**：
```typescript
pi.on("before_provider_request", (event, ctx) => {
  const model = ctx.model;
  if (!model?.headers) return;

  const proxyConfig = model.headers["X-PROXY-CONFIG"] as string | undefined;
  if (!proxyConfig) return;

  const resolved = resolveValue(proxyConfig);
  const payload = event.payload as any;
  if (!payload) return;

  if (!payload.env) {
    payload.env = {};
  }

  if (resolved === "disable") {
    // 明确禁用代理
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
  // 不配置时：不修改 payload.env，继承 process.env
});
```

### 3. 用户界面更新

#### 交互式向导

**旧提示**：
```
代理模式？
- 不走代理（默认）
- 走全局代理（enable）
```

**新提示**：
```
代理配置？
- 不走代理（继承环境变量）
- 指定代理地址
- 明确禁用代理（disable）
```

#### 命令行 flags

```bash
# 旧：--proxy enable|disable
# 新：--proxy <URL|disable>

# 示例
--proxy http://127.0.0.1:7890     # 指定代理
--proxy disable                   # 禁用代理
--proxy '$MY_PROXY_URL'           # 从环境变量读取
```

#### JSON 配置

```json
{
  "providers": [
    {
      "name": "overseas",
      "proxy": "http://127.0.0.1:7890"  // 指定代理
    },
    {
      "name": "local",
      "proxy": "disable"                 // 禁用代理
    },
    {
      "name": "default"
      // 不配置 proxy：继承 process.env
    }
  ]
}
```

### 4. 帮助文档更新

新增"代理配置说明"章节：
```
代理配置说明:
  - proxy: "http://127.0.0.1:7890" → 该 provider 走指定代理
  - proxy: "disable" → 明确不走代理（覆盖环境变量）
  - 不配置 proxy → 继承 process.env 的 HTTPS_PROXY 等环境变量
  - 每个 provider 的代理配置互相独立，互不干扰
```

## 技术优势

### 请求级隔离
- **旧方案**：修改 `process.env`，全局副作用
- **新方案**：通过 `payload.env` 注入，每个请求独立

### 无并发竞争
- **旧方案**：多个 provider 同时请求时可能互相干扰
- **新方案**：每个请求的 env 独立，完全隔离

### 灵活性
- 支持三种模式：继承环境变量 / 指定代理 / 明确禁用
- 每个 provider 可以有不同的代理配置
- 支持 $ENV 引用和动态值

### 兼容性
- 与 pi-ai SDK 的代理机制完美对接
- 符合 `resolveHttpProxyUrlForTarget()` 的设计
- 支持 `NO_PROXY` 白名单

## 测试验证

测试用例（test-proxy.ts）验证了三种配置模式：

1. **不配置 proxy**：payload.env 不修改，继承 process.env
2. **proxy: "http://..."**：注入代理环境变量到 payload.env
3. **proxy: "disable"**：注入空值和 NO_PROXY=*

所有测试通过 ✓

## 向后兼容性

### 破坏性变更
- `proxy: "enable"` 不再支持（必须指定完整 URL）
- 全局 `proxyUrl` 配置已废弃（但保留字段避免解析错误）

### 迁移指南

**旧配置**：
```json
{
  "proxyUrl": "http://127.0.0.1:7890",
  "providers": [
    {"name": "a", "proxy": "enable"},
    {"name": "b", "proxy": "disable"}
  ]
}
```

**新配置**：
```json
{
  "providers": [
    {"name": "a", "proxy": "http://127.0.0.1:7890"},
    {"name": "b", "proxy": "disable"}
  ]
}
```

## 相关文件

- `custom-provider.ts`：核心实现
- `README.md`：用户文档
- `test-proxy.ts`：测试脚本
- `test-proxy-config.json`：测试配置示例
