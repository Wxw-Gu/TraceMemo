# Query Agent POC

这是独立的开发测试入口，不会修改生产“问问微信”执行链。

先启动 TraceMemo，并在 API Center 开启 Local HTTP API。然后在仓库根目录运行：

```bash
pnpm poc:query-agent "我和BOBO第一次聊了什么"
```

## 两个入口

| 命令 | 行为 | 何时用 |
| --- | --- | --- |
| `pnpm poc:query-agent "问题"` | 先执行完整构建，再运行 | 首次运行，或刚改过代码 |
| `pnpm poc:query-agent:run "问题"` | 直接运行已有构建，**不构建** | 连续迭代测试 |

`poc:query-agent:run` 在构建产物不存在时会明确提示先运行 `pnpm poc:query-agent`，**不会自动构建**。

注意：`poc:query-agent` 内部走的是完整 `electron-vite build`（main + preload + renderer），
即使 POC 只需要一个 main entry。连续测试请使用 `poc:query-agent:run` 以免每次都重建整个 renderer。

## 传参

参数按原样转发给入口，可以被 `--` 分隔（`pnpm run` 惯例）：

```bash
pnpm poc:query-agent -- "BOBO上个月有没有给我发过文件"
pnpm poc:query-agent:run "BOBO上个月有没有给我发过文件"
```

入口只会移除参数列表**开头**的一个独立 `--`；问题正文中的 `--` 会原样保留。

## Provider

POC 使用设置页当前默认 AI Provider、模型、Base URL 和安全存储中的 API Key。Local Query API 仍使用现有 Bearer Token；POC 输出不会打印 Token、API Key、数据库路径或内部消息 ID。

## 输出

**stdout 是 JSON**（`poc:query-agent` 会在它前面混入构建日志，`poc:query-agent:run` 只多两行 pnpm 横幅）。
需要机器解析时用 `--silent` 拿到纯 JSON：

```bash
pnpm --silent poc:query-agent:run "我和BOBO第一次聊了什么" > result.json
```

JSON 字段：

- `question`、`provider`、`model`
- `modelCallCount`、`toolCallCount`
- `modelDurationsMs`（每次模型调用耗时，含失败的那次）
- `modelDiagnostics`（每次模型调用的请求级诊断：HTTP status、content-type、是否返回 HTML、是否超时、耗时）
- `firstModelMs`、`toolTotalMs`、`finalModelMs`、`totalMs`
- 每次工具调用的名称、脱敏参数、耗时、状态和结果数量
- 最终 `answer` 或错误信息

**stderr 是人类可读摘要**（不参与 JSON 解析）：

```text
[Timing]
Model #1         1315 ms
TM Tools(1)       623 ms
Model #2         1598 ms
------------------------
Total            3545 ms
Model total   2913 ms (82.2%)
TM tool total 623 ms (17.6%)

[Provider]
provider       DeepSeek
model          DeepSeek Chat
host           api.deepseek.com
model calls    2
tool calls     1
attempt #1    elapsedMs=1298 status=200 contentType=application/json
attempt #2    elapsedMs=1571 status=200 contentType=application/json
```

`elapsedMs` 是 TTFB（收到响应头），`modelDurationsMs` 是整次调用（含读 body）；502 时两者接近，
说明等待发生在上游网关，不是本地读 body 慢。诊断只记录 host，不记录完整 URL 或任何凭据。非 2xx 响应会先记录 status / content-type / elapsedMs，再返回安全错误（例如“模型服务返回了网页而不是 JSON（HTTP 502 Bad Gateway）”），不会把 HTML 正文丢给 JSON 解析器。

## 约束

工具调用最多 5 次，只允许 `query_messages`、`search_messages`、`message_context`、`conversation_overview`。未配置 AI Provider、Local Query API 未启动或当前 Provider 协议不支持 tools 时，POC 会直接返回错误，不会回退到另一套模型配置。
