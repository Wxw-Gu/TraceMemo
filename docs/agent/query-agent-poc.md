# Query Agent POC

这是独立的开发测试入口，不会修改生产“问问微信”执行链。

先启动 TraceMemo，并在 API Center 开启 Local HTTP API。然后在仓库根目录运行 例：

```bash
pnpm poc:query-agent -- "我和BOBO第一次聊了什么"
```

也可以直接传入其他自然语言问题：

```bash
pnpm poc:query-agent -- "BOBO上个月有没有给我发过文件"
```

POC 使用设置页当前默认 AI Provider、模型、Base URL 和安全存储中的 API Key。Local Query API 仍使用现有 Bearer Token；POC 输出不会打印 Token、API Key、数据库路径或内部消息 ID。

输出为 JSON，包含：

- `question`、`provider`、`model`
- `modelCallCount`、`toolCallCount`
- `firstModelMs`、`toolTotalMs`、`finalModelMs`、`totalMs`
- 每次工具调用的名称、脱敏参数、耗时、状态和结果数量
- 最终 `answer` 或错误信息

工具调用最多 5 次，只允许 `query_messages`、`search_messages`、`message_context`、`conversation_overview`。未配置 AI Provider、Local Query API 未启动或当前 Provider 协议不支持 tools 时，POC 会直接返回错误，不会回退到另一套模型配置。
