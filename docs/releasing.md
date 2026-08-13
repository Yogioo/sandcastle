# 发布 `@yogioo/sandcastle`

给维护者：如何发 npm 包，以及 GitHub Actions 里 **CI** / **Release** 怎么触发。

包名：`@yogioo/sandcastle`  
Registry：https://www.npmjs.com/package/@yogioo/sandcastle  
Actions：https://github.com/Yogioo/sandcastle/actions

发版用 [Changesets](https://github.com/changesets/changesets)，不要手改 `package.json` 的 `version`。CI 通过 npm **Trusted Publisher（OIDC）** 发包，仓库里不需要 `NPM_TOKEN`。

## 日常发版

1. 改代码，照常提交。
2. 加一条 changeset（和代码一起 commit）：

```powershell
npx changeset
```

按改动选版本类型：

| 类型 | 例子 | 什么时候用 |
|------|------|------------|
| `patch` | `0.13.0` → `0.13.1` | 修 bug、内部修复。1.0 之前的不兼容变更也先用 `patch`。 |
| `minor` | `0.13.0` → `0.14.0` | 新功能、兼容的 API 增加 |
| `major` | `0.13.0` → `1.0.0` | 1.0 之后的不兼容变更 |

写一句摘要。会生成 `.changeset/<id>.md`。

3. 推到 `main`，或开 PR 再合并进 `main`。

**没有 changeset 的普通 push 不会发新包。** 要发版就必须带 changeset。

## 推到 `main` 之后

每次 push `main` 会跑两个 workflow：

| Workflow | 文件 | 做什么 |
|----------|------|--------|
| **CI** | `.github/workflows/ci.yml` | `npm ci`、build、test |
| **Release** | `.github/workflows/release.yml` | 处理 changeset，或发布到 npm |

### Release 分两拍

**第一拍**（刚合进带 changeset 的提交）  
Changesets 发现 `.changeset/` 里有待发布说明，会自动开 **Version Packages** PR：升降 `package.json` 版本、更新 `CHANGELOG.md`、删掉已消费的 changeset。这时 **还不会发 npm**。

**第二拍**（合并那个 Version Packages PR）  
再跑一次 Release。没有剩余 changeset，且本地版本比 npm 新，就会用 GitHub OIDC 发布。不需要本地 `npm login`，也不用浏览器 2FA。

合并后过一两分钟，到 npm 上确认新版本。用户更新：

```powershell
npm install -g @yogioo/sandcastle
```

## 如何触发 CI / Release

- **自动：** 向 `main` 的每一次 push（含合并 PR）。
- **手动：** 打开 [Actions](https://github.com/Yogioo/sandcastle/actions)，选 **CI** 或 **Release**，点 **Run workflow**，分支选 `main`。

当前没有新版本可发时，手动或普通 push 跑 Release 可能失败（`changeset publish` 会尝试重发已发布版本，被 npm 拒绝）。这不代表 Trusted Publisher 坏了。真正验证发包，走上面的两拍流程。

## 本地紧急发布

只在 GitHub 发不出去、又必须立刻上线时使用：

```powershell
npm run build
npm publish --access public
```

需要已登录且对 `@yogioo` 有权限的 npm 账号。若开启 2FA，命令会弹出浏览器确认。发完后把版本变更（若尚未提交）推到 `main`。

## 相关文件

- `.changeset/config.json` — Changesets 配置（`access: public`，`baseBranch: main`）
- `package.json` 的 `release` 脚本 — `changeset publish`
- `package.json` 的 `publishConfig.access` — `public`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
