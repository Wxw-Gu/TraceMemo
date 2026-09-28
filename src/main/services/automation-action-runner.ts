import {
  AUTOMATION_STEP_LABELS,
  AUTOMATION_SEND_ORIGIN,
  AUTOMATION_SEND_PURPOSE,
  DEFAULT_REPLY_TEXT,
  automationIdempotencyKey,
  normalizeReplyDelaySeconds,
  scheduledReportRangeLabel,
  type AutomationAction,
  type AutomationExecutionTrigger,
  type AutomationRule,
  type AutomationStep,
  type AutomationStepKey,
  type LeaveNotificationConfig,
  type ScheduledReportAutomationConfig
} from '../../shared/automation'
import {
  renderLeaveNotificationText,
  type GroupMemberExitedEvent
} from '../../shared/group-exit-event'
import type { WechatActionContent, WechatActionRequest, WechatActionResult } from '../../shared/wechat-action'
import type { SaveGeneratedReportRequest, SaveGeneratedReportResult } from '../../shared/report-history'
import {
  generateAgentGroupReport,
  type AgentGroupReportRequest,
  type AgentGroupReportResult
} from './agent-group-report-service'
import { wechatActionGateway } from './wechat-action-gateway'
import { saveGeneratedReport } from '../report-history-service'
import { getContactAvatars, resolveMd5 } from './chat-service'
import type { AutomationTargetResolution } from './automation-wechat-target'

/**
 * AutomationActionRunner —— 把一次命中跑成**步骤序列**。
 *
 * 两条硬要求：
 *
 * 1. **每一步都有独立的状态、起止时间与耗时。** 用户层日志的全部价值就在于此：
 *    只告诉用户「失败了」等于没说，得告诉他是「生成日报」那步坏了。
 * 2. **失败必须切断后续。** 日报没生成出来就绝不能继续发图 —— 那会发出一条
 *    空的 / 过期的 / 上一条的消息，比不发更糟。所以失败后剩下的步骤一律 `skipped`。
 */

/** 一步执行完毕后，后续步骤的处置方式。 */
const STEP_ORDER: AutomationStepKey[] = ['received', 'matched', 'reply', 'report', 'send']

/** 退群通知的步骤顺序（与消息型规则**不共用**）。 */
const LEAVE_NOTIFICATION_STEP_ORDER: AutomationStepKey[] = [
  'exit_received',
  'exit_matched',
  'exit_target',
  'exit_send'
]

/**
 * 定时日报的步骤顺序（与另外两族**不共用**）。
 *
 * 「生成中 / 已生成」与「确定目标 / 已发送」**刻意拆成四步**：
 * 用户必须能一眼看出"日报确实生成了，只是没发出去" —— 合成两步就表达不了。
 */
const SCHEDULED_REPORT_STEP_ORDER: AutomationStepKey[] = [
  'schedule_triggered',
  'report_generating',
  'report_generated',
  'send_resolved',
  'report_sent'
]

/**
 * 前置步骤失败时，后续步骤的 `skipReason`。
 *
 * 必须写清「是因为前面那步没成」，否则用户看到一连串「已跳过」会以为是规则没配好。
 */
const SKIPPED_AFTER_REPLY_FAILURE = '前置步骤失败（回复确认未成功），本次不再继续。'
const SKIPPED_AFTER_REPORT_FAILURE = '前置步骤失败（日报未生成），没有图片可发送。'

/**
 * 定时日报「生成 / 落库」失败时，后续步骤的 `skipReason`。
 *
 * 与 `SKIPPED_AFTER_REPORT_FAILURE` 的区别：那条说的是「@我日报没图可发」，
 * 这条说的是「定时日报这一步就没跑起来」—— 文案分开，避免用户混淆两条链路。
 */
const SKIPPED_AFTER_SCHEDULED_GENERATION_FAILURE =
  '前置步骤失败（定时日报未生成或未保存），本次未发送。'

