import { createHash } from 'node:crypto'
import {
  normalizeScheduledReportConfig,
  type ScheduledReportAutomationConfig
} from '../../shared/automation'
import type {
  ScheduledReportMemberNameMode,
  ScheduledReportMessageType,
  ScheduledReportRange
} from '../../shared/scheduled-report'
import type { SelectableReportTemplateId } from '../../shared/report-templates'

/**
 * 旧「定时日报任务」→ 新「AutomationRule(ruleType='scheduled_report')」的**纯映射器**。
 *
 * 单独成文件是为了能直接单测：这是整轮迁移里**唯一会改变用户既有行为**的地方，
 * 不允许只靠"跑一遍看看"来验证。
 *
 * ## 旧 target 的真实语义（实测）
 *
 * `ScheduledReportService.resolveTarget()`：
 * - `target` 以 `@chatroom` 结尾 ⇒ **直接发到那个群**（可能是另一个群）；
 * - 否则 ⇒ **静默回落到来源群**。
 *
 * ⇒ 历史行为**事实上支持「生成 A 群日报 → 发 B 群」**，也存在一处静默 fallback。
 * 新产品明确不支持"指定另一个群聊"，所以：
 * **能证明同群 → 无损映射成 `source_chat`；不能证明 → 停用 + 要求用户重选**，
 * 绝不自动改写、绝不偷偷丢掉目标。
 */

/** 旧任务里迁移真正用得到的字段（其余字段不参与，也不需要读）。 */
export interface LegacyScheduledReportTask {
  id?: unknown
  name?: unknown
  group?: unknown
  scheduleTime?: unknown
  reportRange?: unknown
  messageTypes?: unknown
  templateId?: unknown
  memberNameMode?: unknown
  timeoutSeconds?: unknown
  target?: unknown
  enabled?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  lastRunAt?: unknown
  lastScheduledSlot?: unknown
}

export type ScheduledReportMigrationOutcome =
  /** 目标与来源群是同一群 ⇒ 等价于 `source_chat`，行为完全一致。 */
  | 'lossless_source_chat'
  /** 目标是另一个群 / 无法确认是否同群 ⇒ 单值四选一表达不了，需用户重选。 */
  | 'needs_review'

export interface ScheduledReportMigrationPlan {
  outcome: ScheduledReportMigrationOutcome
  /** 迁移后的规则 id（确定性，可重复执行且不产生新 id）。 */
  ruleId: string
  name: string
  enabled: boolean
  config: ScheduledReportAutomationConfig
  createdAt: number
  updatedAt: number
}

/** 把任意输入收敛成字符串。 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

/**
 * 确定性 ruleId。
 *
 * 优先**原样复用旧 taskId**（旧 id 形如 `scheduled_report_<uuid>`，与自动化现有
 * id 空间 —— `randomUUID()` / `builtin-*` —— 不可能冲突）。
 * 旧 id 缺失时（文件被手改坏），退化成一个**由稳定字段派生**的 id，
 * 保证"重复迁移不会生成新规则"。
 */
export function scheduledReportMigrationRuleId(task: LegacyScheduledReportTask): string {
  const id = asText(task.id)
  if (id) return id
  const digest = createHash('sha1')
    .update(
      [asText(task.name), asText(task.group), asText(task.scheduleTime), asText(task.target)].join(
        '\u0001'
      )
    )
    .digest('hex')
  return `scheduled-report:${digest.slice(0, 32)}`
}

