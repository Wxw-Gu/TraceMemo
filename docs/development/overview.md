# 开发、测试与构建

本文面向希望参与 TraceMemo 开发、验证文档或维护集成的贡献者。普通用户请从[第一次使用](../user-guide/getting-started.md)开始。

## 技术基线

- Electron + React + TypeScript；
- pnpm 7+；
- 平台对应的 Electron/native 构建环境。

产品文档的事实来源优先级是：当前源码 → 当前 UI/Renderer → 测试 → package/config → README/docs → 历史资料。功能、API、版本、隐私和兼容性变更时，不要只改 README。

## 本地开发

```bash
pnpm install
pnpm dev
```

本地依赖安装与 Electron 二进制下载异常，请查看[本地启动排障](./local-startup-troubleshooting.md)。

常用检查：

```bash
pnpm typecheck
pnpm test:unit
pnpm test:component
pnpm test:integration
pnpm test:e2e:build
```

完整测试入口 `pnpm test` 还会运行 Skill 安装指令、构建和 Playwright 测试；需要对应平台环境。

## 代码变更对应文档

| 代码区域                                                                 | 需要同步检查的文档                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `src/shared/ai-search.ts`、AI Search pipeline                            | `user-guide/ai-search.md`、`concepts/answer-sources.md`                        |
| `src/shared/knowledge.ts`、`src/main/knowledge/`                         | `user-guide/knowledge.md`、`concepts/how-it-works.md`                          |
| `src/shared/voice-recognition.ts`                                        | `user-guide/voice.md`                                                          |
| `src/shared/group-report.ts`、报告 UI                                    | `user-guide/report.md`、API/Agent 文档                                         |
| `src/shared/export.ts`、导出服务/UI                                      | `user-guide/export.md`                                                         |
| `src/main/services/system-ocr-service.ts`、`image-text-index-service.ts` | `user-guide/knowledge.md`、`concepts/how-it-works.md`、`user-guide/privacy.md` |
| `src/main/services/image-insight-service.ts`、AI Provider                | `user-guide/report.md`、`user-guide/privacy.md`                                |
| `src/shared/automation.ts`、自动化服务与执行网关                         | `user-guide/report.md`、`concepts/how-it-works.md`、`docs/README.md`           |
| `src/shared/local-api-test.ts`、`src/main/http-server.ts`                | `agent/api.md`、`api-security.md`、打包 Skill                                  |
| Agent Hub service/UI                                                     | `agent/agent-hub.md`、`user-guide/privacy.md`                                  |
| 设置导航、连接页面                                                       | `user-guide/getting-started.md`、`docs/README.md`                              |

两条容易被写错的边界：

- **防撤回已下线**（`src/main/services/recall-archive-service.ts` 保留但不再启动）：设置入口隐藏，`recallProtectionEnabled` 在所有读写路径上被强制收敛为 `false`。不要把它写回用户指南。
- **图片文字索引（本机 OCR）与图片理解（需要 Provider）是两条不同的路径**：前者写入本地索引、能被搜索，且不联网；后者只在日报和设置里的模型检测中使用。改其中一条时不要把另一条的隐私口径带过去。

## 文档检查

提交文档变更前至少执行：

```bash
git diff --check
# 过时版本号、旧品牌名、旧结构叙述、MCP 误解
rg -n "v2\.1\.7|2\.4\.0|v2\.2\.0 兼容期|无鉴权|mcpServers" README.md docs --glob '*.md' --glob '!development/overview.md'
# 不存在的产品结构（定时日报已并入自动化）
rg -n "日报 → 定时日报|Monitor / Automation" README.md docs --glob '*.md'
```

历史迁移说明可以出现旧版本号；正式使用指南不要把过时版本写成当前版本。负向澄清“6131 不是 MCP Server”可以保留，以防用户照抄错误配置。发版前额外确认 `README.md` 里的版本号与 `package.json` 的 `version` 一致。