/**
 * 规则启用了「发送日报图片」，但手上没有图片文件。
 *
 * 这不是「正常跳过」，也不允许退而求其次去发空路径 / 上一张旧图 / 不存在的文件 ——
 * 发错东西比不发更糟，所以直接判失败。
 */
const SEND_WITHOUT_IMAGE_ERROR = '日报图片未生成，无法发送。'

export interface AutomationRunInput {
  executionId: string
  rule: AutomationRule
  /** 会话标识：群为 `xxx@chatroom`，私聊为 wxid。同时也是发送对象。 */
  conversationId: string
  isGroup: boolean
  /** 用户可读的来源名（群名 / 昵称）。**不是** id。 */
  sourceDisplayName: string
}

export interface AutomationRunResult {
  steps: AutomationStep[]
  status: 'success' | 'failed'
  errorSummary?: string
  pngPath?: string
}

/**
 * 退群通知的执行输入。
 *
 * 目标解析与发送能力预检都由 `AutomationService` 在调用前完成，
 * 这里只负责"把它跑成步骤序列" —— 于是**所有步骤构造只在一处**，
 * 不会出现"服务拼一半、runner 拼一半"的裂口。
 */
export interface LeaveNotificationRunInput {
  executionId: string
  event: GroupMemberExitedEvent
  config: LeaveNotificationConfig
  resolution: AutomationTargetResolution
  /** 事件来源的显示名（群名 / 「群聊」）。**不含 wxid**。 */
  sourceDisplayName: string
  /** 发送能力缺失时的一句话说明；有值时 `exit_send` 直接判失败。 */
  sendBlockedReason?: string
}

export interface LeaveNotificationRunResult {
  steps: AutomationStep[]
  status: 'success' | 'failed'
  errorSummary?: string
}

/**
 * 定时日报的执行输入。
 *
 * 与退群通知同构：目标解析、来源显示名、发送能力预检都在 `AutomationService`
 * 调用前算好，runner 只负责"跑成步骤序列"。
 */
export interface ScheduledReportRunInput {
  executionId: string
  rule: AutomationRule
  config: ScheduledReportAutomationConfig
  resolution: AutomationTargetResolution
  /** 日报来源群的显示名（群名 / 「日报来源群」）。**不含 roomId**。 */
  sourceDisplayName: string
  /**
   * 本次触发方式。
   *
   * 只影响**发送节流口径**：定时触发算 `automation`（纳入发送节流），
   * 用户在页面上点「立即执行」算 `user`（与旧定时日报的手动执行一致）。
   * 执行日志里的 `trigger` 由 `AutomationService` 单独记录，不从这里读。
   */
  trigger: Extract<AutomationExecutionTrigger, 'schedule' | 'manual'>
  /** 发送能力缺失时的一句话说明；有值时 `report_sent` 直接判失败。 */
  sendBlockedReason?: string
}

export interface ScheduledReportRunResult {
  steps: AutomationStep[]
  status: 'success' | 'failed'
  errorSummary?: string
  /**
   * 日报是否**已经生成并落库**。
   *
   * 这是「生成成功但发送失败」的判据：`reportGenerated === true && status === 'failed'`
   * 就是"日报在，只是没发出去"。日报本身已进日报历史，不会被丢掉。
   */
  reportGenerated: boolean
  /** 生成出来的 PNG（仅在内存里传递，**不落执行日志**）。 */
  pngPath?: string
  /**
   * 底层生成错误的**机器可读码**（例如 `NO_MESSAGES`）。
   *
   * 用途只有一个：让上层区分「真的失败了」和「这一天没有消息可生成」——
   * 后者不该给用户推微信异常通知。
   */
  errorCode?: string
}

