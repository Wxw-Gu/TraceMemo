# WechatExplorer v2.1.9 API Authentication

v2.1.9 为 Local HTTP API 增加 Bearer Token 鉴权。这是有意的 breaking change。

- v2.1.8：`GET /api/v1/contact` 可能直接返回数据。
- v2.1.9：相同请求必须携带 `Authorization: Bearer <TOKEN>`，否则返回 `401`。
- `GET /api/v1/health` 保持公开。
- 老用户升级后会自动生成并安全保存 Token，不改变原有 apiEnabled、host 或 port 设置。
- Token 可在 WechatExplorer → API Center 中显示、复制和重新生成。

Reader Skill 和本地 Agent 需要使用 `WECHATEXPLORER_API_TOKEN` 更新本机配置。
