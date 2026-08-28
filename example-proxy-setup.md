# 代理配置示例

## 场景 1：国内外 API 混用

```bash
# 国外 API：需要代理
/custom-provider add openai \
    --base-url https://api.openai.com/v1 \
    --api-key $OPENAI_KEY \
    --models gpt-4o,gpt-4o-mini \
    --proxy http://127.0.0.1:7890

# 国内 API：不走代理
/custom-provider add deepseek \
    --base-url https://api.deepseek.com/v1 \
    --api-key $DEEPSEEK_KEY \
    --models deepseek-chat,deepseek-reasoner \
    --proxy disable

# 本地模型：不走代理
/custom-provider add ollama \
    --base-url http://localhost:11434/v1 \
    --models llama3 \
    --proxy disable
```

## 场景 2：动态代理配置

```bash
# 从环境变量读取代理地址（便于切换不同代理）
export MY_PROXY=http://127.0.0.1:7890

/custom-provider add claude \
    --base-url https://api.anthropic.com/v1 \
    --api-key $ANTHROPIC_KEY \
    --models claude-sonnet-4 \
    --proxy '$MY_PROXY'

# 切换代理只需修改环境变量，无需重新配置
export MY_PROXY=http://127.0.0.1:10876
# 下次请求自动使用新代理
```

## 场景 3：混合环境

```bash
# 默认情况：不配置 proxy，使用系统代理环境变量
export HTTPS_PROXY=http://127.0.0.1:7890

/custom-provider add default-api \
    --base-url https://api.example.com/v1 \
    --api-key $KEY \
    --models model-a
# 该 provider 会读取 HTTPS_PROXY

# 特定 provider 需要不同代理
/custom-provider add special-api \
    --base-url https://special.example.com/v1 \
    --api-key $KEY2 \
    --models model-b \
    --proxy http://127.0.0.1:10876
# 该 provider 使用独立代理，不受 HTTPS_PROXY 影响

# 本地服务不走代理（覆盖 HTTPS_PROXY）
/custom-provider add local \
    --base-url http://localhost:8080/v1 \
    --models llama \
    --proxy disable
# 明确禁用，即使设置了 HTTPS_PROXY 也不走
```

## 场景 4：JSON 批量配置

```json
{
  "providers": [
    {
      "name": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "$OPENAI_KEY",
      "proxy": "http://127.0.0.1:7890",
      "models": ["gpt-4o"]
    },
    {
      "name": "anthropic",
      "baseUrl": "https://api.anthropic.com/v1",
      "apiKey": "$ANTHROPIC_KEY",
      "proxy": "http://127.0.0.1:7890",
      "models": ["claude-sonnet-4"]
    },
    {
      "name": "deepseek",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "$DEEPSEEK_KEY",
      "proxy": "disable",
      "models": ["deepseek-chat", "deepseek-reasoner"]
    },
    {
      "name": "ollama",
      "baseUrl": "http://localhost:11434/v1",
      "proxy": "disable",
      "models": ["llama3", "qwen2.5"]
    }
  ]
}
```

保存为 `my-providers.json`，然后批量导入：

```bash
cat my-providers.json | jq '.providers[]' -c | while read -r p; do
  /custom-provider add --json "$p"
done
```

## 验证配置

```bash
# 查看所有 provider
/custom-provider list

# 测试连通性
/custom-provider test openai
/custom-provider test deepseek

# 查看详细配置
/custom-provider config openai
```

## 故障排查

### 问题：代理不生效

**检查步骤**：
1. 确认 proxy 配置已保存：`/custom-provider config <name>`
2. 验证代理地址可访问：`curl -x http://127.0.0.1:7890 https://www.google.com`
3. 检查代理协议：仅支持 http/https，不支持 socks5（pi-ai SDK 限制）

### 问题：本地服务走了代理

**解决方案**：
```bash
# 明确禁用代理
/custom-provider add local --base-url http://localhost:8080/v1 \
    --models llama --proxy disable --force
```

### 问题：环境变量不生效

**检查**：
```bash
# 确认环境变量已设置
echo $HTTPS_PROXY

# 确认 provider 未配置 proxy（不配置才会继承环境变量）
/custom-provider config <name> | grep proxy
# 应该没有 "proxy" 字段
```

## 性能考虑

每个请求的代理配置通过 `payload.env` 传递，无额外开销：

- ✅ 请求级隔离，无并发竞争
- ✅ 无进程环境变量污染
- ✅ 支持动态代理切换（通过 $ENV 引用）
- ✅ 每个 provider 独立配置，互不干扰
