# 企业微信插件会话：只读验收报告

本文记录 Mac 微信 4.x 企业微信插件会话（群 `*@qy_g`、单聊 `*@qy_u`）在 TraceMemo 中的
真实数据验收结果，用于回答 review 中「需要真实环境证据」的那一项。

结论先行：**会话列表、群名、群成员、消息、发送者、图片六条链路在真实库上都已跑通**，
且全程只读；报告中所有会话 id、群名、成员名、消息正文均以 sha256 前缀代替，不含原文。

## 验收环境

| 项 | 值 |
| --- | --- |
| 客户端 | Mac 微信 4.x（企业微信插件会话已存在） |
| 账号规模 | 5521 个会话，其中企业会话 7 个 = 5 个 `@qy_g` 群 + 2 个 `@qy_u` 单聊 |
| 消息库 | `db_storage`（会话/消息）+ `bizchat/bizchat.db`（企业群名与成员） |
| 运行方式 | 以只读模式（`TRACEMEMO_READ_ONLY=1`）直接调用主进程的 `Wcdb4Client` / `chat-service` |
| 数据隔离 | 数据库目录用 APFS clone（写时复制）复制后再读；媒体目录只做 `existsSync`/`readFileSync` |

### 只读是怎么保证的

1. 数据库侧：`src/main/wcdb4-client.ts` 中不存在 `writeFileSync` / `mkdirSync` / `renameSync` /
   `unlinkSync` 等写调用，所有 SQL 都是 `SELECT`；验收时读的是 clone 出来的副本。
2. 媒体侧：只读取 `msg/attach/<session md5>/<YYYY-MM>/Img|Thumb` 下的 `.dat` 文件，
   不写回、不删除、不改名。
3. 密钥：数据库密钥与图片 AES 密钥从本机已有的安全存储中取出后仅用于本次进程内解密，
   不落盘、不进入任何报告或提交。

## 六条链路的实测结果

### 1. 会话列表与群名（冷启动顺序无关）

`getSessions()` 是同步路径，会在异步 hydration 之前返回；旧实现只读 `displayNameCache`，
冷启动第一次取群名时缓存为空，就会把 `ww...@qy_g` 原样当群名显示。现在的
`resolveSessionNickname()` 统一走「企业群名 → 缓存 → 会话昵称 → username」，
并且 `getEnterpriseGroupName()` 在缓存未命中时同步查一次 `bizchat.chat_group.chat_name`。

| 检查 | 结果 |
| --- | --- |
| 冷启动同步列表里 5 个企业群是否用 raw id 当群名 | 0/5（全部已解析） |
| 2 个企业单聊 | 保持自身昵称（单聊本无群名，符合预期） |
| 异步 `getSessionsAsync({hydrateDisplayNames:true})` 之后 | 5 个群名与冷启动完全一致 |
| `getGroupNamesAsync()`（退群提示/自动化取群名） | 5/5 企业群在列，名字与会话列表一致 |

### 2. 联系人列表（群列表与群日报的群名来源）

群日报的 `groupName` 取 `contact.m_nsNickName`，并过滤内部标识符
（`src/renderer/src/utils/group-report-facts.ts:114`）。用真实的 `listContactsAsync()` 复核：

| 检查 | 结果 |
| --- | --- |
| 7 个企业会话是否都出现在联系人列表 | 7/7 |
| `type` 判定 | 5 个 `group`（`@qy_g`）、2 个 `user`（`@qy_u`） |
| 群名能否通过 `isInternalIdentifier` 过滤（即日报不显示「未命名会话」） | 7/7 |

### 3. 群成员（失败与空列表已区分）

`getEnterpriseGroupMembers(Async)` 现在返回 `Wcdb4GroupMember[] | null`：
读不到（缺 native 入口、非 `@qy_g`、查询抛错）返回 `null`，只有 `user_list` 真正为空才返回 `[]`。

| 检查 | 结果 |
| --- | --- |
| 5 个企业群的群快照 | 5/5 可解析 |
| 群名与同步通道一致 | 5/5 |
| 成员数 | 每群 2 人 |
| 成员显示名（`user_info.user_name`） | 2/2 每群都解析到非 id 名称 |

### 4. 消息数量与发送者

90 天窗口，每会话最多 500 条：

