# WechatExplorer Local HTTP API

WechatExplorer v2.1.9 默认在 `127.0.0.1:6131` 提供 Local HTTP API。

- `GET /api/v1/health` 无需鉴权。
- 其他数据和 Agent endpoint 需要 `Authorization: Bearer <TOKEN>`。
- Token 从 WechatExplorer → API Center → API Token 获取。
- Token 不得放入 URL、仓库或共享配置。

```bash
export WECHATEXPLORER_API_TOKEN="<YOUR_API_TOKEN>"
curl -H "Authorization: Bearer $WECHATEXPLORER_API_TOKEN" \
  http://127.0.0.1:6131/api/v1/recent_chat
```

完整 endpoint 与使用流程见 [Reader Skill](../skill/wechatexplorer-reader/SKILL.md)，安全边界见 [API Security](./api-security.md)。
