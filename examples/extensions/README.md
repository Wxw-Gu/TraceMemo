# 扩展示例

两个可直接安装的示例，用来验证扩展中心从安装到发送的完整链路。

| 目录 | 用途 | 申请权限 |
| --- | --- | --- |
| `keyword-bot/` | 消息事件、关键词匹配、Gateway 发送、自动化动作 | `messages.subscribe`、`contacts.list`、`wechat.send.text`、`storage`、`automation.action` |
| `douyin-sender/` | @我 发抖音链接 → 解析 → 下载 → 发回视频；配置页可测试发送 | `messages.subscribe`、`contacts.list`、`wechat.send.video`、`wechat.send.text`、`storage` |

## 安装

TraceMemo → 左侧「扩展」→「安装目录」，选择对应目录即可。

安装后扩展默认**未启用**：

- `keyword-bot` 的 `enabled` 为 `false`，需要在配置页手动打开才会回复；
- `douyin-sender` 依赖本机的 `python3`、Chrome 和抖音解析脚本，安装前先看它自己的 README。

## 测试建议

- 关键词机器人默认监听全部群聊 + 私聊；想只对某个群生效，在「监听范围」里搜索并多选群聊。
- 冷却时间按「会话 + 规则」计算，避免同一句话连续刷屏。
- 扩展的发送走 `tm.wechat.send`，最终仍由 TraceMemo Gateway 做权限、授权校验、限流与审计。

## 开发

扩展目录里只需要 `manifest.json` 与入口文件：

```text
my-extension/
  manifest.json
  ui/index.html
  background/index.js
```

`background/index.js` 导出 `activate(tm)`（或 `module.exports = { activate }`）。页面通过
`postMessage` 与宿主通信，协议见 `docs/extensions/api-reference.md`。
