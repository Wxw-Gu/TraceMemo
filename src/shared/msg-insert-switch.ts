/**
 * 微信消息插入开关 —— 跨进程共享的类型与常量。
 *
 * 开关本体存在 native 侧（每个消息分片 `_tm_config` 表），但**开关值写成功不等于
 * 功能真的生效**：真正干活的是挂在 `Msg_<md5(roomId)>` 表上的规则，而某个分片
 * 完全可能「有 _tm_config 却没规则」。所以对外状态一律区分三件事：
 *
 *   desiredEnabled    用户意图（开关值有没有写下去）
 *   effectiveEnabled  是否真的生效（目标会话的规则全齐 + 开关值落到相关分片）
 *   operationOk       写入层面有没有失败
 *
 * 判断「生效」按**目标会话**算，不按分片算 —— 一个会话可能横跨 2~4 个分片，
 * 只有当它命中的**每一个**分片都 ready，这个会话才算 ready。
 */

/** native 侧白名单里的开关名 */
export const MSG_INSERT_SWITCHES = ['recall_notice', 'group_exit_notice'] as const

export type MsgInsertSwitchName = (typeof MSG_INSERT_SWITCHES)[number]

/** 目标会话的集合口径 */
export const MSG_INSERT_SCOPES = [
  /** 退群监控里勾选的群（只服务自动化通知） */
  'monitored_rooms',
  /** 全部可定位会话（群聊 + 私聊） */
  'all_sessions',
  /** 全部群聊（微信内退群提示的口径，与勾选无关） */
  'all_group_chats'
] as const
export type MsgInsertScope = (typeof MSG_INSERT_SCOPES)[number]

export interface MsgInsertRoomIssue {
  roomId: string
  reason: 'rules-missing' | 'table-not-found'
  matchedShards: string[]
  notReadyShards: string[]
}

export interface MsgInsertShardIssue {
  shard: string
  errorCode: number
  error: string
}

/** 开关的实现形态 */
export type MsgInsertSwitchMode =
  /** 靠微信库里的 persistent 规则实现：需要按会话装规则 → 有 room / shard 维度 */
  | 'rules'
  /** 靠事件驱动的一次性插入实现：没有 room / shard 维度 */
  | 'event'

/** 单个开关的完整状态 */
export interface MsgInsertSwitchStatus {
  switch: MsgInsertSwitchName
  scope: MsgInsertScope
  /** rules = 装规则（防撤回）；event = 事件驱动一次性插入（退群提示） */
  mode: MsgInsertSwitchMode

  /** 用户意图：开关值当前是否处于「开」 */
  desiredEnabled: boolean
  /** 是否真的生效 */
  effectiveEnabled: boolean
  /** 写入层面是否全部成功 */
  operationOk: boolean

  /**
   * 目标会话总数（**分母**）。
   *
   * ⚠️ 这是「**有消息表、可安装规则**的会话数」，不是全部会话数。
   * 公众号 / 服务号 / 系统会话根本没有 `Msg_` 表，装不了规则，它们是中性 pending，
   * 拿它们当分母只会让开关永远显示「部分成功」。
   */
  totalInstallableRooms: number
  /** 规则已就绪的可安装会话数（分子） */
  readyInstallableRooms: number
  /**
   * 微信库里找不到消息表的会话数。
   *
   * **中性 pending，不是失败**：这类会话通常还没收发过消息。它们不会进
   * notReadyRooms，也不会阻止 effectiveEnabled。UI 单独显示为「暂无消息表」。
   */
  roomsWithoutTable: number
  /** 事件驱动型开关用：该开关覆盖的群聊数（只是范围，不是覆盖率） */
  monitoredRoomCount?: number

  totalShards: number
  /** 目标会话实际落在的分片数 */
  targetShards: number
  /** 开关值已落到「开」的分片数 */
  configuredShards: number
  /** 开关值对且目标规则齐的分片数 */
  readyShards: number
  /** 值对了但目标规则不齐的分片数（不是失败） */
  notReadyShards: number
  /** 写不进去 / 读回校验不过的分片数（真失败） */
  failedShards: number

  notReadyRooms?: MsgInsertRoomIssue[]
  failures?: MsgInsertShardIssue[]

  /** 机器可读的错误分类，见 MsgInsertErrorCode */
  errorCode?: MsgInsertErrorCode
  /** 给人看的一句话；UI 直接展示这个 */
  message?: string
}

export interface MsgInsertSwitchesSnapshot {
  success: boolean
  switches: Record<MsgInsertSwitchName, MsgInsertSwitchStatus>
  /** helper 是否可用（不可用时只能读不能写） */
  /**
   * **能力标志**：本机是否存在「微信内消息写入组件」（那个一次性 helper）。
   *
   * 这是「微信内防撤回提示」和「微信内退群监控消息」的**唯一硬门槛**：
   * 主进程对微信库只持只读连接，任何写入都必须 spawn 那个组件，没有它两个功能都做不了。
   *
   * 语义上它是 **capability（能力）**，不是 error（错误）——
   * 缺失时 UI 显示「暂无法使用」，而不是「请重新安装」。
   *
   * ⚠️ 它是**唯一**的能力判据，不要再新增第二份（曾经因为 native 与 TS 各存一份判据
   * 而出现 946 里莫名少 323 的假象）。将来的授权/付费门禁应当**并列**加在它旁边
   * （capability && entitlement），而不是替换它。
   */
  helperAvailable: boolean
  /** native code 只放这里，不往 UI 上抛 */
  detail?: string
}

/** 打开/关闭一个开关的结果 */
export interface MsgInsertApplyResult {
  success: boolean
  status: MsgInsertSwitchStatus
  errorCode?: MsgInsertErrorCode
  message?: string
  detail?: string
}

/**
 * 错误分类。底层码（-2002 / -3004 / exit code）一律进 detail，
 * 不给普通用户看。
 */
export type MsgInsertErrorCode =
  | 'HELPER_NOT_FOUND'
  | 'HELPER_START_FAILED'
  | 'HELPER_TIMEOUT'
  | 'HELPER_BAD_OUTPUT'
  | 'HELPER_EXIT_NONZERO'
  | 'SHARD_WRITE_FAILED'
  | 'SHARD_VERIFY_FAILED'
  | 'RULE_MISSING'
  | 'PARTIAL_SUCCESS'
  | 'UNSUPPORTED_SWITCH'
  | 'NO_TARGET_ROOMS'
  | 'DATABASE_UNAVAILABLE'
  | 'UNKNOWN'

/** 界面上要展示的两个开关（顺序即展示顺序） */
export const MSG_INSERT_SWITCH_LABELS: Array<{
  name: MsgInsertSwitchName
  label: string
  hint: string
}> = [
  {
    name: 'recall_notice',
    label: '微信内防撤回提示',
    hint: '别人撤回消息时，在微信会话里保留原消息并提示你撤回了什么'
  },
  {
    name: 'group_exit_notice',
    label: '微信内退群监控消息',
    hint: '任意群有人退出时，在微信会话里插入一条退出提示（范围 = 全部群聊；自动化退群通知仍按退群监控勾选的群）'
  }
]
