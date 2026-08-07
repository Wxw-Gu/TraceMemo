# Reader Skill Authentication

WechatExplorer Reader 是 Local HTTP API Skill，不是 MCP Server。

1. 打开 WechatExplorer → API Center。
2. 确认 API 和数据库已就绪。
3. 在 API Token 区域复制 Token。
4. 将它保存到 Agent 自己的本地环境配置：`WECHATEXPLORER_API_TOKEN=<YOUR_API_TOKEN>`。
5. 安装 Reader Skill，并让所有数据请求携带 `Authorization: Bearer $WECHATEXPLORER_API_TOKEN`。

Codex、Claude Code、OpenClaw 和其他 Agent 均使用相同的 HTTP Bearer Token 模型。WechatExplorer 不会自动把 Token 写入任何 Agent 配置。
