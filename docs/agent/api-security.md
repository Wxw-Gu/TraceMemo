# Local HTTP API 安全

## 当前安全边界

TraceMemo 的本地 API 默认监听 `127.0.0.1:6131`。它面向同一台电脑上的 API Center、Reader Skill、CLI 和 Agent，不是公网网关，也不是带用户账户和细粒度权限 Scope 的服务。

## Bearer Token

新 Agent 配置使用 `TRACEMEMO_API_TOKEN`。v2.2.0 仍兼容读取历史变量 `WECHATEXPLORER_API_TOKEN`，优先级为新变量高于旧变量。

- `/api/v1/health` 是公开健康检查；
- 其他所有端点都要求 `Authorization: Bearer <TOKEN>`；
- Token 由应用生成，使用 32 个随机字节编码；
- Token 由 Electron `safeStorage` 加密保存在用户数据目录的 `local-api-token.bin`；
- 文件权限设置为 `0600`；
- 在“API Center”中可以显示、复制和重新生成；
- 重新生成后旧 Token 立即失效。

应用不会自动把 Token 写入 Codex、Claude Code、OpenClaw 或其他 Agent 配置。请把它放进 Agent 自己的本地 secret/environment，例如：

```bash
export TRACEMEMO_API_TOKEN="<TOKEN>"
```

## CORS 与 Origin

带浏览器 `Origin` 的请求只允许精确的 HTTP loopback Origin：

- `http://localhost` 及其端口；
- `http://127.0.0.1` 及其端口；
- `http://[::1]` 及其端口。

不带 `Origin` 的 curl、Node、本地脚本和 Agent 请求不受浏览器 CORS 规则限制，但仍必须携带 Token（health 除外）。

## 不要做的事

- 不要把 Token 放入 URL query、日志、截图、公开 Skill 或 Git；
- 不要把服务反向代理到公网；
- 不要把“health 能访问”误认为数据端点无需授权；
- 不要把 Bearer Token 当成跨用户权限系统；当前服务没有细粒度 Scope；
- 不要在共享机器上让不可信进程继承 Token 环境变量。

## Token 不可用时

如果系统安全存储不可用，API Token 会无法生成或读取，本地 API 会安全停用。先修复系统钥匙串/凭据服务，再回到 API Center 重试。不要手动编辑 `local-api-token.bin`。

## 相关文档

- [Agent 接入概览](./overview.md)
- [Reader Skill](./reader-skill.md)
- [数据、隐私与安全](../user-guide/privacy.md)
- [v2.1.9 鉴权迁移说明](./release-notes-v2.1.9.md)
