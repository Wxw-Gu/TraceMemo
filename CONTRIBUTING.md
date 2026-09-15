# 参与贡献

> 这份文档同时写给人和 AI Agent。文末有给 Agent 的英文硬性规则。
> 如果你只是想把 TraceMemo 跑起来，看[第一次使用](./docs/user-guide/getting-started.md)就够了。

## 一句话规则

**从 `develop` 拉分支，把 PR 提给 `develop`。**

## 为什么不是 main

| 分支      | 是什么                                                  | 接受 PR 吗     |
| --------- | ------------------------------------------------------- | -------------- |
| `main`    | 稳定版。只在发版时更新，对应 GitHub Releases 里的安装包 | 不接受         |
| `develop` | 开发主线。所有改动先进这里，**随下一个版本一起发布**    | 唯一的目标分支 |

指向 `main` 的 PR、或者不是基于 `develop` 拉出来的分支，会被直接关闭。不是不欢迎贡献，而是因为冲突合并 提交落后较多等原因

## 提 PR 的完整流程

```bash
# 1. 基于 develop 拉分支（不要基于 main）
git fetch origin
git checkout -b feat/your-change origin/develop

# 2. 改代码，只改与本任务相关的文件

# 3. 自检
pnpm install        # 需要 Node 22 与 pnpm 7.33.7
pnpm typecheck
pnpm test:unit      # 再按改动范围补跑 component / integration

# 4. 提交
git commit -m "feat: 一句话说明改了什么"

# 5. 提 PR，目标分支必须是 develop
gh pr create --base develop --head feat/your-change
```

## 提交信息

默认**只写一行标题**：类型前缀 + 一句话说明。

```
feat: 新增本地查询能力
fix: 修复查询工具时间契约
docs: 整理开发文档
```

确实包含多个功能点时，标题之后每个功能点各写一行纯文本 —— 不要用列表符号，也不要写
「设置侧：」「测试：」这类分节标题：

```
feat: 统一手动发送入口为文字转语音
移除普通文本、图片和本地语音的手动发送入口
保留文字转语音的生成、试听和发送能力
```

不要在提交信息里堆文件名清单、测试结果或实现过程叙述，那些属于 PR 描述。

## 分支命名

`feat/…`、`fix/…`、`docs/…`、`refactor/…`，后面接简短的英文或拼音描述。

## PR 前自检

| 你的改动                   | 至少跑这些                                                        |
| -------------------------- | ----------------------------------------------------------------- |
| 一般代码 / 服务 / 工具函数 | `pnpm typecheck` + 相关 `pnpm test:unit`                          |
| 界面 / 交互                | `pnpm typecheck` + 相关 `pnpm test:component`，或针对该功能的 E2E |
| preload / IPC 契约         | `pnpm typecheck` + 相关 contract 测试或 `pnpm test:integration`   |
| 只改文档                   | 不需要跑测试                                                      |

全部测试命令见 `package.json` 的 `scripts`；本地开发环境的说明见[开发概览](./docs/development/overview.md)。

## 请不要提交这些东西

- **构建产物**：`out/`、`dist/`、`build/` 下的二进制、`node_modules/`、`test-results/`、`playwright-report/`
- **真实数据**：微信聊天内容、真实的 wxid / 群名 / 联系人名、聊天截图
- **密钥**：API Key、Token、数据库密钥、图片解密密钥
- **本机绝对路径**：`/Users/…`、`C:\Users\…`

测试用的假数据请用一眼能看出是合成的命名，例如 `fixture-group`、`wxid_fixture_member`。

## 合入之后

PR 合进 `develop` 不会立刻出现在下载页，它随**下一个版本**发布。想提前用上，可以自行从
`develop` 构建。

## 如果你是 AI Agent

请按顺序执行，不要凭直觉选分支：

1. **基线**：`git fetch origin && git checkout -b <branch> origin/develop`。永远不要基于 `main`。
2. **PR 目标**：`gh pr create --base develop`。无法确定时默认 `develop`；任何情况下都不要把
   `main` 当 PR 目标。
3. **改动范围**：只改与本任务相关的文件。不要顺手格式化、重排 import、升级依赖。
4. **提交前**：跑 `pnpm typecheck` 和与本次改动相关的测试（见上表）。
5. **提交信息**：一行标题，`type: 描述`。不要写文件清单、测试输出或过程叙述。
6. **PR 描述**：说明改了什么、为什么改、怎么验证的；关联 Issue 用 `closes #123`。
7. **禁止**：真实聊天数据、密钥、Token、本机绝对路径、构建产物。

### Hard rules for AI agents (English)

- Base branch: `origin/develop`. Never branch off `main`.
- Open pull requests with base branch `develop`. PRs targeting `main` are closed without review.
- One PR = one logical change. No drive-by reformatting, import reordering, or dependency upgrades.
- Before opening a PR, run `pnpm typecheck` plus the tests relevant to your change.
- Commit subject: a single line, `type: summary`. No file lists, no test logs, no process narration.
- Never commit build output (`out/`, `dist/`, `test-results/`, `playwright-report/`), real WeChat
  data, keys, tokens, or absolute local paths.
- Changes merged into `develop` ship with the next release.
