import { createHash, randomUUID } from 'node:crypto'
import {
  matchAutomationRule,
  type AutomationMatchInput
} from '../../shared/automation-matcher'
import {
  AUTOMATION_SEND_PURPOSE,
  BUILTIN_LEAVE_NOTIFICATION_RULE_ID,
  type AutomationExecution,
  type AutomationRule,
  type AutomationStatusSummary
} from '../../shared/automation'
import type { GroupMemberExitedEvent } from '../../shared/group-exit-event'
import type { PersonalWechatSendCapability } from '../../shared/personal-wechat'
import type { Wcdb4Client } from '../wcdb4-client'
import type { NormalizedIncomingMessage } from './message-listener-service'
import { getSelfAccountInfo, listContacts } from './chat-service'
import { getPersonalWechatSendCapability } from './personal-wechat-capability-service'
import {
  resolveLeaveNotificationTarget,
  type LeaveNotificationTargetResolution
} from './leave-notification-target'
import {
  automationRuleStore,
  type AutomationRuleStore
} from './automation-rule-store'
import {
  automationExecutionLogService,
  type AutomationExecutionLogService
} from './automation-execution-log-service'
import {
  automationActionRunner,
  type AutomationActionRunner
} from './automation-action-runner'

/**
 * AutomationService —— Automation v1 的编排层。
 *
 * ```text
 * MessageListener
 *       ↓  NormalizedIncomingMessage
 * AutomationService.handleMessage
 *       ↓  TriggerMatcher（shared，纯函数；规则编辑页的预览共用同一份）
 *       ↓  cooldown → 同消息幂等 → 发送能力预检
 * AutomationActionRunner
 *       ↓
 * Execution Log
 * ```
 *
 * 刻意不引入 EventBus / RxJS / MQ / 工作流引擎 —— 这条链路的每一步都是同步可读的。
 *
 * **防循环 / 防刷屏四道闸**（缺一不可）：
 * 1. `isSelf` 防护：自己发的消息不触发（TriggerMatcher 内）；
 * 2. MessageListener dedup：同一条消息不会重复投递；
 * 3. cooldown：同一规则 + 同一会话的最小间隔；
 * 4. 同消息幂等：`ruleId:sessionId:localId` 只执行一次。
 *
 * 第 1 条是关键：TraceMemo 回复的那句「收到，正在生成今日日报」本身含关键词「日报」，
 * 少了它就会自己触发自己，形成死循环。
 */

/**
 * gate 表的容量上限。超了才清理「已解锁」的条目 —— 不是为了省内存，
 * 而是防止长期运行下 ruleId × conversationId 无界增长。
 */
const GATE_MAX_ENTRIES = 5_000

/**
 * 一条规则在一个会话里的 gate 状态。
 *
 * ```
 * blocked = inFlight || now < triggeredAt + cooldown
 * ```
 */
interface ConversationRuleGate {
  /** **第一次**触发的时间（cooldown 起点）。执行完成时**不重置**。 */
  triggeredAt: number
  /** 当前是否有这条规则在这个会话里的执行还在跑。 */
  inFlight: boolean
  /** 本次执行期间被 gate 挡下的消息数（仅诊断日志用）。 */
  blockedSinceTrigger: number
}

/** 幂等登记表的存活时间与容量上限（与 MessageListener 的 dedup 同思路）。 */
const CLAIM_TTL_MS = 10 * 60 * 1000
const CLAIM_MAX_ENTRIES = 5_000
/** 自己的 username 候选集缓存时长 —— 这个值几乎不变，没必要每条消息都查。 */
const SELF_USERNAME_TTL_MS = 30_000

/**
 * 退群事件幂等表的容量上限。
 *
 * 退群是低频事件，这里不需要 MessageListener 那种 5000 级容量；
 * 但同样要有界，避免长跑期间无界增长。
 */
const EXIT_CLAIM_MAX_ENTRIES = 1_000

/**
 * 由 `ruleId + eventId` 推出**确定性** executionId。
 *
 * 为什么要确定而不是 `randomUUID()`：幂等必须跨进程重启成立。
 * 同一 eventId 重新投递时算出同一个 executionId，`ExecutionLog.record()` 按 id 覆盖，
 * 于是"同一事件只产生一条 execution"在重启后依然成立。
 */
