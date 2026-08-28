# 安全修复与代码质量改进

## Critical 安全问题修复

### 1. 命令注入漏洞修复 ✅

**问题**：`resolveValue()` 函数中 `!command` 特性允许执行任意shell命令，存在严重安全风险。

**修复**：
- 完全禁用 `!command` 特性
- 添加明确的错误提示，建议用户改用环境变量
- 保留代码块但不执行，仅用于向后兼容性说明

**影响**：
- ❌ **破坏性变更**：依赖 `!command` 的配置将失效
- ✅ **迁移路径**：改用环境变量预执行
  ```bash
  # 旧方式（不安全，已禁用）
  "apiKey": "!cat /path/to/key"
  
  # 新方式（推荐）
  export MY_API_KEY=$(cat /path/to/key)
  "apiKey": "$MY_API_KEY"
  ```

### 2. HTTP 头注入风险修复 ✅

**问题**：`HEADER_VALUE_RE` 允许制表符 `\t`，可能被利用进行头注入攻击。

**修复**：
- 严格限制头值为可见 ASCII 字符（`\x20-\x7e`）
- 拒绝所有控制字符，包括制表符、换行符等

**影响**：
- 极少数使用特殊字符的自定义头会被拒绝
- 更安全的默认行为

### 3. 负载均衡竞态条件修复 ✅

**问题**：
- `LBKeyPool.pick()` 和状态更新方法之间存在竞态条件
- 全局变量 `lastUsedPool` / `lastUsedKeyIdx` 在并发请求时互相覆盖

**修复**：
- `pick()` 方法返回 `{key, index}` 而不是仅返回 key
- 添加简单的自旋锁防止并发选择同一个 key
- 通过请求头 `X-LB-KEY-INDEX` 传递上下文，避免全局状态
- 删除 `lastUsedPool` 和 `lastUsedKeyIdx` 全局变量

**技术改进**：
```typescript
// 旧：全局状态，并发不安全
let lastUsedPool: string | null = null;
let lastUsedKeyIdx: number = -1;
const key = pool.pick(); // 仅返回 key
// ... 在另一个事件中使用全局变量

// 新：请求级上下文，并发安全
const picked = pool.pick(); // 返回 {key, index}
event.headers["X-LB-KEY-INDEX"] = String(picked.index);
// ... 在后续事件中从 headers 读取
```

---

## High 优先级问题修复

### 4. JSON 解析错误处理增强 ✅

**问题**：配置文件 JSON 解析失败时静默返回空配置，用户无感知。

**修复**：
- 区分"文件不存在"和"格式错误"
- 格式错误时输出详细错误信息：
  - 错误类型（SyntaxError）
  - 错误消息
  - 修复建议
- 空文件有明确警告

**示例输出**：
```
[custom-provider] 配置文件 JSON 解析失败: ~/.pi/agent/custom-providers.json
  错误: Unexpected token } in JSON at position 123
  请检查 JSON 格式是否正确，或删除该文件重新配置
```

### 5. 环境变量解析增强 ✅

**问题**：环境变量不存在时返回空字符串，无日志提示。

**修复**：
- 环境变量为空时输出警告日志
- 帮助用户快速定位配置问题

### 6. HTTP 请求资源泄漏修复 ✅

**问题**：`httpGet()` 超时后未清理事件监听器，可能导致内存泄漏。

**修复**：
- 超时时主动移除 `data` 和 `end` 事件监听器
- 使用命名函数便于清理
- 添加更详细的超时错误信息

---

## Medium 优先级改进

### 7. 规格缓存日志增强 ✅

**问题**：缓存加载/保存静默失败，难以排查问题。

**修复**：
- 添加详细的日志输出：
  - 缓存加载成功：显示模型数量
  - 缓存过期：明确提示将后台刷新
  - 格式错误：警告并说明已忽略
  - 读写失败：输出错误信息
- 添加版本号字段，便于未来缓存格式迁移

### 8. 代码重复消除 ✅

**问题**：模型列表解析逻辑重复出现多次。

**修复**：
- 提取 `parseModelListResponse()` 函数
- 统一处理三种响应格式：
  - `{data: [{id}]}`（OpenAI）
  - `[{id}]`（数组）
  - `{models: [{id}]}`（其他）
- 所有模型列表解析使用同一函数

---

## 安全检查清单

### 已修复
- ✅ 命令注入漏洞
- ✅ HTTP 头注入风险
- ✅ 并发竞态条件
- ✅ 资源泄漏

### 已增强
- ✅ 错误处理和日志
- ✅ 输入验证
- ✅ 环境变量解析警告
- ✅ 代码可维护性

### 仍需注意（低优先级）
- ⚠️ 长函数拆分（`doAddInteractive` 465行）
- ⚠️ 正则表达式注释（`normalizeModelIdCandidates`）
- ⚠️ 命名一致性（`doAdd` vs `setEnabled`）

---

## 迁移指南

### 1. 命令执行特性移除

如果你的配置使用了 `!command`：

```json
// 旧配置（不再工作）
{
  "apiKey": "!cat ~/.secrets/api-key",
  "proxy": "!echo $MY_PROXY"
}
```

迁移到环境变量：

```bash
# 设置环境变量
export MY_API_KEY=$(cat ~/.secrets/api-key)
export MY_PROXY=$MY_PROXY

# 新配置
{
  "apiKey": "$MY_API_KEY",
  "proxy": "$MY_PROXY"
}
```

### 2. 自定义请求头验证

如果你使用了包含控制字符的头值，现在会被拒绝：

```json
// 不再允许
{
  "headers": {
    "X-Data": "value\twith\ttabs"  // ❌ 包含 \t
  }
}
```

请使用标准编码：

```json
{
  "headers": {
    "X-Data": "value%09with%09tabs"  // ✅ URL 编码
  }
}
```

---

## 性能影响

所有修复对性能影响极小：

- 命令执行移除：**性能提升**（不再执行 shell）
- 头值校验：**无影响**（正则复杂度相同）
- LB 并发保护：**<1ms 延迟**（简单自旋锁）
- 代码提取：**无影响**（仅重构）

---

## 测试建议

1. **验证环境变量解析**：
   ```bash
   /custom-provider test <name>
   # 检查日志中是否有"环境变量未设置"警告
   ```

2. **测试负载均衡并发**：
   ```bash
   # 启动多个并发请求
   for i in {1..10}; do
     pi chat "test" &
   done
   # 检查是否有"无可用 key"或"触发 429"日志
   ```

3. **验证配置文件错误处理**：
   ```bash
   # 故意破坏 JSON
   echo '{invalid}' > ~/.pi/agent/custom-providers.json
   pi --reload
   # 应看到详细的解析错误信息
   ```

---

## 版本兼容性

- **最低 pi 版本**：无变化（仍为 0.84.x）
- **Node.js 版本**：无变化（>=18）
- **配置格式**：向后兼容（除 `!command`）

---

## 未来改进

低优先级，不影响安全性和功能：

1. 拆分超长函数提升可测试性
2. 添加单元测试覆盖核心逻辑
3. 使用 TypeScript 严格模式
4. 添加性能监控和指标
