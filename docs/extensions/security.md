# 扩展安全模型（v1）

## 信任分级

| 类型 | 说明 | 本版支持 |
| --- | --- | --- |
| 声明式 UI 扩展 | 只有页面，使用白名单存储 / 能力查询 | 是 |
| 受信任本地代码扩展 | 后台是任意 Node 代码，可读写本机文件 | 是（安装即视为信任） |

**独立进程不等于强沙箱。** 后台子进程（`ELECTRON_RUN_AS_NODE`）拥有运行用户的全部
Node 能力，因此扩展作者可以读写本机文件、发起网络请求。本版不声称限制了这些——
它限制的是**TraceMemo 内部能力**：

- 拿不到数据库句柄、数据库密钥、授权凭据、Native Runtime 句柄；
- 不能直接调用 WCHook / dylib / 4290 发送接口；
- 不能 `require` 官方主进程模块；
- 不能伪造宿主可信元数据（`origin` / `purpose` / `triggerType` / 幂等键）。

## 进程与权限

```text
主进程 ── fork ──▶ 扩展子进程（每扩展一个）
                     │ 只注入 tm
                     ▼
              白名单 RPC（method + params）
                     │
               宿主再次校验权限
```

两侧都检查权限：子进程提前失败给出明确错误码，宿主侧才是权威判定。
子进程崩溃 / 挂死不影响主进程：宿主有启动超时、调用超时、退避重启与熔断。

## 发送安全

```text
扩展声明「发什么」
   ↓
宿主填 origin=extension / purpose=extension_send / recipient 类型 / 幂等键
   ↓
ExtensionSendGateway：权限 → 会话范围 → 频率 → 本机能力 → 授权校验
   ↓
WechatActionGateway：用途白名单 + `extension_*` 必须来自 origin=extension
   ↓
WechatSendGateway：真实发送 + Send Log
```

- 扩展不能在请求里指定 `purpose`，因此无法借用 `manual_*` / `api_*` 等用途绕过白名单。
- 自动化草稿里的 `extensionAction` 只保存扩展 id、动作 id 与静态输入；
  发送内容由扩展返回，发送动作由 runner 发起，幂等键由 `executionId` 派生。
- 授权只在主进程判定：macOS 读 Native license（要求 `authorized === true`），
  Windows 探测 `/license/status` 只接受 `LICENSE_OK`。UI 上的 `ready` 不作为授权依据。

## 页面安全

- 自定义协议 `tm-extension://<id>/<path>`，每次请求 realpath 复核目录归属；
- iframe `sandbox="allow-scripts"`：无 same-origin、无 Node、无 preload、无 `window.api`；
- 响应头 CSP：`default-src 'self'`、`script-src 'self'`、`connect-src 'none'`、
  `object-src 'none'`、`base-uri 'none'`、`form-action 'none'`；
- 页面只能调用 `storage.*` / `capabilities.get` / `contacts.listGroups` / `extension.info`；
  `contacts.listGroups` 只返回群名称与会话 id，且要求 manifest 声明 `contacts.list`。

## 安装安全

ZIP 安装校验：

1. 包大小 ≤ 100MB、文件数 ≤ 2000、单文件 ≤ 20MB、解压总量 ≤ 50MB；
2. 条目路径规范化后判重（大小写不敏感），拒绝 `..`、绝对路径、盘符、保留名；
3. 拒绝 `SymbolicLink` 与非常规条目；
4. 先解压到 `extensions-staging`，校验 manifest 与入口存在后才原子改名；
5. 目标已存在时先改名备份，替换失败自动回滚。

目录安装同样拒绝符号链接与非普通文件，并遵守同样的体积 / 数量上限。

## 隐私

- 宿主日志只记录生命周期、错误摘要与数量，不写聊天正文、昵称、wxid、群名、路径；
- `message.received` 只在扩展声明 `messages.subscribe` 且用户启用后才投递；
- 扩展自己写 `tm.log.*` 的内容会落盘并展示，作者需自行遵守隐私约定；
- 扩展存储按 id 隔离，路径来自已校验的 id，不接受任意目录。

## 已知边界（v1 未解决）

- 后台代码的文件 / 网络权限未做系统级限制（无 seatbelt / AppContainer）；
- 页面与后台共享 `storage`，因此页面能读到后台写入的任何配置；
- 没有签名校验与来源可信度分级，安装来源完全依赖用户选择；
- 事件投递是「至多一次」：进程重启或过载时可能丢事件，扩展需要用 `eventId` 自行幂等。
