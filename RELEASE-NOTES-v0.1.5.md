# Release v0.1.5 - Security Fixes & Per-Provider Proxy

## 🔒 Critical Security Fixes

This release addresses **3 critical security vulnerabilities**:

### 1. Command Injection Vulnerability (CVE-pending)
- **Severity**: CRITICAL
- **Impact**: Arbitrary command execution through `!command` syntax
- **Fix**: Completely removed command execution feature
- **Action Required**: Migrate to environment variables (see below)

### 2. HTTP Header Injection Risk
- **Severity**: CRITICAL  
- **Impact**: Potential header injection attacks via control characters
- **Fix**: Strict header value validation (visible ASCII only)

### 3. Load Balancer Race Conditions
- **Severity**: CRITICAL
- **Impact**: Concurrent requests could corrupt LB key state
- **Fix**: Request-level context tracking with spin lock protection

## ✨ Major Features

### Per-Provider Proxy Configuration

Each provider can now have independent proxy settings:

```bash
# Overseas API - use proxy
/custom-provider add openai --proxy http://127.0.0.1:7890

# Domestic API - explicit disable
/custom-provider add deepseek --proxy disable

# Local service - explicit disable  
/custom-provider add ollama --proxy disable
```

**Benefits**:
- ✅ Request-level isolation (no global side effects)
- ✅ No concurrent conflicts
- ✅ Flexible per-provider control
- ✅ Supports `$ENV` variable references

See [CHANGELOG-proxy.md](CHANGELOG-proxy.md) for migration guide.

## 🐛 Bug Fixes

- Fixed resource leak in `httpGet()` timeout handling
- Fixed global state pollution in load balancer key tracking
- Fixed silent failures in JSON config parsing
- Added warnings for undefined environment variables

## 🔨 Code Quality Improvements

- Enhanced error messages with actionable suggestions
- Improved logging throughout (cache, config, LB status)
- Extracted `parseModelListResponse()` to reduce duplication
- Added version field to spec cache for future migrations

## ⚠️ Breaking Changes

### 1. Command Execution Removed

**Before** (insecure):
```json
{
  "apiKey": "!cat ~/.secrets/api-key"
}
```

**After** (secure):
```bash
export MY_API_KEY=$(cat ~/.secrets/api-key)
```
```json
{
  "apiKey": "$MY_API_KEY"
}
```

### 2. Global Proxy Deprecated

**Before**:
```json
{
  "proxyUrl": "http://127.0.0.1:7890",
  "providers": [
    {"name": "a", "proxy": "enable"}
  ]
}
```

**After**:
```json
{
  "providers": [
    {"name": "a", "proxy": "http://127.0.0.1:7890"}
  ]
}
```

## 📚 Documentation

New documentation added:

- [`SECURITY-FIXES.md`](SECURITY-FIXES.md) - Detailed security fix explanations
- [`CHANGELOG.md`](CHANGELOG.md) - Full version history
- [`CHANGELOG-proxy.md`](CHANGELOG-proxy.md) - Proxy migration guide
- [`REVIEW-SUMMARY.md`](REVIEW-SUMMARY.md) - Complete code review results
- [`example-proxy-setup.md`](example-proxy-setup.md) - Real-world proxy examples

## 🚀 Upgrade Guide

### Step 1: Check Configuration

```bash
# Check if you use !command syntax
grep -r '!' ~/.pi/agent/custom-providers.json

# If found, migrate to environment variables
```

### Step 2: Update Package

```bash
pi install npm:custom-provider-pi@latest
# Or
pi install --upgrade
```

### Step 3: Verify

```bash
/custom-provider list
/custom-provider test <provider-name>
```

### Step 4: Migrate Proxy (if needed)

If you use global `proxyUrl`, migrate to per-provider `proxy`:

```bash
/custom-provider config edit
# Change "proxyUrl" at root to "proxy" per provider
```

## 📊 Impact Assessment

**Fixed Issues**: 8 critical/high priority bugs  
**Code Changed**: 2400+ lines reviewed, ~200 lines modified  
**Performance Impact**: None (minor improvements in some cases)  
**Breaking Changes**: 2 (command execution, global proxy)  
**Documentation**: 6 new/updated files

## 🔗 Related Issues

- Fixes command injection vulnerability discovered in code review
- Fixes #XX (if you have GitHub issues)
- Addresses proxy configuration limitations

## 💬 Need Help?

- 📖 Read [SECURITY-FIXES.md](SECURITY-FIXES.md) for detailed migration steps
- 💡 See [example-proxy-setup.md](example-proxy-setup.md) for proxy examples
- 🐛 Report issues at https://github.com/MelucaNUAA/custom-provider/issues

## ✅ Checksums

```
SHA256 (custom-provider.ts): [will be added by release process]
```

---

**Recommended Action**: Upgrade immediately to address critical security vulnerabilities.

**Compatibility**: Node.js >=18, pi >=0.84.x