export function leaveNotificationExecutionId(ruleId: string, eventId: string): string {
  return createHash('sha1')
    .update(`leave_notification\u0001${ruleId}\u0001${eventId}`)
    .digest('hex')
}

/**
 * 退群通知的发送幂等键。
 *
 * **必须由 eventId 派生**（而不是 executionId 派生）：gateway 的审计是落盘的，
 * 用 eventId 才能让"重启后重复投递同一事件"被持久层直接短路掉。
 */
export function leaveNotificationIdempotencyKey(eventId: string): string {
  return `${AUTOMATION_SEND_PURPOSE.leaveNotification}:${eventId}`
}

export interface AutomationServiceDependencies {
  ruleStore?: AutomationRuleStore
  executionLog?: AutomationExecutionLogService
  runner?: AutomationActionRunner
  getCapability?: () => Promise<PersonalWechatSendCapability>
  /** 由主进程注入：MessageListener 是否在运行。 */
  isListening?: () => boolean
  now?: () => number
  /** gate 表容量上限。默认 `GATE_MAX_ENTRIES`；单测用小值来触发清理路径。 */
  gateMaxEntries?: number
}

interface ClaimEntry {
  at: number
}

export class AutomationService {
  private readonly ruleStore: AutomationRuleStore
  private readonly executionLog: AutomationExecutionLogService
  private readonly runner: AutomationActionRunner
  private readonly getCapability: () => Promise<PersonalWechatSendCapability>
  private readonly isListening: () => boolean
  private readonly now: () => number

  /** `ruleId:sessionId:localId` → 登记时间。 */
  private readonly claims = new Map<string, ClaimEntry>()
  /**
   * 退群事件幂等表：`ruleId:eventId` → 登记时间。
   *
   * 与消息型 `claims` 分开：退群事件没有 `localId` 这个概念，
   * 硬塞进同一张表会让两边的 key 语义混在一起。
   */
  private readonly exitClaims = new Map<string, ClaimEntry>()
  /**
   * Automation rule ↔ conversation gate。
   *
   * 粒度是 **`ruleId + conversationId`**（不是 sender，也不是整个会话）：
   * 群 A 的「@我生成日报」被触发后，群 B 的同一条规则、或同群里的**另一条规则**都不受影响。
   */
  private readonly gates = new Map<string, ConversationRuleGate>()

  /** 仅用于诊断统计（`[Automation] blockedMessages=N`），**不进用户执行日志**。 */
  private blockedMessageCount = 0

  private readonly gateMaxEntries: number

  private selfUsernames: string[] = []
  private selfUsernamesAt = 0

  constructor(
    private readonly client: Wcdb4Client,
    dependencies: AutomationServiceDependencies = {}
  ) {
    this.ruleStore = dependencies.ruleStore ?? automationRuleStore
    this.executionLog = dependencies.executionLog ?? automationExecutionLogService
    this.runner = dependencies.runner ?? automationActionRunner
    this.getCapability = dependencies.getCapability ?? getPersonalWechatSendCapability
    this.isListening = dependencies.isListening ?? (() => true)
    this.now = dependencies.now ?? (() => Date.now())
    this.gateMaxEntries = dependencies.gateMaxEntries ?? GATE_MAX_ENTRIES
  }