export interface AutomationActionRunnerDependencies {
  generateReport?: (request: AgentGroupReportRequest) => Promise<AgentGroupReportResult>
  executeAction?: (request: WechatActionRequest) => Promise<WechatActionResult>
  now?: () => number
  /** 延迟实现。默认真 sleep；单测注入即时 resolve 的假实现，避免真的等 2 秒。 */
  delay?: (ms: number) => Promise<void>
  /** 日报落库（日报历史）。与旧定时日报**复用同一个**实现，不复制。 */
  saveGeneratedReport?: (request: SaveGeneratedReportRequest) => Promise<SaveGeneratedReportResult>
  /** 把日报来源群标识解析成联系人（拿头像 / 显示名）。 */
  resolveReportContact?: (raw: string) => {
    md5?: string
    m_nsUsrName?: string
    m_nsNickName?: string
    avatar?: string
  } | null
  getContactAvatars?: (usernames: string[]) => Promise<Record<string, string>>
}

/** 策略层的错误码 → 用户可读短句。UI 直接展示这些文案，不做二次翻译。 */
const ACTION_ERROR_MESSAGES: Record<string, string> = {
  INVALID_REQUEST: '发送请求不合法',
  INVALID_RECIPIENT: '找不到有效的发送对象',
  ACTION_NOT_ALLOWED: '该自动化动作未被允许执行',
  RECIPIENT_SCOPE_VIOLATION: '发送对象与触发来源不一致',
  SEND_CAPABILITY_UNAVAILABLE: '当前环境没有可用的微信发送能力',
  SEND_NOT_READY: '微信发送能力尚未就绪，请先绑定个人微信',
  SEND_FAILED: '微信发送失败',
  POLICY_BLOCKED: '该发送动作未通过策略检查',
  UNKNOWN: '发送失败（未知原因）'
}

function createStep(key: AutomationStepKey): AutomationStep {
  return { key, label: AUTOMATION_STEP_LABELS[key], status: 'pending' }
}

function markSuccess(step: AutomationStep, at: number): void {
  step.status = 'success'
  step.startedAt = step.startedAt ?? at
  step.finishedAt = at
  step.durationMs = Math.max(0, at - step.startedAt)
}

function markFailed(step: AutomationStep, at: number, error: string): void {
  step.status = 'failed'
  step.startedAt = step.startedAt ?? at
  step.finishedAt = at
  step.durationMs = Math.max(0, at - step.startedAt)
  step.error = error
}

function markSkipped(step: AutomationStep, skipReason?: string): void {
  step.status = 'skipped'
  if (skipReason) step.skipReason = skipReason
}

function actionErrorMessage(code: string | undefined, fallback: string | undefined): string {
  if (fallback && fallback.trim()) {
    // 策略层给的 reason 已是中文短句；直接用，避免二次包装丢信息。
    return fallback.trim()
  }
  return (code && ACTION_ERROR_MESSAGES[code]) || ACTION_ERROR_MESSAGES.UNKNOWN
}

export class AutomationActionRunner {
  private readonly generateReport: (request: AgentGroupReportRequest) => Promise<AgentGroupReportResult>
  private readonly executeAction: (request: WechatActionRequest) => Promise<WechatActionResult>
  private readonly now: () => number
  private readonly delay: (ms: number) => Promise<void>
  private readonly saveGeneratedReport: (
    request: SaveGeneratedReportRequest
  ) => Promise<SaveGeneratedReportResult>
  private readonly resolveReportContact: NonNullable<
    AutomationActionRunnerDependencies['resolveReportContact']
  >
  private readonly getContactAvatars: (usernames: string[]) => Promise<Record<string, string>>

  constructor(dependencies: AutomationActionRunnerDependencies = {}) {
    this.generateReport = dependencies.generateReport ?? generateAgentGroupReport
    this.executeAction = dependencies.executeAction ?? ((request) => wechatActionGateway.execute(request))
    this.now = dependencies.now ?? (() => Date.now())
    this.delay =
      dependencies.delay ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    this.saveGeneratedReport = dependencies.saveGeneratedReport ?? saveGeneratedReport
    this.resolveReportContact = dependencies.resolveReportContact ?? ((raw) => resolveMd5(raw))
    this.getContactAvatars = dependencies.getContactAvatars ?? ((ids) => getContactAvatars(ids))
  }

