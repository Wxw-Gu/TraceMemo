# 本地启动排障

本文面向运行源码开发环境的贡献者。常规启动顺序和测试入口请先阅读[开发、测试与构建](./overview.md)。

## 启动成功的判断标准

执行 `pnpm dev` 后，以下状态同时满足，说明本地开发环境已经可用：

- 控制台显示连接器已生成，例如 `resources/connectors/wechat/win32-x64/wechat-connector.exe`；
- Electron 窗口已打开，或 `http://localhost:5173/` 返回 HTTP `200`；
- 控制台显示 Local HTTP API 正在监听 `http://127.0.0.1:6131`。

`6131` 是应用提供给本机集成使用的 API 端口，不是 Vite 的页面端口。

## WCDB 消息读取诊断

`WCDB_DEBUG_LOGS` 默认关闭。需要排查消息读取链路时，可以在启动命令前设置为 `1`：

```bash
WCDB_DEBUG_LOGS=1 pnpm dev
```

开启后会输出 `GETMSG-xxx` 请求耗时和 native `WCDB-EXPLAIN` 执行计划，不记录聊天正文。取消该环境变量或设为 `0` 即可关闭。

## Go 命令找不到

如果 `pnpm dev` 在构建微信连接器时出现 `spawnSync go ENOENT`，先执行：

```bash
go version
```

命令不可用表示当前终端的 `PATH` 没有找到 Go。Windows 默认安装位置是 `C:\Program Files\Go\bin`。确认 Go 已安装并把该目录加入系统 `PATH` 后，关闭并重新打开终端或 IDE，再重新执行 `go version` 和 `pnpm dev`。

如果 Go 刚完成安装，已经打开的终端不会自动继承新的环境变量；重开终端是必要步骤。不要绕过连接器构建直接启动 `electron-vite dev`，否则 Agent Hub 的微信连接器不会生成。

## Electron 二进制缺失或下载失败

`electron-vite dev` 报 `Electron uninstall`，或 Electron 安装器报 `fetch failed`，通常表示 `node_modules/electron/dist` 中的 Electron 二进制缺失或下载未完成。这不是应用业务代码的启动错误。

**先看根因，别急着删 `node_modules` 重装。** `electron@43` 的 npm 包**不再声明 `postinstall`**（其 `package.json` 里 `scripts` 是空对象），下载改为「首次 `require('electron')` 时的懒加载」。因此：

- `package.json` 里的 `pnpm.onlyBuiltDependencies: ["electron"]` 对它不起作用——上游没有脚本可执行，pnpm 无从下手；
- `pnpm install` 跑完不会有任何二进制被下载，**只重装依赖解决不了这个问题**。

项目已自动兜住这条路径：`scripts/ensure-electron-binary.cjs` 挂在 `postinstall` 与 `predev` 上，校验 `path.txt` 指向的可执行文件是否真的存在（只有 `path.txt` 而没有 `dist/` 同样算没装好），缺失时就地补下载。它读取 `.npmrc` 的 `electron_mirror`（当前为 `https://npmmirror.com/mirrors/electron/`），失败后再兜底重试一次该镜像。

正常情况下你不需要做任何事。只有当自动步骤没有执行时（例如安装时带了 `--ignore-scripts`），才需要手动补一次：

```bash
node scripts/ensure-electron-binary.cjs
```

要换用别的镜像时，显式设置环境变量（优先于 `.npmrc`）。PowerShell 示例：

```powershell
$env:ELECTRON_MIRROR = 'https://your-electron-mirror.example/'
node scripts/ensure-electron-binary.cjs
```

该环境变量只影响当前终端，不会改写仓库中的 `.npmrc`。镜像地址必须保留末尾的 `/`，并提供与 Electron 版本对应的目录结构。

## 页面地址无法通过 IPv4 访问

Vite 在某些 Windows 环境中只监听 IPv6 本机回环地址 `::1`。这时直接访问 `http://127.0.0.1:5173/` 可能失败，但 `http://localhost:5173/` 仍然正常，Electron 也会使用后者加载页面。

排查时优先访问 `http://localhost:5173/`；需要显式验证 IPv6 时，使用 `http://[::1]:5173/`。不要因为 IPv4 回环地址不可用就判断 Electron 或 Vite 启动失败。

## 仍无法启动时

保留首次错误的完整输出，并同时记录操作系统、Node.js、pnpm 和 Go 版本，以及 `pnpm install --frozen-lockfile` 与 `pnpm dev` 的执行结果。不要提交数据库密钥、AI API Key、微信数据路径或聊天内容。
