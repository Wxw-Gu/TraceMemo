# 扩展开发入门

从克隆源码到创建独立扩展的完整流程见[克隆 TraceMemo 后开发自己的扩展](./clone-and-customize.md)。本页保留 API 用法速查。

## 1. 安装示例

1. 打开 TraceMemo，左侧一级导航点「扩展」。
2. 点「安装目录」，选择 `examples/extensions/keyword-bot`。
3. 列表里出现 **关键词回复机器人**，状态为「已停用」。
4. 点「启用」→「打开页面」；页面顶部的「启用机器人」默认关闭，打开后修改规则并保存。
5. 完全退出并重启 TraceMemo，配置仍在。

`examples/extensions/douyin-sender` 用同样的方式安装；它依赖本机 `python3`、Chrome 和抖音解析脚本，先看它自己的 README。

## 2. 最小扩展

```text
my-extension/
  manifest.json
  ui/index.html
  background/index.js
```

`manifest.json`：

```json
{
  "manifestVersion": 1,
  "id": "com.example.my-extension",
  "name": "我的扩展",
  "version": "1.0.0",
  "apiVersion": "1",
  "minAppVersion": "2.6.0",
  "permissions": ["storage"],
  "entrypoints": { "page": "ui/index.html", "background": "background/index.js" },
  "contributions": { "pages": [{ "id": "settings", "title": "设置" }] }
}
```

`background/index.js`：

```js
module.exports = function activate(tm) {
  tm.log.info('我的扩展已启动')
}
```

`ui/index.html` 里不能直接用 `window.api`。页面通过 postMessage 与宿主通信：

```js
const requestId = `req-${Date.now()}`
parent.postMessage(
  {
    source: 'tracememo-extension-page',
    extensionId: 'com.example.my-extension',
    requestId,
    method: 'storage.get',
    params: { key: 'greeting' }
  },
  '*'
)
window.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.source !== 'tracememo-extension-host' || data.requestId !== requestId) return
  console.log(data.ok ? data.result : data.error)
})
```

页面可调用的方法只有：`storage.get` / `storage.set` / `storage.remove` / `storage.list` /
`capabilities.get` / `extension.info`。

## 3. 订阅消息

manifest 必须同时声明权限与订阅：

```json
{
  "permissions": ["messages.subscribe"],
  "subscriptions": {
    "messageTypes": ["text"],
    "conversationIds": [],
    "requireMentionMe": false,
    "includeSelf": false
  }
}
```

```js
module.exports = function activate(tm) {
  tm.events.on('message.received', async (event) => {
    if (event.isSelf) return
    if (!event.mentionsMe) return
    await tm.wechat.send({
      to: event.conversationId,
      text: '收到',
      dedupeKey: event.eventId
    })
  })
}
```

`dedupeKey` 建议直接用 `event.eventId`：同一条消息重复投递时，Gateway 会按审计记录短路。

## 4. 注册自动化动作

```js
tm.automation.registerAction({
  id: 'douyin.process',
  title: '抖音视频处理',
  description: '处理指定视频链接',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url']
  },
  async handler(input) {
    return {
      success: true,
      output: { url: input.url },
      reply: { type: 'text', text: '已收到链接' }
    }
  }
})
```

扩展中心会展示动作声明与运行时注册状态。当前自动化规则编辑器尚未提供扩展动作选择入口，因此暂时不能从界面配置该动作。宿主侧执行契约与输入结构见[扩展 API 参考](./api-reference.md#自动化动作输入)。

扩展动作返回的 `reply` 由宿主经 Gateway 发送；扩展本身不调用发送接口也能完成回复。

## 5. 开发与调试

- TraceMemo 会把扩展复制到用户数据目录；改完源码后先在扩展中心重新安装同一目录，更新已安装的文件。需要时再「停用 → 启用」重启后台进程。
- 页面资源更新后重新打开或刷新扩展页面。
- 日志在扩展详情页底部，`宿主` 表示生命周期与错误，`扩展` 表示 `tm.log.*` 写入的内容。
- 想看完整后台输出，可以在终端启动 `pnpm dev`，子进程 stderr 会进主进程日志。

## 6. 升级与保留

- 扩展升级只替换代码目录；`storage` 数据与启用状态保留。
- 官方 TraceMemo 升级不触碰 `extensions/`、`extensions-data/`、`extensions-state/`。
- 卸载默认保留数据（v1 界面只提供「保留数据」这一条路径；`keepData: false` 已在 IPC 中实现，界面暂未暴露）。
