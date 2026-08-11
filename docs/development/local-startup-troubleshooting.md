# 本地启动排障

本文面向运行源码开发环境的贡献者。常规启动顺序和测试入口请先阅读[开发、测试与构建](./overview.md)。

## 启动成功的判断标准

执行 `pnpm dev` 后，以下状态同时满足，说明本地开发环境已经可用：

- 控制台显示连接器已生成，例如 `resources/connectors/wechat/win32-x64/wechat-connector.exe`；
- Electron 窗口已打开，或 `http://localhost:5173/` 返回 HTTP `200`；
- 控制台显示 Local HTTP API 正在监听 `http://127.0.0.1:6131`。

`6131` 是应用提供给本机集成使用的 API 端口，不是 Vite 的页面端口。

## Go 命令找不到

如果 `pnpm dev` 在构建微信连接器时出现 `spawnSync go ENOENT`，先执行：

```bash
go version
```

命令不可用表示当前终端的 `PATH` 没有找到 Go。Windows 默认安装位置是 `C:\Program Files\Go\bin`。确认 Go 已安装并把该目录加入系统 `PATH` 后，关闭并重新打开终端或 IDE，再重新执行 `go version` 和 `pnpm dev`。

如果 Go 刚完成安装，已经打开的终端不会自动继承新的环境变量；重开终端是必要步骤。不要绕过连接器构建直接启动 `electron-vite dev`，否则 Agent Hub 的微信连接器不会生成。

## Electron 二进制缺失或下载失败

`electron-vite dev` 报 `Electron uninstall`，或 Electron 安装器报 `fetch failed`，通常表示 `node_modules/electron/dist` 中的 Electron 二进制缺失或下载未完成。这不是应用业务代码的启动错误。

项目的 [`.npmrc`](../../.npmrc) 已设置：

```ini
electron_mirror=https://npmmirror.com/mirrors/electron/
```

pnpm 会把该值传给 Electron 安装器，令其从镜像下载与 `package.json` 锁定版本匹配的二进制文件，避免默认 GitHub 下载源在受限网络中不可访问。

依赖安装被中断或 Electron 目录不完整时，删除不完整的 `node_modules` 后重新安装：

```bash
pnpm install --frozen-lockfile
```

单次安装需要使用其他镜像时，可以临时覆盖项目默认值。PowerShell 示例：

```powershell
$env:ELECTRON_MIRROR = 'https://your-electron-mirror.example/'
pnpm install --frozen-lockfile
```

该环境变量只影响当前终端，不会改写仓库中的 `.npmrc`。镜像地址必须保留末尾的 `/`，并提供与 Electron 版本对应的目录结构。

## 页面地址无法通过 IPv4 访问

Vite 在某些 Windows 环境中只监听 IPv6 本机回环地址 `::1`。这时直接访问 `http://127.0.0.1:5173/` 可能失败，但 `http://localhost:5173/` 仍然正常，Electron 也会使用后者加载页面。

排查时优先访问 `http://localhost:5173/`；需要显式验证 IPv6 时，使用 `http://[::1]:5173/`。不要因为 IPv4 回环地址不可用就判断 Electron 或 Vite 启动失败。

## 仍无法启动时

保留首次错误的完整输出，并同时记录操作系统、Node.js、pnpm 和 Go 版本，以及 `pnpm install --frozen-lockfile` 与 `pnpm dev` 的执行结果。不要提交数据库密钥、AI API Key、微信数据路径或聊天内容。
