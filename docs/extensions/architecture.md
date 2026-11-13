# 扩展中心架构（v1）

## 目标

把用户二次开发从官方源码里剥离：扩展装在自己的目录、走稳定的 SDK、由宿主做权限与能力检查。
官方升级只替换应用本体，不触碰扩展目录与数据目录。

## 分层

```text
TraceMemo Core（Electron 主进程 / 渲染层）
        │
ExtensionManager ─── ExtensionRegistry（启用状态 / 授权集合）
        │             ExtensionInstaller（目录 / ZIP 安装，原子替换）
        │             ExtensionLogStore（日志）
        │             ExtensionActionRegistry（自动化动作）
        │             ExtensionEventBus（消息事件分发）
        │
   ExtensionHost（每个扩展一个 Node 子进程）
        │  require(background/index.js)，注入 tm
        │
   tm.*  ── 白名单 RPC ──▶ 宿主能力
                           ├─ storage       → extensions-data/<id>
                           ├─ messages.query→ chat-service（有界窗口）
                           ├─ wechat.send   → ExtensionSendGateway → WechatActionGateway
                           ├─ ai.chat       → AIProviderService
                           └─ capabilities  → 只读快照
```

关键边界：

- **主进程从不 `require` 扩展代码**；扩展只在子进程里加载。
- 扩展不 import 官方业务模块，只通过 JSON RPC 申请能力。
- 发送、消息读取、AI 调用全部复用既有服务，没有第二套监听或发送实现。

## 目录

```text
<userData>/
  extensions/<id>/            代码（manifest.json / ui / background）
  extensions-data/<id>/       扩展私有数据（storage.json）
  extensions-state/           宿主状态
    registry.json             启用状态与已授予权限
    logs/<id>.jsonl           运行日志（轮转一份 .1）
  extensions-staging/         安装临时目录（成功后原子改名）
```

三者分离的原因：

| 场景 | 结果 |
| --- | --- |
| 官方应用升级 | `userData` 不变，扩展与配置原样保留 |
| 扩展升级（同 id 新版本） | 只替换 `extensions/<id>`，`extensions-data` 不动 |
| 卸载并选择保留数据 | 删除代码目录，保留 `extensions-data` |
| 卸载并清除数据 | 同时删除数据目录与日志 |

## 生命周期

```text
install → 校验 manifest / 入口 → 临时目录 → 原子替换 → 登记（默认未启用）
enable  → 授予 manifest 声明的权限 → 启动子进程 → activate 握手 → active
message → ExtensionEventBus 去重 → 按 subscriptions 过滤 → 投递给子进程
action  → 自动化 runner → ExtensionHost.invokeAction → 返回 reply / output
disable → 停止子进程 → 撤销高风险权限（仅保留 storage）→ inactive
upgrade → 停进程 → 替换目录 → 保留 enabled 与授权 → 重启
```

崩溃处理：子进程异常退出时按 1s / 2s / 4s 退避重启，5 分钟内超过 3 次标记为
`crashed` 并停止自动重启，等用户手动停用再启用。

## 消息事件

- 事件来源只有 `MessageListenerService` 的规范化结果，不直连数据库。
- `eventId = message:<sha1(sessionId:localId)>`，同一条消息稳定不变。
- `mentionsMe` 来自 `source.atuserlist` ∩ 当前账号 username；拿不到自身身份时为 `false`。
- 分发前做 manifest 级过滤（消息类型 / 会话范围 / 是否 @我 / 是否包含自己）。
- 子进程侧有令牌桶（容量 100，按 60/秒补充）；超出时丢弃并记一条 warn，
  不让扩展拖慢主进程监听循环。

**已知降级**：旧 Native Runtime 的事件不带 `sessionId`，监听层只能回读「最近活跃会话」。
事件总线不掩盖这一点，自动化状态与扩展能力快照都按「降级」标记。

## 发送链路

```text
tm.wechat.send
  → ExtensionHost（权限检查）→ ExtensionSendGateway（权限 / 范围 / 频率 / 能力 / 授权校验）
  → WechatActionGateway.executeFromExtension（origin=extension, purpose=extension_send）
  → WechatSendGateway → Windows / macOS sender
```

自动化动作返回的 `reply` 走同一条 Gateway，但 purpose 是 `extension_action`，
幂等键由 `executionId` 派生。扩展无法传入 `origin` / `purpose` / `triggerType`。

## 与自动化的关系

- 扩展注册动作，自动化负责触发、过滤、冷却、幂等、执行日志。
- 自动化规则里的 `extensionAction` 只保存 `extensionId + actionId + 静态 input`；
  卸载扩展后规则**保留**，执行时明确报 `EXTENSION_NOT_FOUND`，不会静默删除用户配置。
