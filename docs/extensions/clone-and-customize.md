# 克隆 TraceMemo 后开发自己的扩展

本指南说明如何从 TraceMemo 示例开始，编写、安装和调试自己的扩展。扩展代码与 TraceMemo 主程序分开维护；通常只需要写一个扩展目录，不必改 TraceMemo 的业务源码。

本文适用于包含 Extension Center v1 的 TraceMemo 版本，扩展 API 版本为 `1`。较早的源码或安装包如果还没有左侧「扩展」入口，需要先使用包含 Extension Center 的分支或版本。

## 1. 克隆并启动 TraceMemo

先按项目开发文档准备 Node.js 与 pnpm，然后克隆源码、安装依赖并启动开发版：

```bash
git clone https://github.com/Wxw-Gu/TraceMemo.git
cd TraceMemo
pnpm install
pnpm dev
```

`pnpm dev` 启动的是 TraceMemo 开发版。扩展安装后会复制到应用的用户数据目录；修改源码目录里的文件不会自动同步到已安装副本，每次改完都要重新安装同一扩展目录。

## 2. 从示例创建扩展

建议先复制示例，再按功能删改文件：

```bash
cp -R examples/extensions/keyword-bot ../my-tracememo-extension
```

`keyword-bot` 带有规则、匹配与发送逻辑；如果只是做最小扩展，保留 `manifest.json`、`ui/` 与 `storage` 用法，删除 `lib/`、规则 UI 以及 `background` 里的匹配/发送代码即可。

目录通常如下：

```text
my-tracememo-extension/
  manifest.json          扩展身份、入口和权限声明
  background/index.js    可选；后台逻辑，运行于独立 Node 子进程
  ui/                    可选；扩展页面，运行于 sandbox iframe
    index.html
    app.js
    style.css
```

最小扩展只要求有一个页面或后台入口。可先从 `keyword-bot` 保留 `manifest.json`、页面桥与 `storage` 用法，再把 `manifest.json` 中的 `id`、`name`、`description`、`author` 改成自己的信息；`id` 是反向域名格式，例如 `com.example.my-helper`，必须唯一，不能使用 `com.tracememo.`、`tracememo.` 或 `tm.` 前缀。版本采用 `x.y.z` 格式。

示例中的页面脚本也有一个 `EXTENSION_ID` 常量，使用页面桥时要将它改成 manifest 中完全相同的 id。稳定 id 很重要：相同 id 的升级会保留该扩展的配置；换 id 则会被视为另一个扩展。

典型 manifest：

```json
{
  "manifestVersion": 1,
  "id": "com.example.my-helper",
  "name": "我的扩展",
  "version": "1.0.0",
  "apiVersion": "1",
  "minAppVersion": "2.6.0",
  "description": "我的 TraceMemo 扩展",
  "permissions": ["storage"],
  "entrypoints": {
    "page": "ui/index.html",
    "background": "background/index.js"
  },
  "contributions": {
    "pages": [{ "id": "settings", "title": "设置" }]
  }
}
```

`minAppVersion` 是最低应用版本，可按扩展实际依赖调整。入口路径必须是扩展目录内的安全相对路径；安装器会检查 manifest 和入口文件。

## 3. 编写后台逻辑

后台入口导出 `activate(tm)`。TraceMemo 会在扩展启用时启动独立 Node 子进程，并注入 `tm` API：

```js
module.exports = function activate(tm) {
  tm.log.info(`扩展已启动：${tm.extension.id}`)

  tm.events.on('message.received', async (event) => {
    if (event.isSelf || !event.mentionsMe || !event.text) return

    await tm.wechat.send({
      to: event.conversationId,
      text: '收到，我来处理。',
      dedupeKey: event.eventId
    })
  })
}
```

上面这个例子需要在 manifest 中声明 `messages.subscribe`、`wechat.send.text`，并声明消息订阅范围：

```json
{
  "permissions": ["messages.subscribe", "wechat.send.text", "storage"],
  "subscriptions": {
    "messageTypes": ["text"],
    "conversationIds": [],
    "requireMentionMe": true,
    "includeSelf": false
  }
}
```

按需申请权限，不要为了省事把所有权限都加上。高、中风险权限会在启用时要求用户确认；没有获得相应授权的 API 会返回权限错误。微信发送仍经过 TraceMemo 的权限、范围、频率、发送能力和授权校验。