| 会话 | 消息数 | 发送者已解析 | 不同发送者 |
| --- | --- | --- | --- |
| 企业群 A | 350 | 350/350 | 2 |
| 企业群 B | 500 | 500/500 | 1 |
| 企业群 C | 379 | 379/379 | 1 |
| 企业群 D | 369 | 369/369 | 2 |
| 企业群 E | 61 | 61/61 | 1 |
| 企业单聊 1 | 10 | 10/10 | 2 |
| 企业单聊 2 | 3 | 3/3 | 1 |

所有会话的发送者解析率均为 100%：企业消息的 `source` 是 zstd 压缩的
`enterprise_info` XML，`parseEnterpriseSource()` 从中取 `sender` / `nickname` / `bizchat_id`。

### 5. 图片

企业图片的 `message_content` 里**没有 md5**（只有 `aeskey` / `encryver` / CDN 地址等属性），
所以不能用普通消息的 md5 路线定位文件。实际链路是：`packed_info_data` → `parseImageDatNameFromRow()`
解出 32 位 datName → 在 `msg/attach/<session md5>/<YYYY-MM>/Img` 命中 `.dat` → 用图片 AES 密钥解密。

| 会话 | 图片数 | 抽样 | 定位到文件 | 解密成功 | 格式 |
| --- | --- | --- | --- | --- | --- |
| 企业群 A | 188 | 5 | 5/5 | 5/5 | JPEG / PNG |
| 企业群 B | 316 | 5 | 5/5 | 5/5 | JPEG |
| 企业群 C | 184 | 5 | 5/5 | 5/5 | JPEG |
| 企业群 D | 184 | 5 | 5/5 | 5/5 | JPEG / PNG |
| 企业群 E | 0 | — | — | — | 该群 90 天内只有文字 |
| 企业单聊 1 | 1 | 1 | 1/1 | 1/1 | PNG |
| 企业单聊 2 | 0 | — | — | — | — |

解密结果按文件头判定（`FF D8 FF` / `89 50 4E 47`），不是「解出非空 buffer」就算通过。

### 6. 企业群的成员批量读取与退群监控

native 的 `wcdb_get_group_members_batch` **只认 `@chatroom`**。实测：

- 只请求 3 个普通群 → 正常返回，成员数 500 / 412 / 488；
- 只请求 5 个企业群 → 整批失败（nativeCode `-2001`）；
- 混合请求 3 个普通群 + 5 个企业群 → **整批失败**，普通群的结果也一起丢掉。

因此在 `chat-service.getGroupMemberIdsBatchAsync()` 里按通道分流：普通群仍走一次 native 批量，
企业群逐个走 bizchat 成员通道，最后按调用方请求顺序合并。修复后同一批 8 个会话返回 8 条结果
（普通群 500 / 412 / 488，企业群各 2），不再互相拖累。

退群监控侧（`src/main/services/group-exit-monitor-service.ts`）：

- `normalizeRoomIds()`（:914）与 `normalizeSnapshots()`（:951）都要求 `@chatroom`，
  所以 `@qy_g` 永远进不了 `monitoredRoomIds`，也不会被写进持久化快照；
- 只有「微信内退群提示」开着时，`@qy_g` 才会经 `getGroupNamesAsync()` 进入检测范围；
- 此时成员读取失败（`null`）会得到 `membersValid === false`，`applyCurrentMemberships()`
  直接 `continue`，不会把「读不到」当成「全员退群」。

## 复现方式（不含任何密钥）

1. 以只读模式启动主进程，指向 clone 出来的 `db_storage`；
2. 调 `getSessions()` 看冷启动群名，再调 `getSessionsAsync({hydrateDisplayNames:true})` 比对；
3. 调 `listContactsAsync()` / `getGroupNamesAsync()` / `getGroupSnapshotAsync()` 复核群名与成员；
4. 调 `getMessages()` 统计消息数、发送者解析率与图片数；
5. 对图片样本调 `parseImageDatNameFromRow()` + `ImageDecryptService.findImageFileAsync()` + `decryptImage()`；
6. 调 `getGroupMemberIdsBatchAsync()` 混合普通群与企业群，确认不再整批失败。

## 隐私说明

- 本文只出现 sha256 前缀、计数与布尔判定，不含 wxid、群名、成员名、消息正文、文件路径或密钥；
- 验收脚本与原始 JSON 均为本机临时产物，不在仓库内，也不会进入提交历史。
