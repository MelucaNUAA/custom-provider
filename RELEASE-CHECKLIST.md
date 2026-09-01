# Release v0.1.5 - Checklist

## ✅ GitHub Release (COMPLETED)

- [x] Code committed to master
- [x] Version bumped to 0.1.5 in package.json
- [x] Git tag v0.1.5 created
- [x] Pushed to GitHub
- [x] Tag pushed to GitHub

**Commit**: `6b21b68`  
**Tag**: `v0.1.5`  
**Remote**: https://github.com/MelucaNUAA/custom-provider.git

## 📝 GitHub Release Page

To create the release on GitHub:

1. Go to: https://github.com/MelucaNUAA/custom-provider/releases/new

2. **Choose tag**: `v0.1.5`

3. **Release title**: 
   ```
   v0.1.5 - Security Fixes & Per-Provider Proxy
   ```

4. **Description**: Copy content from `RELEASE-NOTES-v0.1.5.md`

5. **Mark as**: Pre-release ❌ | Latest release ✅

6. **Generate release notes**: Optional (we have manual notes)

7. Click **Publish release**

## 📦 npm Release (TODO)

Before publishing to npm:

### 1. Final Verification

```bash
# Check package.json
cat package.json | grep version
# Should show: "version": "0.1.5"

# Check files field
cat package.json | grep -A 5 '"files"'
# Should include: custom-provider.ts, README.md, LICENSE

# Verify .gitignore excludes test files
cat .gitignore
```

### 2. Test Installation

```bash
# Test local installation
cd /tmp
npm pack /path/to/custom-provider
tar -tzf custom-provider-pi-0.1.5.tgz
# Should NOT contain test files, node_modules, etc.
```

### 3. Publish to npm

```bash
# Dry run first
npm publish --dry-run

# Actual publish
npm publish

# Or with tag for pre-release
npm publish --tag beta
```

### 4. Verify Published Package

```bash
# Check on npm
npm view custom-provider-pi

# Test installation
npm install -g custom-provider-pi@0.1.5

# Or with pi
pi install npm:custom-provider-pi@latest
```

## 📢 Announcement (Optional)

After npm publish, you can announce:

### 1. GitHub Discussions/Issues

Post in your project's discussions or create announcement issue:

```markdown
📢 **custom-provider v0.1.5 Released**

Critical security fixes + per-provider proxy configuration!

🔒 **Security**: Fixed 3 critical vulnerabilities
✨ **New**: Independent proxy config for each provider
📚 **Docs**: Complete migration guides included

Upgrade now: `pi install npm:custom-provider-pi@latest`

Details: https://github.com/MelucaNUAA/custom-provider/releases/tag/v0.1.5
```

### 2. npm Package Page

npm will automatically pull README from the package.

### 3. Social Media (Optional)

Twitter, Reddit r/programming, etc.

## 🔍 Post-Release Verification

After npm publish:

- [ ] Check npm package page: https://www.npmjs.com/package/custom-provider-pi
- [ ] Verify version shows v0.1.5
- [ ] Check download stats after 24h
- [ ] Monitor GitHub issues for problems
- [ ] Check npm install works: `pi install npm:custom-provider-pi@latest`
- [ ] Test basic functionality: `/custom-provider list`

## 🐛 Rollback Plan (If Needed)

If critical issues discovered:

### Option 1: Deprecate on npm
```bash
npm deprecate custom-provider-pi@0.1.5 "Critical issue, use 0.1.4"
```

### Option 2: Unpublish (within 24h)
```bash
npm unpublish custom-provider-pi@0.1.5
```

### Option 3: Quick Fix Release
```bash
# Fix issue
# Bump to v0.1.6
# Release v0.1.6
```

## 📋 Files Included in Release

**Source Files**:
- ✅ custom-provider.ts (main plugin)
- ✅ package.json
- ✅ README.md
- ✅ LICENSE

**Documentation**:
- ✅ CHANGELOG.md
- ✅ CHANGELOG-proxy.md
- ✅ SECURITY-FIXES.md
- ✅ REVIEW-SUMMARY.md
- ✅ example-proxy-setup.md

**Not Included** (filtered by .gitignore and package.json files field):
- ❌ test-proxy.ts
- ❌ test-proxy-config.json
- ❌ node_modules/
- ❌ pnpm-lock.yaml
- ❌ *.bak

## 📊 Release Metrics

**Version**: 0.1.5  
**Commit**: 6b21b68  
**Files Changed**: 10  
**Lines Added**: 1279  
**Lines Removed**: 116  
**Critical Fixes**: 3  
**Total Fixes**: 8  
**New Docs**: 6 files  

## ✅ Summary

**GitHub**: ✅ DONE (pushed)  
**npm**: ⏳ TODO (manual)  
**Announcement**: ⏳ Optional  

Next step: Publish to npm with `npm publish`
