import type { AutomationStep, AutomationStepStatus } from '../../../../../shared/automation'

/** 时间 / 耗时的展示格式化。全部是纯函数，便于单测。 */

const pad = (value: number): string => String(value).padStart(2, '0')

/** `2026-09-20 21:03` —— 执行日志列表用，够精确又不啰嗦。 */
export function formatTriggerTime(timestamp: number): string {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** `21:03:47` —— 详情抽屉用，需要到秒才能看清步骤先后。 */
export function formatClockTime(timestamp?: number): string {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 耗时：低于 1 秒显示毫秒，否则显示秒，避免「1200ms」这种要心算的写法。 */
export function formatDuration(durationMs?: number): string {
  if (!Number.isFinite(durationMs) || (durationMs ?? 0) < 0) return '—'
  const value = durationMs as number
  if (value < 1000) return `${Math.round(value)} ms`
  if (value < 60_000) return `${(value / 1000).toFixed(1)} 秒`
  return `${Math.floor(value / 60_000)} 分 ${Math.round((value % 60_000) / 1000)} 秒`
}

export const STEP_STATUS_LABELS: Record<AutomationStepStatus, string> = {
  pending: '等待中',
  running: '进行中',
  success: '已完成',
  failed: '失败',
  skipped: '已跳过'
}

/** 步骤圆点的语义色，供 SCSS 选择器使用。 */
export function stepStatusTone(status: AutomationStepStatus): string {
  if (status === 'success') return 'success'
  if (status === 'failed') return 'failed'
  if (status === 'skipped') return 'skipped'
  return 'pending'
}

/**
 * `skipped` 步骤的说明。
 *
 * 用户最容易困惑的就是「为什么这一步没跑」—— 必须区分
 * 「规则本来就没配这个动作」「上一步挂了所以跳过」「被规则自身的冷却/去重拦下」。
 *
 * **优先用服务端给的 `skipReason`**：它知道确切原因（例如「前置步骤失败（日报未生成）」），
 * 下面这套推断只是兜底，不许在这里重新发明原因。
 */
export function describeSkippedStep(step: AutomationStep, steps: AutomationStep[]): string {
  if (step.skipReason) return step.skipReason
  const index = steps.findIndex((item) => item.key === step.key)
  const blockedByFailure = steps
    .slice(0, index < 0 ? 0 : index)
    .some((item) => item.status === 'failed')
  if (blockedByFailure) return '上一步失败，已跳过'
  if (step.key === 'reply') return '规则未启用「回复确认」'
  if (step.key === 'report') return '规则未启用「生成日报」'
  if (step.key === 'send') return '规则未启用「发送日报图片」'
  return '未执行'
}