  /**
   * 消息入口。**绝不抛** —— 它挂在 MessageListener 的回调上，
   * 抛出去会影响后续监听者。
   */
  async handleMessage(message: NormalizedIncomingMessage): Promise<void> {
    let rules: AutomationRule[]
    try {
      rules = this.ruleStore.listRules()
    } catch (error) {
      this.warn(`读取规则失败: ${errorText(error)}`)
      return
    }
    if (!rules.length) return

    const selfUsernames = this.resolveSelfUsernames()
    const input: AutomationMatchInput = {
      ...(message.content !== undefined ? { content: message.content } : {}),
      mentionTargets: message.mentionTargets,
      isSelf: message.isSelf,
      isGroup: message.isGroup,
      // conversationId 与规则里的 conversationIds 同口径：群为 `xxx@chatroom`。
      conversationId: message.sessionId
    }

    for (const rule of rules) {
      // ① Gate 检查放在 TriggerMatcher **之前**（纯读，无副作用）。
      //
      // Automation rule conversation gate:
      // Once a rule is triggered for a conversation, ignore subsequent messages for
      // this rule while the current execution is still running OR until the configured
      // cooldown has elapsed from the original trigger time.
      //
      // Messages arriving during this blocked window must not be matched, replied to,
      // executed, or written to the user-facing execution log.
      //
      // The rule becomes eligible again only after BOTH:
      // 1. the previous execution has finished; and
      // 2. the cooldown since the original trigger has expired.
      //
      // Important: cooldown starts at the original trigger time, not when execution finishes.
      //
      // 也就是说：第一个任务执行期间，以及配置的触发间隔内，后续消息全部静默忽略。
      if (this.isGated(rule, message.sessionId)) {
        this.blockedMessageCount += 1
        this.noteBlocked(rule, message.sessionId)
        continue
      }

      // ② 匹配（同步）。放在 gate 之后 —— 阻塞窗口内的消息不该被匹配。
      let matched: boolean
      try {
        matched = matchAutomationRule(rule, input, selfUsernames).matched
      } catch (error) {
        this.warn(`规则匹配异常 ruleId=${rule.id}: ${errorText(error)}`)
        continue
      }
      if (!matched) continue

      // ③ Gate claim：check → 写入。**中间不能有 await**，否则两条几乎同时到达的消息
      //    会一起穿过检查。上面 ① 到这里的唯一代码是同步的 matcher，所以这里仍是原子的。
      if (!this.claimGate(rule, message.sessionId)) {
        this.blockedMessageCount += 1
        this.noteBlocked(rule, message.sessionId)
        continue
      }

      // ④ 同一条消息只处理一次（native 事件重复 / 多窗口回读都可能重复投递）。
      if (!this.claim(rule, message)) {
        this.leaveGate(rule, message.sessionId)
        continue
      }

      const sourceDisplayName = this.resolveDisplayName(message)
      try {
        await this.execute(rule, message, sourceDisplayName)
      } finally {
        // 无论 success / failed / 抛异常都要解除 in-flight。
        // 漏掉这一步会让这条规则在这个会话里**永久锁死**。
        this.leaveGate(rule, message.sessionId)
      }
    }
  }

