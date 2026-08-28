# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
