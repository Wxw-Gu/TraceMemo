# TraceMemo 2.1.9：Local HTTP API 鉴权迁移

2.1.9 为 Local HTTP API 增加 Bearer Token 鉴权。这是一次有意的兼容性变化：除健康检查外，数据接口不再接受裸请求。

- 历史版本中，`GET /api/v1/contact` 等数据请求可能直接返回内容；
- 2.1.9 中，相同请求必须携带 `Authorization: Bearer <TOKEN>`，否则返回 `401`；
- `GET /api/v1/health` 保持公开；
- 升级后应用会生成并安全保存 Token，原有 API 启用状态、监听地址和端口设置保持不变；
- Token 可在 TraceMemo → API Center 中显示、复制和重新生成；
- Reader Skill、Codex、Claude Code、OpenClaw 和其他本地 Agent 需要在自己的环境中设置 `WECHATEXPLORER_API_TOKEN`。

如果旧 Agent 无法访问，请先从 API Center 复制当前 Token，再确认每个非 health 请求都带有 Bearer header。完整规则见[API 安全](./api-security.md)。