  async run(input: AutomationRunInput): Promise<AutomationRunResult> {
    const steps = STEP_ORDER.map((key) => createStep(key))
    const stepAt = (key: AutomationStepKey): AutomationStep =>
      steps.find((step) => step.key === key) as AutomationStep

    markSuccess(stepAt('received'), this.now())
    markSuccess(stepAt('matched'), this.now())

    const replyAction = findAction(input.rule, 'replyText')
    const reportAction = findAction(input.rule, 'generateReport')
    const sendAction = findAction(input.rule, 'sendReportImage')

    // ---- 步骤 3：回复确认 ----
    //
    // 回复等待：规则一命中就秒回，看起来就是个机器人（消息刚到、回复就到）。
    // 等待时长是**规则自己的一项执行参数**（`rule.replyDelaySeconds`，在
    // 「编辑自动化 → 3 · 触发后执行」里配），所以不同规则可以不一样。
    //
    // 等待刻意放在 `reply` 步骤计时**之外** —— `reply.durationMs` 只应该反映发送本身，
    // 否则用户看到「回复确认 2000ms」会误以为是发送慢。
    // 已经命中就不再回头重判规则：等待窗口里规则被停用/删掉也不中断本次执行，
    // 与 cooldown、同消息幂等的口径一致（都是「命中那一刻」的快照）。
    if (replyAction) {
      // 用共享的归一化函数，而不是 `Number(...) || 0`：旧版 rules.json 里没有这个字段，
      // 那应该按**默认 2 秒**处理（否则「默认 2 秒」要等用户手动进编辑页才会生效）。
      const replyDelayMs = normalizeReplyDelaySeconds(input.rule.replyDelaySeconds) * 1_000
      if (replyDelayMs > 0) await this.delay(replyDelayMs)
    }

    if (!replyAction) {
      markSkipped(stepAt('reply'))
    } else {
      const replyStep = stepAt('reply')
      replyStep.status = 'running'
      replyStep.startedAt = this.now()
      const sent = await this.sendThroughGateway(input, 'reply', {
        type: 'text',
        text: replyAction.text?.trim() || DEFAULT_REPLY_TEXT
      })
      if (!sent.ok) {
        markFailed(replyStep, this.now(), sent.error || '回复确认失败')
        markRemainingSkipped(steps, 'reply', SKIPPED_AFTER_REPLY_FAILURE)
        return { steps, status: 'failed', errorSummary: replyStep.error }
      }
      markSuccess(replyStep, this.now())
    }

    // ---- 步骤 4：生成日报 ----
    let pngPath: string | undefined
    if (!reportAction) {
      markSkipped(stepAt('report'))
    } else {
      const reportStep = stepAt('report')
      reportStep.status = 'running'
      reportStep.startedAt = this.now()
      let result: AgentGroupReportResult
      try {
        result = await this.generateReport({ group: input.conversationId, range: 'today' })
      } catch (error) {
        result = {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
      if (!result.success || !result.pngPath) {
        markFailed(reportStep, this.now(), result.error || '日报生成失败')
        markRemainingSkipped(steps, 'report', SKIPPED_AFTER_REPORT_FAILURE)
        return { steps, status: 'failed', errorSummary: reportStep.error }
      }
      pngPath = result.pngPath
      markSuccess(reportStep, this.now())
    }

    // ---- 步骤 5：发送日报图片 ----
    //
    // 三种情况必须分开判断 —— 合并成 `!sendAction || !pngPath` 会把
    // 「规则要求发图、但图根本没生成」当成正常跳过，execution 还记成 success：
    //
    // A. 规则**本来就没有启用**这个动作 → skipped，这是正常的，不影响整体结果；
    // B. 启用了，但要发的东西不存在 → **failed**，不能假装成功，
    //    更不能退而求其次去发空路径 / 上一次的旧图 / 不存在的文件；
    // C. 前置（生成日报）已经失败 → 上面就 return 了，走不到这里。
    if (!sendAction) {
      markSkipped(stepAt('send'))
      return { steps, status: 'success', ...(pngPath ? { pngPath } : {}) }
    }
    const sendStep = stepAt('send')
    if (!pngPath) {
      markFailed(sendStep, this.now(), SEND_WITHOUT_IMAGE_ERROR)
      return { steps, status: 'failed', errorSummary: sendStep.error }
    }
    sendStep.status = 'running'
    sendStep.startedAt = this.now()
    const sent = await this.sendThroughGateway(input, 'report', { type: 'image', path: pngPath })
    if (!sent.ok) {
      markFailed(sendStep, this.now(), sent.error || '发送日报图片失败')
      return { steps, status: 'failed', errorSummary: sendStep.error, pngPath }
    }
    markSuccess(sendStep, this.now())
    return { steps, status: 'success', pngPath }
  }

  /**
   * 定时日报：把一次「到点触发 / 手动立即执行」跑成一次生成 + 一次发送。
   *
   * 与旧 `ScheduledReportService.executeTask` 的行为对齐（**不重写日报能力**）：
   * 1. 先生成（含落库进日报历史）—— 发送能力不足**也照常生成**（旧语义如此）；
   * 2. 再解析目标 —— 解析失败**不 fallback**，直接判失败；
   * 3. 最后经 `WechatActionGateway` 发图片 —— 仍然是**发图片**，不退化成纯文本。
   *
   * 「生成成功但发送失败」是可表达的：`report_generated` 为 success、
   * `report_sent` 为 failed，整体 `failed`，且 `reportGenerated === true`。
   */
  async runScheduledReport(input: ScheduledReportRunInput): Promise<ScheduledReportRunResult> {
    const steps = SCHEDULED_REPORT_STEP_ORDER.map((key) => createStep(key))
    const stepAt = (key: AutomationStepKey): AutomationStep =>
      steps.find((step) => step.key === key) as AutomationStep

    markSuccess(stepAt('schedule_triggered'), this.now())

    // ---- 生成日报（含落进日报历史）----
    const generatingStep = stepAt('report_generating')
    generatingStep.status = 'running'
    generatingStep.startedAt = this.now()
    let generated: AgentGroupReportResult
    try {
      generated = await this.generateReport({
        group: input.config.report.sourceConversationId,
        range: input.config.report.range,
        messageTypes: input.config.report.messageTypes,
        templateId: input.config.report.templateId,
        memberNameMode: input.config.report.memberNameMode,
        timeoutSeconds: input.config.report.timeoutSeconds
      })
    } catch (error) {
      generated = {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
    if (!generated.success || !generated.pngPath) {
      // 生成失败就**不发**：绝不生成空图片、也绝不退而求其次发上一张旧图。
      const reason = generated.error || '日报生成失败'
      markFailed(generatingStep, this.now(), reason)
      markSkipped(stepAt('report_generated'), SKIPPED_AFTER_SCHEDULED_GENERATION_FAILURE)
      markSkipped(stepAt('send_resolved'), SKIPPED_AFTER_SCHEDULED_GENERATION_FAILURE)
      markSkipped(stepAt('report_sent'), SKIPPED_AFTER_SCHEDULED_GENERATION_FAILURE)
      return {
        steps,
        status: 'failed',
        errorSummary: reason,
        reportGenerated: false,
        ...(generated.errorCode ? { errorCode: generated.errorCode } : {})
      }
    }

    let pngPath = generated.pngPath
    try {
      const reportContact = this.resolveReportContact(input.config.report.sourceConversationId)
      let contactAvatar = reportContact?.avatar
      if (!contactAvatar && reportContact?.m_nsUsrName) {
        try {
          const avatars = await this.getContactAvatars([reportContact.m_nsUsrName])
          contactAvatar = avatars[reportContact.m_nsUsrName]
        } catch (error) {
          console.warn('[Automation] 日报群头像补全失败:', error)
        }
      }
      const savedHistory = await this.saveGeneratedReport({
        contactId: reportContact?.md5 || input.config.report.sourceConversationId,
        contactName:
          generated.groupName || reportContact?.m_nsNickName || input.sourceDisplayName || '群聊',
        contactAvatar,
        source: 'scheduled',
        dateRange: generated.reportMetadata?.dateRange || scheduledReportRangeLabel(input.config.report.range),
        reportDate: generated.reportMetadata?.reportDate,
        messageCount: generated.messageCount ?? generated.reportMetadata?.messageCount ?? 0,
        generatedAt: new Date(this.now()).toISOString(),
        htmlPath: generated.htmlPath,
        pngPath: generated.pngPath,
        duration: generated.duration,
        modelName: generated.modelName,
        tokenUsage: generated.tokenUsage,
        reportSnapshot: generated.reportSnapshot,
        reportMetadata: generated.reportMetadata,
        templateId: input.config.report.templateId
      })
      if (!savedHistory.success) {
        throw new Error(savedHistory.error || '日报历史保存失败')
      }
      const recordPath = savedHistory.record?.pngPath || generated.pngPath
      if (!recordPath) throw new Error('日报历史未返回可发送的 PNG 文件')
      pngPath = recordPath
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      markFailed(generatingStep, this.now(), reason)
      markSkipped(stepAt('report_generated'), SKIPPED_AFTER_SCHEDULED_GENERATION_FAILURE)
      markSkipped(stepAt('send_resolved'), SKIPPED_AFTER_SCHEDULED_GENERATION_FAILURE)
      markSkipped(stepAt('report_sent'), SKIPPED_AFTER_SCHEDULED_GENERATION_FAILURE)
      return { steps, status: 'failed', errorSummary: reason, reportGenerated: false }
    }
    markSuccess(generatingStep, this.now())

    const generatedStep = stepAt('report_generated')
    markSuccess(generatedStep, this.now())
    const messageCount = generated.messageCount ?? 0
    if (messageCount > 0) generatedStep.detail = `共 ${messageCount} 条消息`

    // ---- 目标解析失败：不许 fallback 到任何地方，直接判失败 ----
    const targetStep = stepAt('send_resolved')
    if (!input.resolution.ok) {
      markFailed(targetStep, this.now(), input.resolution.error)
      markSkipped(stepAt('report_sent'), '没有可用的发送目标，本次未发送。')
      return {
        steps,
        status: 'failed',
        errorSummary: input.resolution.error,
        reportGenerated: true,
        pngPath
      }
    }
    targetStep.status = 'success'
    targetStep.startedAt = this.now()
    targetStep.finishedAt = targetStep.startedAt
    targetStep.durationMs = 0
    // 用户可读的目标名（例如「文件传输助手」「张三」「我」）—— 不带任何 id。
    targetStep.detail = input.resolution.target.displayName

    const sendStep = stepAt('report_sent')

    // ---- 发送能力缺失：日报已生成，如实判失败（不回滚、不隐藏）----
    if (input.sendBlockedReason) {
      markFailed(sendStep, this.now(), input.sendBlockedReason)
      return {
        steps,
        status: 'failed',
        errorSummary: input.sendBlockedReason,
        reportGenerated: true,
        pngPath
      }
    }

    sendStep.status = 'running'
    sendStep.startedAt = this.now()
    const sent = await this.sendScheduledReportImage(input, pngPath)
    if (!sent.ok) {
      markFailed(sendStep, this.now(), sent.error || '发送日报失败')
      return {
        steps,
        status: 'failed',
        errorSummary: sendStep.error,
        reportGenerated: true,
        pngPath
      }
    }
    markSuccess(sendStep, this.now())
    return { steps, status: 'success', reportGenerated: true, pngPath }
  }

  /**
   * 定时日报的统一发送出口。
   *
   * **必须走 `WechatActionGateway`**：幂等 + 3 秒发送间隔 + 审计落盘都在那里。
   * Automation 层不允许知道 OneBot / WCHook / native host / Windows hook 的存在。
   */
  private async sendScheduledReportImage(
    input: ScheduledReportRunInput,
    pngPath: string
  ): Promise<{ ok: boolean; error?: string }> {
    if (!input.resolution.ok) return { ok: false, error: input.resolution.error }
    // 定时触发走 automation（纳入发送节流）；用户手动执行走 user（不纳入节流）。
    const triggerType = input.trigger === 'manual' ? 'user' : 'automation'
    try {
      const result = await this.executeAction({
        idempotencyKey: `${AUTOMATION_SEND_PURPOSE.scheduledReport}:${input.executionId}`,
        origin: AUTOMATION_SEND_ORIGIN,
        purpose: AUTOMATION_SEND_PURPOSE.scheduledReport,
        triggerType,
        executionId: input.executionId,
        recipient: input.resolution.target.recipient,
        content: { type: 'image', path: pngPath }
      })
      if (result.status !== 'sent') {
        return { ok: false, error: actionErrorMessage(result.errorCode, result.reason) }
      }

      /*
       * 后置词：**只在图片明确 sent 之后**才发，图片失败时严格短路 ——
       * 与 `WechatActionGateway.executeReportImageSequence`（手动发送）同一口径。
       * 空字符串 = 用户只要图片，什么都不补发。
       *
       * 独立 purpose + 独立幂等位：共用一个 key 会让「图片发成功、后置词被
       * 幂等短路」变成常态。
       */
      const postfixText = String(input.config.postfixText || '').trim()
      if (!postfixText) return { ok: true }

      const postfix = await this.executeAction({
        idempotencyKey: `${AUTOMATION_SEND_PURPOSE.scheduledReportPostfix}:${input.executionId}`,
        origin: AUTOMATION_SEND_ORIGIN,
        purpose: AUTOMATION_SEND_PURPOSE.scheduledReportPostfix,
        triggerType,
        executionId: input.executionId,
        recipient: input.resolution.target.recipient,
        content: { type: 'text', text: postfixText }
      })
      if (postfix.status === 'sent') return { ok: true }
      // 绝不吞掉：图片确实发出去了，但这一次执行**没有完成**，必须如实报出来。
      return {
        ok: false,
        error: `日报图片已发送，但后置词发送失败：${actionErrorMessage(
          postfix.errorCode,
          postfix.reason
        )}`
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 退群通知：把「检测到成员退出」这件事跑成一次发送。
   *
   * 与 `run()` 的差别：没有动作链、没有回复等待、没有 cooldown
   * （退群是低频事件，且**不能被时间窗合并** —— 两个成员先后退出就是两条通知）。
   */
  async runLeaveNotification(input: LeaveNotificationRunInput): Promise<LeaveNotificationRunResult> {
    const steps = LEAVE_NOTIFICATION_STEP_ORDER.map((key) => createStep(key))
    const stepAt = (key: AutomationStepKey): AutomationStep =>
      steps.find((step) => step.key === key) as AutomationStep

    markSuccess(stepAt('exit_received'), this.now())
    markSuccess(stepAt('exit_matched'), this.now())

    // ---- 目标解析失败：不许 fallback 到任何地方，直接判失败 ----
    if (!input.resolution.ok) {
      markFailed(stepAt('exit_target'), this.now(), input.resolution.error)
      markSkipped(stepAt('exit_send'), '没有可用的通知目标，未发送。')
      return { steps, status: 'failed', errorSummary: input.resolution.error }
    }
    const targetStep = stepAt('exit_target')
    targetStep.status = 'success'
    targetStep.startedAt = this.now()
    targetStep.finishedAt = targetStep.startedAt
    targetStep.durationMs = 0
    // 用户可读的目标名（例如「文件传输助手」「张三」「我」）—— 不带任何 id。
    targetStep.detail = input.resolution.target.displayName

    const sendStep = stepAt('exit_send')

    // ---- 发送能力缺失：如实判失败（退群事实本身仍然是成功的） ----
    if (input.sendBlockedReason) {
      markFailed(sendStep, this.now(), input.sendBlockedReason)
      return { steps, status: 'failed', errorSummary: input.sendBlockedReason }
    }

    const text = renderLeaveNotificationText(input.event, input.config.template).trim()
    if (!text) {
      const error = '通知内容为空，未发送。'
      markFailed(sendStep, this.now(), error)
      return { steps, status: 'failed', errorSummary: error }
    }

    sendStep.status = 'running'
    sendStep.startedAt = this.now()
    const sent = await this.sendLeaveNotification(input, text)
    if (!sent.ok) {
      markFailed(sendStep, this.now(), sent.error || '发送退群通知失败')
      return { steps, status: 'failed', errorSummary: sendStep.error }
    }
    markSuccess(sendStep, this.now())
    return { steps, status: 'success' }
  }

  /**
   * 退群通知的统一发送出口。
   *
   * **必须走 `WechatActionGateway`**：幂等 + 3 秒发送间隔 + 审计落盘都在那里，
   * 直接调个人微信发送会绕过全部三样。Automation 层也不允许知道
   * OneBot / WCHook / native host / Windows hook 的存在。
   *
   * 幂等键由 **eventId** 派生（不是 executionId）：审计是落盘的，
   * 于是"重启后重复投递同一退群事件"会被持久层直接短路。
   */
  private async sendLeaveNotification(
    input: LeaveNotificationRunInput,
    text: string
  ): Promise<{ ok: boolean; error?: string }> {
    if (!input.resolution.ok) return { ok: false, error: input.resolution.error }
    try {
      const result = await this.executeAction({
        idempotencyKey: `${AUTOMATION_SEND_PURPOSE.leaveNotification}:${input.event.eventId}`,
        origin: AUTOMATION_SEND_ORIGIN,
        purpose: AUTOMATION_SEND_PURPOSE.leaveNotification,
        triggerType: 'automation',
        executionId: input.executionId,
        sourceId: input.event.eventId,
        recipient: input.resolution.target.recipient,
        content: { type: 'text', text }
      })
      if (result.status === 'sent') return { ok: true }
      return { ok: false, error: actionErrorMessage(result.errorCode, result.reason) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 统一发送出口。
   *
   * **刻意不直接调 `WechatSendGateway`，而是走 `WechatActionGateway`**：后者在
   * `WechatSendGateway` 之上多给了三样本功能必须的东西 ——
   * 幂等（同一 executionId 不会重复发）、自动化发送节流（3s 间隔，防刷屏）、
   * 审计落盘。底层实际发送仍然经由 `WechatSendGateway.sendPersonal`，
   * 所以「所有发送统一走 WechatSendGateway」这条约束依然成立。
   */
  private async sendThroughGateway(
    input: AutomationRunInput,
    kind: 'reply' | 'report',
    content: WechatActionContent
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const result = await this.executeAction({
        idempotencyKey: automationIdempotencyKey(kind, input.executionId),
        origin: AUTOMATION_SEND_ORIGIN,
        purpose: AUTOMATION_SEND_PURPOSE[kind],
        triggerType: 'automation',
        executionId: input.executionId,
        recipient: {
          type: input.isGroup ? 'group' : 'contact',
          id: input.conversationId,
          name: input.sourceDisplayName
        },
        content
      })
      if (result.status === 'sent') return { ok: true }
      return { ok: false, error: actionErrorMessage(result.errorCode, result.reason) }
    } catch (error) {
      // execute() 本身刻意不抛，这里兜的是注入实现或意外异常。
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

function findAction(rule: AutomationRule, type: AutomationAction['type']): AutomationAction | undefined {
  return rule.actions.find((action) => action.type === type && action.enabled)
}

/** 把 `after` 之后的步骤全部标成 `skipped`（前一步挂了，后面的不许再动）。 */
function markRemainingSkipped(
  steps: AutomationStep[],
  after: AutomationStepKey,
  skipReason?: string
): void {
  const from = STEP_ORDER.indexOf(after) + 1
  for (const key of STEP_ORDER.slice(from)) {
    const step = steps.find((item) => item.key === key)
    if (step) markSkipped(step, skipReason)
  }
}

export const automationActionRunner = new AutomationActionRunner()