可用 API 包括 `tm.events`、有界的 `tm.messages.query`、`tm.wechat.send`、`tm.ai.chat`、`tm.storage`、`tm.automation.registerAction`、`tm.capabilities.get` 和 `tm.log`。字段、限制与错误码见[扩展 API 参考](./api-reference.md)。仓库的 `packages/extension-sdk/index.d.ts` 只提供类型定义，不是运行时依赖；运行时的 `tm` 由 TraceMemo 注入。

## 4. 编写扩展页面

页面在 sandbox iframe 中运行，不能访问 `window.api`、Node 或 Electron。需要调用宿主白名单功能时，通过 `postMessage` 页面桥通信。可参考 `examples/extensions/keyword-bot/ui/app.js` 里的 `callHost()` 与消息处理，并更新其中的扩展 id。页面桥目前允许存储读写、能力查询、群列表查询（需 `contacts.list`）和扩展信息查询；页面不能直接读取聊天消息、调用 AI 或发送微信。

后台逻辑使用 `tm.storage`；页面则通过页面桥的 `storage.get` / `storage.set` 等方法访问同一扩展的私有存储。

## 5. 在 TraceMemo 中安装和调试

1. 在开发版或已支持扩展的 TraceMemo 中打开左侧「扩展」。
2. 选择「安装目录」，指向 `my-tracememo-extension`。也可以将扩展文件打成 ZIP；`manifest.json` 必须位于 ZIP 根目录，然后选择「安装 ZIP」。
3. 安装完成后，选中扩展并点「启用」。检查权限清单，只确认扩展功能确实需要的权限。
4. 有页面入口时点「打开页面」；检查配置是否读写正常。后台运行日志可在扩展详情页查看。
5. 修改源码后重新安装同一个目录，以更新已安装副本；如后台进程仍未刷新，再停用后重新启用。页面资源更新后重新打开或刷新扩展页面。

同一 `id` 重新安装会更新扩展代码并保留已授予权限、启用状态和扩展存储。卸载默认保留数据；需要清理时再明确选择删除数据。

## 6. 编写和运行测试

纯 JavaScript 扩展可用 Node 内置检查器与测试运行器，不需要把扩展依赖装进 TraceMemo：

```bash
node --check ../my-tracememo-extension/background/index.js
node --test ../my-tracememo-extension/tests/*.test.mjs
```

若扩展放在 TraceMemo 仓库的 `examples/extensions/` 下，也可以参照示例的测试命令，例如：

```bash
node --test examples/extensions/keyword-bot/tests/matcher.test.mjs
```

改动 TraceMemo 扩展宿主、SDK 契约或示例校验时，再运行对应的 TraceMemo 测试：

```bash
pnpm exec vitest run --config vitest.unit.config.ts tests/unit/extension-manifest.test.ts tests/unit/extension-installer.test.ts tests/unit/extension-host.test.ts
pnpm typecheck
```

## 7. 自动化动作

扩展可以在 manifest 中用 `contributions.automationActions` 声明动作，并申请 `automation.action`；后台通过 `tm.automation.registerAction()` 注册实现。动作返回的 `reply` 由 TraceMemo 宿主经统一 Gateway 发送，扩展不应自行绕过 Gateway。

当前版本可以在扩展详情页查看动作是否已注册；自动化规则编辑器尚未提供选择扩展动作的入口，因此目前不能通过界面把这些扩展动作配置到规则中。相关执行接口已在宿主侧实现，界面入口开放后再按产品文档配置。

## 8. 安全与发布前检查

扩展后台虽然运行在独立进程，但这**不是操作系统级沙箱**。它是任意 Node.js 代码，拥有运行 TraceMemo 用户的文件与网络权限。只安装自己编写或信任来源的扩展，不要把不可信扩展当成受隔离代码。

发布前至少确认：

- manifest id 唯一、版本递增、权限最小化，所有入口文件都在扩展目录内；
- 页面只使用受支持的 postMessage 白名单，不假设能访问 Electron API；
- 消息回调处理异常并使用稳定的 `dedupeKey`；
- 单元测试覆盖纯逻辑，人工验证安装、启用、停用、重装和配置保留；
- README 说明扩展行为、权限用途、外部依赖与可能发送的内容。

## 相关资料

- [扩展开发入门与 API 用法](./getting-started.md)
- [扩展 API 参考](./api-reference.md)
- [扩展中心架构](./architecture.md)
- [扩展安全模型](./security.md)
- [可安装示例](../../examples/extensions/README.md)