/** 旧 `createdAt` / `updatedAt` 是 ISO 字符串；非法时回落到迁移时刻。 */
function parseIso(value: unknown, fallback: number): number {
  const text = asText(value)
  if (!text) return fallback
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * 单条旧任务 → 迁移计划。
 *
 * `resolveConversationId` 由调用方注入（main 侧是 `chat-service.resolveMd5`，
 * 单测里是假的联系人表）。**它拿不到就说明主进程还没准备好**，
 * 调用方必须**推迟整批迁移**，而不是用"解析不到"去误判成 needs_review。
 */
export function planScheduledReportMigration(
  task: LegacyScheduledReportTask,
  resolveConversationId: (raw: string) => string | undefined,
  now: number
): ScheduledReportMigrationPlan {
  const sourceRaw = asText(task.group)
  const targetRaw = asText(task.target)
  const sourceResolved = resolveConversationId(sourceRaw)
  const targetResolved = resolveConversationId(targetRaw)

  /*
   * 三种"能证明是同一个群"的情况：
   * 1. target 为空 —— 旧 `normalizeInput` 本就把空 target 填成 group；
   * 2. 两者文本完全相等 —— 无论能否解析，用户表达的就是同一个东西；
   * 3. 两者都能解析且解析结果相同 —— 旧 UI 的常态（group=会话 md5，target=roomId）。
   */
  const sameGroup =
    !targetRaw || targetRaw === sourceRaw || Boolean(sourceResolved && targetResolved && sourceResolved === targetResolved)

  const config = normalizeScheduledReportConfig({
    schedule: { time: asText(task.scheduleTime) },
    report: {
      // 解析得到就用稳定会话 id；解析不到**保留原值** —— 运行期会如实失败，
      // 绝不在这里"猜一个群"。
      sourceConversationId: sourceResolved ?? sourceRaw,
      range: asText(task.reportRange) as ScheduledReportRange,
      messageTypes: task.messageTypes as ScheduledReportMessageType[],
      templateId: asText(task.templateId) as SelectableReportTemplateId,
      memberNameMode: asText(task.memberNameMode) as ScheduledReportMemberNameMode,
      timeoutSeconds: Number(task.timeoutSeconds)
    },
    target: { type: 'source_chat' },
    ...(sameGroup ? {} : { targetNeedsReview: true }),
    // 旧目标原文只作展示；`sameGroup` 时不保留，避免留下看起来像"还生效"的残值。
    ...(sameGroup || !targetRaw ? {} : { legacyTarget: targetRaw }),
    // 来源群被改写过（md5/群名 → roomId）时留下原文，便于用户核对。
    ...(sourceRaw && sourceResolved && sourceRaw !== sourceResolved
      ? { legacySourceGroup: sourceRaw }
      : {}),
    ...(asText(task.lastRunAt) ? { lastRunAt: asText(task.lastRunAt) } : {}),
    ...(asText(task.lastScheduledSlot) ? { lastScheduledSlot: asText(task.lastScheduledSlot) } : {})
  })

  const name = asText(task.name) || '定时日报'
  return {
    outcome: sameGroup ? 'lossless_source_chat' : 'needs_review',
    ruleId: scheduledReportMigrationRuleId(task),
    name,
    // 不自动改写、也不自动启用：无法确认目标的规则一律停用。
    enabled: sameGroup ? task.enabled !== false : false,
    config,
    createdAt: parseIso(task.createdAt, now),
    updatedAt: parseIso(task.updatedAt, now)
  }
}

export interface ScheduledReportMigrationSummary {
  total: number
  migrated: number
  lossless: number
  needsReview: number
  duplicatesSkipped: number
}

/**
 * 整批任务的迁移结果：**按 id 去重**，保证幂等（同一份旧文件跑两次结果一致）。
 */
export function planScheduledReportMigrationBatch(
  tasks: LegacyScheduledReportTask[],
  resolveConversationId: (raw: string) => string | undefined,
  now: number
): { plans: ScheduledReportMigrationPlan[]; summary: ScheduledReportMigrationSummary } {
  const plans: ScheduledReportMigrationPlan[] = []
  const seen = new Set<string>()
  let duplicatesSkipped = 0
  let lossless = 0
  let needsReview = 0
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue
    const plan = planScheduledReportMigration(task, resolveConversationId, now)
    if (seen.has(plan.ruleId)) {
      duplicatesSkipped += 1
      continue
    }
    seen.add(plan.ruleId)
    plans.push(plan)
    if (plan.outcome === 'lossless_source_chat') lossless += 1
    else needsReview += 1
  }
  return {
    plans,
    summary: {
      total: plans.length + duplicatesSkipped,
      migrated: plans.length,
      lossless,
      needsReview,
      duplicatesSkipped
    }
  }
}