  /** 顶部状态条数据。全部来自真实能力，不做渲染层平台猜测。 */
  async getStatus(): Promise<AutomationStatusSummary> {
    const now = this.now()
    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)
    const counts = this.executionLog.countSince(startOfToday.getTime())
    let capability: PersonalWechatSendCapability | null = null
    try {
      capability = await this.getCapability()
    } catch {
      capability = null
    }
    return {
      listening: this.isListening(),
      // 底层只能回读「最近活跃会话」（见 message-listener-service.ts 的 BLOCKER 注释），
      // UI 必须如实告知，不允许把它包装成「全局监听」。
      listeningDegraded: true,
      todayExecutions: counts.total,
      todaySuccesses: counts.success,
      sendCapability: {
        supported: Boolean(capability?.supported),
        ready: Boolean(capability?.ready),
        canSendText: Boolean(capability?.capabilities?.text),
        canSendImage: Boolean(capability?.capabilities?.image),
        message: capability?.message ?? '暂时无法获知微信发送能力'
      }
    }
  }

  /**
   * 退群事件入口。**绝不抛** —— 它挂在 `GroupExitMonitorService` 的回调上，
   * 抛出去会污染监控循环（退群事实已经记录成功，不能被通知失败连累）。
   *
   * 与 `handleMessage` 的分工：
   * - 消息型规则：MessageListener → handleMessage → 动作链；
   * - 退群通知：GroupExitMonitor → **本入口** → 单次文本发送。
   *
   * 三层闸门（缺一不可）：
   * 1. `enabled === false` → 不执行，**且不创建 execution**（§「没有执行：不创建」）；
   * 2. `targetNeedsReview` → 迁移过来但目标无法无损映射，同样不执行、不创建记录；
   * 3. `ruleId + eventId` 幂等 → 同一事件即使重复投递也只发送一次。
   */
  async handleGroupExit(event: GroupMemberExitedEvent): Promise<void> {
    const eventId = String(event?.eventId || '').trim()
    let rule: AutomationRule | undefined
    try {
      rule = this.ruleStore.getRule(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)
    } catch (error) {
      this.warn(`读取退群通知规则失败: ${errorText(error)}`)
      return
    }
    if (!rule || rule.ruleType !== 'leave_notification' || !rule.leaveNotification) return
    if (!eventId) {
      this.warn('退群事件缺少事件 id，已跳过本次通知')
      return
    }
    // ① 关闭：不执行、不创建失败记录。
    if (!rule.enabled) return
    // ② 迁移遗留的"目标待重选"：同样不算一次执行，由 UI 提示用户处理。
    if (rule.leaveNotification.targetNeedsReview) {
      this.warn(`退群通知目标待重新选择，已跳过本次通知 ruleId=${rule.id}`)
      return
    }
    // ③ 幂等（内存快路径）。跨重启那一层由确定性 executionId + gateway 审计兜住。
    if (!this.claimGroupExit(rule.id, eventId)) return

    const executionId = leaveNotificationExecutionId(rule.id, eventId)
    const startedAt = this.now()
    const sourceDisplayName = String(event.groupName || '').trim() || '群聊'

    // 目标解析与发送能力预检都放在 runner 之外，runner 只负责"跑成步骤"。
    const resolution = this.resolveLeaveTarget(rule, event)
    const sendBlockedReason = await this.leaveNotificationCapabilityError()

    let result: Awaited<ReturnType<AutomationActionRunner['runLeaveNotification']>>
    try {
      result = await this.runner.runLeaveNotification({
        executionId,
        event,
        config: rule.leaveNotification,
        resolution,
        sourceDisplayName,
        ...(sendBlockedReason ? { sendBlockedReason } : {})
      })
    } catch (error) {
      result = {
        steps: [],
        status: 'failed',
        errorSummary: `执行过程异常：${errorText(error)}`
      }
    }

    this.executionLog.record(
      this.buildExecution({
        executionId,
        rule,
        startedAt,
        sourceDisplayName,
        status: result.status,
        durationMs: this.now() - startedAt,
        steps: result.steps,
        ...(result.errorSummary ? { errorSummary: result.errorSummary } : {})
      })
    )

    // 隐私红线：日志只允许 ruleId / executionId / 状态 / 耗时 / 步骤状态与目标类型。
    // 群名、昵称、wxid、模板正文一律不进日志。
    const trail = result.steps.map((step) => `${step.key}=${step.status}`).join(' ')
    this.info(
      `executed ruleId=${rule.id} executionId=${executionId} status=${result.status}` +
        ` durationMs=${this.now() - startedAt}${trail ? ` ${trail}` : ''}`
    )
  }

  /** 解析退群通知目标（联系人清单 / 自身身份都取自既有能力，不另建一套）。 */
  private resolveLeaveTarget(
    rule: AutomationRule,
    event: GroupMemberExitedEvent
  ): LeaveNotificationTargetResolution {
    let contacts: ReturnType<typeof listContacts> = []
    try {
      contacts = listContacts()
    } catch (error) {
      this.warn(`读取联系人失败: ${errorText(error)}`)
    }
    let selfWxid = ''
    try {
      selfWxid = String(getSelfAccountInfo()?.wxid || '')
    } catch (error) {
      this.warn(`读取当前账号失败: ${errorText(error)}`)
    }
    return resolveLeaveNotificationTarget({
      config: rule.leaveNotification,
      event,
      contacts,
      selfWxid
    })
  }

  /** 退群通知只需要文字能力。缺失时给出用户能看懂的一句说明。 */
  private async leaveNotificationCapabilityError(): Promise<string | undefined> {
    let capability: PersonalWechatSendCapability | null = null
    try {
      capability = await this.getCapability()
    } catch {
      return '暂时无法获知微信发送能力，本次退群通知未发送。'
    }
    if (!capability?.supported) {
      return capability?.message || '当前系统不支持微信消息发送'
    }
    if (!capability.capabilities?.text) {
      return '当前环境无法发送文字，本次退群通知未发送。'
    }
    return undefined
  }

  /** 退群事件幂等登记（原子 check + 写入，中间无 await）。 */
  private claimGroupExit(ruleId: string, eventId: string): boolean {
    const key = `${ruleId}:${eventId}`
    const now = this.now()
    if (this.exitClaims.has(key)) return false
    this.exitClaims.set(key, { at: now })
    if (this.exitClaims.size > EXIT_CLAIM_MAX_ENTRIES) {
      for (const [entryKey, entry] of this.exitClaims) {
        if (this.exitClaims.size <= EXIT_CLAIM_MAX_ENTRIES) break
        if (now - entry.at > CLAIM_TTL_MS) this.exitClaims.delete(entryKey)
      }
    }
    return true
  }

  /** 「在哪些聊天生效」的可选项。`id` 必须是 `xxx@chatroom`，与 message.sessionId 对齐。 */  listGroups(): Array<{ id: string; name: string }> {
    try {
      return listContacts()
        .filter((contact) => contact.type === 'group' || contact.m_nsUsrName?.endsWith('@chatroom'))
        .map((contact) => ({
          id: String(contact.m_nsUsrName || ''),
          name: String(contact.m_nsNickName || contact.m_nsUsrName || '')
        }))
        .filter((group) => group.id)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    } catch (error) {
      this.warn(`读取群列表失败: ${errorText(error)}`)
      return []
    }
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  private async execute(
    rule: AutomationRule,
    message: NormalizedIncomingMessage,
    sourceDisplayName: string
  ): Promise<void> {
    const executionId = randomUUID()
    const startedAt = this.now()
    const isGroup = message.isGroup

    // 发送能力预检：环境发不出去时**不要执行**，直接留下一条说明清楚的失败记录。
    // 「假装规则正常运行」比直接报错更糟 —— 用户会以为发出去了。
    const missing = await this.checkSendCapability(rule, isGroup)
    if (missing) {
      this.executionLog.record(
        this.buildExecution({
          executionId,
          rule,
          startedAt,
          sourceDisplayName,
          status: 'failed',
          durationMs: this.now() - startedAt,
          steps: [],
          errorSummary: missing
        })
      )
      this.warn(`发送能力不足，跳过执行 ruleId=${rule.id} code=capability_missing`)
      return
    }

    // cooldown 起点已经在 `claimGate()` 记过了（= 第一次触发时间）。
    // 这里**不再**写任何时间戳 —— 否则「执行真正开始」的时间会把 cooldown 起点往后推。

    let result: Awaited<ReturnType<AutomationActionRunner['run']>>
    try {
      result = await this.runner.run({
        executionId,
        rule,
        conversationId: message.sessionId,
        isGroup,
        sourceDisplayName
      })
    } catch (error) {
      result = {
        steps: [],
        status: 'failed',
        errorSummary: `执行过程异常：${errorText(error)}`
      }
    }

    this.executionLog.record(
      this.buildExecution({
        executionId,
        rule,
        startedAt,
        sourceDisplayName,
        status: result.status,
        durationMs: this.now() - startedAt,
        steps: result.steps,
        ...(result.errorSummary ? { errorSummary: result.errorSummary } : {})
      })
    )

    // 隐私红线：日志里只允许出现 ruleId / executionId / 状态 / 耗时 / 步骤状态。
    // 群名、昵称、wxid、正文、source、文件路径一律不进日志。
    const trail = result.steps.map((step) => `${step.key}=${step.status}`).join(' ')
    this.info(
      `executed ruleId=${rule.id} executionId=${executionId} status=${result.status}` +
        ` durationMs=${this.now() - startedAt}${trail ? ` ${trail}` : ''}`
    )
  }

  /**
   * 检查当前环境是否具备规则所需的发送能力。
   *
   * 返回「缺失的能力」说明；返回 `undefined` 表示可以执行。
   * 私聊场景下 `sendReportImage` 同样受限，所以不做特殊豁免。
   */
  private async checkSendCapability(
    rule: AutomationRule,
    isGroup: boolean
  ): Promise<string | undefined> {
    const needsText = rule.actions.some((action) => action.type === 'replyText' && action.enabled)
    const needsImage = rule.actions.some(
      (action) => action.type === 'sendReportImage' && action.enabled
    )
    if (!needsText && !needsImage) return undefined

    let capability: PersonalWechatSendCapability | null = null
    try {
      capability = await this.getCapability()
    } catch {
      return '暂时无法获知微信发送能力，已跳过本次执行'
    }
    if (!capability?.supported) {
      return capability?.message || '当前系统不支持微信消息发送'
    }
    const target = isGroup ? '群聊' : '联系人'
    if (needsText && !capability.capabilities?.text) {
      return `当前环境无法发送文字，已跳过本次执行（无法回复${target}）`
    }
    if (needsImage && !capability.capabilities?.image) {
      return '当前环境无法发送图片，已跳过本次执行（无法发送日报）'
    }
    return undefined
  }

  private buildExecution(input: {
    executionId: string
    rule: AutomationRule
    startedAt: number
    sourceDisplayName: string
    status: AutomationExecution['status']
    durationMs: number
    steps: AutomationExecution['steps']
    errorSummary?: string
  }): AutomationExecution {
    return {
      executionId: input.executionId,
      ruleId: input.rule.id,
      ruleName: input.rule.name,
      triggerTime: input.startedAt,
      sourceDisplayName: input.sourceDisplayName,
      status: input.status,
      durationMs: input.durationMs,
      steps: input.steps,
      ...(input.errorSummary ? { errorSummary: input.errorSummary } : {})
    }
  }

  private gateKey(rule: AutomationRule, conversationId: string): string {
    // 粒度：规则 × 会话。**不含 senderId** —— 产品语义是「这个群里这条规则刚被触发过」，
    // 不是「张三 60 秒内不能再触发」。
    return `${rule.id}:${conversationId}`
  }

  private cooldownMs(rule: AutomationRule): number {
    const seconds = Number(rule.cooldownSeconds)
    if (!Number.isFinite(seconds) || seconds <= 0) return 0
    return seconds * 1000
  }

  /**
   * 是否处于阻塞窗口。**纯读**，所以可以放在 TriggerMatcher 之前。
   *
   * ```
   * blocked = inFlight || now < triggeredAt + cooldown
   * ```
   *
   * `triggeredAt` 是**第一次触发**的时间，不是执行完成时间：
   * 任务跑得比 cooldown 久时，真正的解锁时间是
   * `max(执行完成, triggeredAt + cooldown)`，而不是「完成之后再等一个 cooldown」。
   */
  private isGated(rule: AutomationRule, conversationId: string): boolean {
    const gate = this.gates.get(this.gateKey(rule, conversationId))
    if (!gate) return false
    if (gate.inFlight) return true
    const cooldownMs = this.cooldownMs(rule)
    if (cooldownMs <= 0) return false
    // 用「当前时间 vs triggeredAt」现算，**不依赖 setTimeout** ——
    // 事件循环卡顿 / app suspend / 定时器漂移都不会把冷却算错。
    return this.now() < gate.triggeredAt + cooldownMs
  }

  /**
   * 原子地占用 gate（check + 写入）。
   *
   * 返回 `false` 表示这一刻已经被阻塞（调用方按「忽略」处理，不匹配、不执行、不写日志）。
   * 调用方必须保证**从 `isGated()` 到这里之间没有 await**。
   */
  private claimGate(rule: AutomationRule, conversationId: string): boolean {
    if (this.isGated(rule, conversationId)) return false
    this.gates.set(this.gateKey(rule, conversationId), {
      triggeredAt: this.now(),
      inFlight: true,
      blockedSinceTrigger: 0
    })
    this.evictGatesIfNeeded()
    return true
  }

  /**
   * 解除 in-flight。**保留 `triggeredAt`** —— cooldown 仍以第一次触发时间为起点。
   *
   * 无论 success / failed / 抛异常都必须走这里，否则这条规则在这个会话里会永久锁死。
   */
  private leaveGate(rule: AutomationRule, conversationId: string): void {
    const gate = this.gates.get(this.gateKey(rule, conversationId))
    if (!gate) return
    gate.inFlight = false
    // 本次执行期间被挡下的消息数，汇总成**一行**诊断日志。
    // 只允许出现数量与 ruleId（不含群名 / wxid / 昵称 / 正文）。
    if (gate.blockedSinceTrigger > 0) {
      this.info(`blockedMessages=${gate.blockedSinceTrigger} ruleId=${rule.id}`)
      gate.blockedSinceTrigger = 0
    }
  }

  /** 记一次「被 gate 拦下的消息」。**只计数**，绝不写入用户执行日志。 */
  private noteBlocked(rule: AutomationRule, conversationId: string): void {
    const gate = this.gates.get(this.gateKey(rule, conversationId))
    if (gate) gate.blockedSinceTrigger += 1
  }

  /** 仅供诊断：累计被 gate 拦下的消息数。不接 IPC、不进 UI。 */
  getBlockedMessageCount(): number {
    return this.blockedMessageCount
  }

  /**
   * gate 表有界：**只清理已经解锁的条目**。
   *
   * 硬不变量：**正在执行（`inFlight === true`）的 gate 永不被淘汰** ——
   * 淘汰它就等于把一条正在跑的规则提前放开，会立刻产生第二次并发执行。
   * 所以这里的条件是 `!inFlight && 已过 cooldown`，两个都要满足；
   * 清理不掉就一直留着（宁可让表大一点，也不能让正在跑的规则失去保护）。
   */
  private evictGatesIfNeeded(): void {
    if (this.gates.size <= this.gateMaxEntries) return
    const now = this.now()
    const rules = this.ruleStore.listRules()
    for (const [key, gate] of this.gates) {
      if (this.gates.size <= this.gateMaxEntries) break
      if (gate.inFlight) continue
      const separator = key.lastIndexOf(':')
      const ruleId = separator < 0 ? key : key.slice(0, separator)
      const rule = rules.find((item) => item.id === ruleId)
      const cooldownMs = rule ? this.cooldownMs(rule) : 0
      if (now >= gate.triggeredAt + cooldownMs) this.gates.delete(key)
    }
  }

  private claim(rule: AutomationRule, message: NormalizedIncomingMessage): boolean {
    const key = `${rule.id}:${message.sessionId}:${message.localId}`
    const now = this.now()
    if (this.claims.has(key)) return false
    this.claims.set(key, { at: now })
    if (this.claims.size > CLAIM_MAX_ENTRIES) this.evictClaims(now)
    return true
  }

  /** 先按 TTL 清理；仍超限则按插入顺序丢最旧的一批。 */
  private evictClaims(now: number): void {
    for (const [key, entry] of this.claims) {
      if (now - entry.at > CLAIM_TTL_MS) this.claims.delete(key)
    }
    if (this.claims.size <= CLAIM_MAX_ENTRIES) return
    const overflow = this.claims.size - CLAIM_MAX_ENTRIES
    let removed = 0
    for (const key of this.claims.keys()) {
      this.claims.delete(key)
      removed += 1
      if (removed >= overflow) break
    }
  }

  private resolveSelfUsernames(): string[] {
    const now = this.now()
    if (this.selfUsernames.length && now - this.selfUsernamesAt < SELF_USERNAME_TTL_MS) {
      return this.selfUsernames
    }
    try {
      this.selfUsernames = (this.client.getMyUsernameCandidates?.() ?? []).filter(Boolean)
      this.selfUsernamesAt = now
    } catch (error) {
      this.warn(`读取自身 username 失败: ${errorText(error)}`)
    }
    return this.selfUsernames
  }

  /**
   * 会话显示名。
   *
   * 拿不到会话昵称时**降级成「群聊 / 联系人」**，绝不回落到 wxid ——
   * 那个值一旦漏进执行日志就等于把隐私写进了用户可见的界面。
   */
  private resolveDisplayName(message: NormalizedIncomingMessage): string {
    try {
      const session = this.client.getSessions().find((item) => item.username === message.sessionId)
      const nickname = String(session?.nickname || '').trim()
      if (nickname) return nickname
    } catch {
      // 忽略：走下面的通用降级名
    }
    return message.isGroup ? '群聊' : '联系人'
  }

  /** 日志统一出口：只允许不可逆的运维信息，禁止任何身份信息。 */
  private info(message: string): void {
    console.log(`[Automation] ${message}`)
  }

  private warn(message: string): void {
    console.warn(`[Automation] ${message}`)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let instance: AutomationService | null = null

/**
 * 主进程启动时调用一次。
 *
 * 用惰性初始化而不是模块级单例，是因为它需要 `Wcdb4Client`，
 * 而那个实例要等数据库解锁后才存在。
 */
export function initAutomationService(
  client: Wcdb4Client,
  dependencies: AutomationServiceDependencies = {}
): AutomationService {
  instance = new AutomationService(client, dependencies)
  return instance
}

export function getAutomationService(): AutomationService {
  if (!instance) throw new Error('AutomationService 尚未初始化')
  return instance
}
