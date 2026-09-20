import {
  AUTOMATION_STEP_LABELS,
  AUTOMATION_SEND_ORIGIN,
  AUTOMATION_SEND_PURPOSE,
  DEFAULT_REPLY_TEXT,
  automationIdempotencyKey,
  type AutomationAction,
  type AutomationRule,
  type AutomationStep,
  type AutomationStepKey
} from '../../shared/automation'
import type { WechatActionContent, WechatActionRequest, WechatActionResult } from '../../shared/wechat-action'
import {
  generateAgentGroupReport,
  type AgentGroupReportRequest,
  type AgentGroupReportResult
} from './agent-group-report-service'
import { wechatActionGateway } from './wechat-action-gateway'

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

export interface AutomationActionRunnerDependencies {
  generateReport?: (request: AgentGroupReportRequest) => Promise<AgentGroupReportResult>
  executeAction?: (request: WechatActionRequest) => Promise<WechatActionResult>
  now?: () => number
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

function markSkipped(step: AutomationStep): void {
  step.status = 'skipped'
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

  constructor(dependencies: AutomationActionRunnerDependencies = {}) {
    this.generateReport = dependencies.generateReport ?? generateAgentGroupReport
    this.executeAction = dependencies.executeAction ?? ((request) => wechatActionGateway.execute(request))
    this.now = dependencies.now ?? (() => Date.now())
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
        markRemainingSkipped(steps, 'reply')
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
        markRemainingSkipped(steps, 'report')
        return { steps, status: 'failed', errorSummary: reportStep.error }
      }
      pngPath = result.pngPath
      markSuccess(reportStep, this.now())
    }

    // ---- 步骤 5：发送日报图片 ----
    // 日报被跳过（或没产出图片）时，这一条也必须 skipped —— 不能凭空发图。
    if (!sendAction || !pngPath) {
      markSkipped(stepAt('send'))
      return { steps, status: 'success', ...(pngPath ? { pngPath } : {}) }
    }
    const sendStep = stepAt('send')
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
function markRemainingSkipped(steps: AutomationStep[], after: AutomationStepKey): void {
  const from = STEP_ORDER.indexOf(after) + 1
  for (const key of STEP_ORDER.slice(from)) {
    const step = steps.find((item) => item.key === key)
    if (step) markSkipped(step)
  }
}

export const automationActionRunner = new AutomationActionRunner()
