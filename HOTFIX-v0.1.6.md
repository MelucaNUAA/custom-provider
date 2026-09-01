# Hotfix v0.1.6 - 紧急修复解析错误

## 问题描述

v0.1.5 版本由于使用了中文引号（`「」`），在某些环境下导致 TypeScript 解析失败：

```
ParseError: G:\: Unexpected token, expected ","
C:/Users/g/.pi/agent/extensions/custom-provider.ts:1373:25
```

## 修复内容

将所有中文引号 `「」` 替换为标准英文引号 `""`，共修改 6 处。

**变更文件**: `custom-provider.ts`  
**变更行数**: 8 行  
**功能影响**: 无（仅修复字符编码问题）

## 升级步骤

### 方式 1: npm 升级（推荐）

```bash
npm install -g custom-provider-pi@latest
# 或使用 pi
pi install npm:custom-provider-pi@latest
```

### 方式 2: 手动替换文件

```bash
curl -o ~/.pi/agent/extensions/custom-provider.ts \
  https://raw.githubusercontent.com/MelucaNUAA/custom-provider/master/custom-provider.ts

# 或 Windows
curl -o %USERPROFILE%\.pi\agent\extensions\custom-provider.ts ^
  https://raw.githubusercontent.com/MelucaNUAA/custom-provider/master/custom-provider.ts
```

### 方式 3: GitHub 安装

```bash
pi install github:MelucaNUAA/custom-provider
```

## 验证修复

```bash
pi --reload
/custom-provider help
```

应该能正常加载，不再报 ParseError。

## npm 版本处理

### v0.1.5（已发布，有问题）

**操作建议**：

1. **标记为废弃**（deprecate）：
   ```bash
   npm deprecate custom-provider-pi@0.1.5 "解析错误，请使用 0.1.6"
   ```

2. **发布 v0.1.6**：
   ```bash
   npm publish
   ```

3. **更新文档**：在 npm 和 GitHub 上标注 v0.1.5 不可用

### 为什么不 unpublish？

- npm 政策：发布 24 小时后不允许 unpublish
- 即使在 24 小时内，unpublish 也会影响已依赖的用户
- deprecate 是更优雅的方式，保留版本历史

## 影响范围

- **受影响版本**: v0.1.5（npm 已发布）
- **修复版本**: v0.1.6
- **功能影响**: 无，仅修复字符问题
- **破坏性变更**: 无

## 时间线

- **2026-08-28 12:00** - v0.1.5 发布到 npm
- **2026-08-28 12:30** - 发现解析错误
- **2026-08-28 12:45** - v0.1.6 修复并发布

## 预防措施

后续发布前增加检查：

1. ✅ 避免使用非 ASCII 引号
2. ✅ 本地测试安装
3. ✅ 在 Windows 和 Linux 上分别验证

## 致歉

对 v0.1.5 的解析错误深表歉意。我们已：

- ✅ 立即发布修复版本 v0.1.6
- ✅ 标记 v0.1.5 为废弃
- ✅ 更新文档提示用户升级
- ✅ 增强发布前测试流程

感谢用户及时反馈！
