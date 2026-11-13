# 关键词回复机器人

监听微信文本消息，按规则表匹配关键词，命中后经 TraceMemo Gateway 回复。

两条入口共用同一份配置与同一套判定（`lib/matcher.js`）：

- `message.received` 事件：扩展自己判断范围与冷却，再调用 `tm.wechat.send`；
- 自动化动作 `keyword.reply`：只返回回复文本，不发送，发送由宿主的自动化流程完成。

扩展本身不碰 socket、dylib 或 HTTP，所有发送都经过宿主 Gateway 的权限、授权校验、限流与审计。

## 目录

```text
keyword-bot/
  manifest.json        权限、订阅、页面与自动化动作声明
  background/index.js  事件编排、冷却表、命中统计
  lib/matcher.js       纯函数：规范化 / 匹配 / 范围 / 模板 / 决策
  ui/                 配置页（沙箱 iframe，只调用 storage.* / capabilities.get / extension.info）
  tests/matcher.test.mjs
```

## 功能

- 规则支持三种匹配方式：`contains`（包含）、`exact`（完全匹配）、`prefix`（以…开头），均不区分大小写；
- 每条规则可单独启用/停用，并设置优先级与冷却；
- 监听范围可按群限定，可开关私聊，可要求真正 @ 我；
- 回复内容支持模板变量；
- 配置页展示今日命中数与最近 5 条命中结果。

## 配置字段

顶层：

| 字段                     | 类型     | 默认    | 说明                                      |
| ------------------------ | -------- | ------- | ----------------------------------------- |
| `configVersion`          | number   | `2`     | 保存时写入；v1（无此字段）读取时自动迁移  |
| `enabled`                | boolean  | `false` | 总开关。缺省关闭，避免安装后立即对外发送  |
| `rules`                  | array    | `[]`    | 规则表，见下                              |
| `scope.groups`           | string[] | `[]`    | 群 id（`xxx@chatroom`）；空数组表示全部群 |
| `scope.includeDirect`    | boolean  | `true`  | 是否处理私聊                              |
| `scope.requireMentionMe` | boolean  | `false` | 是否只处理真正 @ 登录账号的消息           |

规则：

| 字段              | 类型    | 默认          | 约束                                        |
| ----------------- | ------- | ------------- | ------------------------------------------- |
| `id`              | string  | `rule-<序号>` | ≤ 64 字符；冷却键的一部分，尽量稳定         |
| `keyword`         | string  | `''`          | ≤ 120 字符；启用中为空的规则会被丢弃        |
| `mode`            | string  | `contains`    | `contains` / `exact` / `prefix`             |
| `reply`           | string  | `''`          | ≤ 2000 字符；启用中为空的规则会被丢弃       |
| `cooldownSeconds` | number  | `0`           | 0–3600，取整到秒                            |
| `enabled`         | boolean | `true`        | v1 规则迁移后为 `true`；显式 `false` 才停用 |
| `priority`        | number  | `0`           | 0–100 整数，越大越先匹配                    |

配置页保存时只校验**启用中**的规则必须有 `keyword` 与 `reply`；停用的规则允许留空，方便先存草稿。

## 模板变量

| 变量        | 含义                                                                       |
| ----------- | -------------------------------------------------------------------------- |
| `{sender}`  | 发送者昵称；为空时渲染为「你」。自动化动作路径没有发送者上下文，恒为「你」 |
| `{keyword}` | 命中的关键词（规则里的原文）                                               |
| `{time}`    | 当前本地时间 `HH:mm`                                                       |

未知变量（例如 `{group}`）原样保留，不会被静默删除。渲染结果 trim 后截断到 2000 字符。

## 优先级与冷却语义

- 只考虑 `enabled !== false` 的规则；按 `priority` 降序排列，同优先级保持规则在数组中的顺序；
- 取**第一个**命中的规则，一条消息最多回复一次（stopOnMatch），不会叠加多条回复；
- 冷却键是 `conversationId:ruleId`，即「同一会话 + 同一条规则」各自独立计时；
- 冷却只在**发送成功后**写入：发送失败不占用冷却，下一条命中会立刻重试；
- 冷却表只存在内存里，扩展进程重启后清空——宁可多回一条，也不跨重启误拦。

## 统计口径与隐私边界

存储键 `stats`，结构：

```json
{
  "dateKey": "2026-11-12",
  "todayCount": 3,
  "lastHits": [{ "at": 0, "ruleId": "rule-1", "ok": true }]
}
```

- 每条命中记一条，**成功和失败都记**；`todayCount` 统计的是命中的次数（含发送失败）；
- `lastHits` 最多保留 20 条，配置页只展示最近 5 条；`at` 是 epoch 毫秒；
- 跨日后读取会把 `todayCount` 归零，`lastHits` 作为滚动历史保留；
- 只记录规则 id、时间与发送结果，**不记录会话 id、消息正文、发送者昵称或群名**；
- 统计写入失败只打 warn 日志，不影响回复；
- 统计只覆盖事件自动回复，不包含自动化动作 `keyword.reply` 的调用。

## 测试

零依赖，Node 内置测试运行器，不安装任何包：

```bash
node --test examples/extensions/keyword-bot/tests/matcher.test.mjs
node --check examples/extensions/keyword-bot/lib/matcher.js
node --check examples/extensions/keyword-bot/background/index.js
node --check examples/extensions/keyword-bot/ui/app.js
```

用例覆盖：三种匹配方式、大小写、空关键词、禁用规则、优先级与稳定性、群范围与私聊开关、@ 要求、自己发的消息、冷却中/过期、模板替换与未知变量、超长截断、v1 迁移、非法规则丢弃、数值越界收敛、决策顺序。

`tests/matcher.test.mjs` 中的 fixture 全部为占位数据（`张三`、`李四`、`测试群`、`fixture-room@chatroom`、`wxid_fixture`）。

## 已知限制

- 不回复自己发送的消息（`isSelf` 直接跳过）；
- 消息事件是「至多一次」投递：扩展进程重启的瞬间可能丢事件，没有补投队列；
- 不读取群名，因此没有 `{group}` 变量；需要按群定制时请拆成多条规则并配合「监听范围」；
- 配置缓存窗口为 1 秒，保存后最多 1 秒生效；
- 冷却表与配置缓存都在扩展后台进程内存中，进程重启即丢失。
