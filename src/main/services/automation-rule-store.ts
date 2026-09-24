import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { app } from 'electron'
import fs from 'fs-extra'
import {
  BUILTIN_LEAVE_NOTIFICATION_RULE_ID,
  createDefaultDailyReportRule,
  createDefaultLeaveNotificationRule,
  normalizeRuleDraft,
  type AutomationRule,
  type AutomationRuleType
} from '../../shared/automation'
import {
  planLeaveNotificationMigration,
  type LeaveNotificationMigrationPlan,
  type LegacyLeaveNotificationState
} from './leave-notification-migration'
import {
  GROUP_EXIT_NOTIFICATION_TEMPLATE_MAX_LENGTH,
  insertGroupNamePlaceholder
} from '../../shared/group-exit-monitor'

/**
 * AutomationRuleStore —— 自动化规则的持久化与增删改查。
 *
 * 存储形态刻意做到最简：一个 JSON 文件（`{userData}/automation/rules.json`）。
 * 规则总量是个位数到几十条，引入数据库只会增加迁移负担。
 *
 * **内置规则的播种标记（`builtinSeeded`）单独存**：
 * 如果靠"文件里有没有那条内置规则"来判断是否播种，用户一旦删掉它，
 * 下次启动就会被重新塞回来 —— 用户会认为删除功能坏了。
 *
 * 退群通知的迁移标记（`leaveNotificationMigrated`）同理：迁移**只允许跑一次**，
 * 否则用户删掉退群通知规则后重启又被塞回来。
 */

const STORAGE_DIR = 'automation'
const RULES_FILE = 'rules.json'
const MIGRATION_BACKUP_FILE = 'leave-notification-migration-backup.json'
/** 旧退群监控的状态文件（迁移时读一次，之后运行期不再读）。 */
const LEGACY_MONITOR_FILE = 'group-exit-monitor.json'
const CURRENT_VERSION = 3

interface StoredRules {
  version: number
  /** 内置「@我生成日报」是否已经播种过。**即使随后被删除也保持 true**。 */
  builtinSeeded: boolean
  /** 旧退群通知配置是否已经迁移过。**即使随后被删除也保持 true**。 */
  leaveNotificationMigrated: boolean
  /**
   * 是否已经替用户往模板里补过 `{groupName}`。
   *
   * **必须有这个标记**：没有它就得靠"模板里有没有 `{groupName}`"来判断，
   * 于是用户主动删掉那一行后、下次启动又会被补回来 —— 删不掉的东西最烦人。
   */
  notificationTemplateUpgraded: boolean
  rules: AutomationRule[]
}

export interface AutomationRuleStoreDependencies {
  userDataPath?: () => string
  now?: () => number
}

function emptyState(): StoredRules {
  return {
    version: CURRENT_VERSION,
    builtinSeeded: false,
    leaveNotificationMigrated: false,
    notificationTemplateUpgraded: false,
    rules: []
  }
}

function normalizeRuleType(value: unknown): AutomationRuleType {
  return value === 'leave_notification' ? 'leave_notification' : 'daily_report'
}

/**
 * 单条规则的读盘归一化。
 *
 * 走 `normalizeRuleDraft` —— 它覆盖了 `AutomationRule` 除 id / 时间戳之外的**全部**字段，
 * 所以这是无损的，同时自动补上历史 rules.json 缺失的 `ruleType` / `leaveNotification`。
 */
function normalizeStoredRule(value: unknown): AutomationRule | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<AutomationRule>
  const id = String(raw.id || '').trim()
  if (!id) return null
  const ruleType = normalizeRuleType(raw.ruleType)
  const normalized = normalizeRuleDraft(
    {
      ...raw,
      ruleType,
      // 历史 daily_report 规则没有 leaveNotification；反过来也要避免脏字段落盘。
      ...(ruleType === 'leave_notification' ? { leaveNotification: raw.leaveNotification } : {})
    },
    String(raw.name || '').trim() || '未命名自动化'
  )
  const createdAt = Number(raw.createdAt) || 0
  const updatedAt = Number(raw.updatedAt) || createdAt
  return {
    ...normalized,
    id,
    createdAt,
    updatedAt,
    ...(normalized.ruleType === 'leave_notification' && normalized.leaveNotification
      ? { leaveNotification: normalized.leaveNotification }
      : {})
  }
}

/**
 * 一次性替用户把 `{groupName}` 补进退群通知模板。
 *
 * **为什么替他填**：模板里原先根本没有群名变量（`{groupRemark}` 是成员在本群的昵称）。
 * 目标一旦不是「当前群聊」，通知就等于「张三退群了」—— 收件人不知道是哪个群。
 * 模板是用户已保存的数据，让他自己去发现"少一个变量"是不合理的。
 *
 * **为什么只跑一次**：靠"模板里有没有 `{groupName}`"判断会导致用户删掉后被反复补回来。
 * 所以由 `notificationTemplateUpgraded` 标记保证一次性；用户之后删掉不会回来。
 */
function upgradeLeaveNotificationTemplate(rules: AutomationRule[]): {
  rules: AutomationRule[]
  count: number
} {
  let count = 0
  const next = rules.map((rule) => {
    if (rule.ruleType !== 'leave_notification' || !rule.leaveNotification) return rule
    const current = rule.leaveNotification.template
    const upgraded = insertGroupNamePlaceholder(current)
    // 补完不能超长：超了下次读盘会被校验拦下、整条模板被重置成默认，反而更糟。
    if (upgraded === current || upgraded.length > GROUP_EXIT_NOTIFICATION_TEMPLATE_MAX_LENGTH) {
      return rule
    }
    count += 1
    return { ...rule, leaveNotification: { ...rule.leaveNotification, template: upgraded } }
  })
  return { rules: next, count }
}

/** 读盘容错：任何字段可疑都降级成安全值，绝不因为一个坏文件让功能整体不可用。 */function normalizeStored(value: unknown): StoredRules {
  if (!value || typeof value !== 'object') return emptyState()
  const input = value as Partial<StoredRules>
  const rules = Array.isArray(input.rules)
    ? input.rules
        .map((rule) => normalizeStoredRule(rule))
        .filter((rule): rule is AutomationRule => rule !== null)
    : []
  return {
    version: Number(input.version) || 1,
    builtinSeeded: input.builtinSeeded === true,
    leaveNotificationMigrated: input.leaveNotificationMigrated === true,
    notificationTemplateUpgraded: input.notificationTemplateUpgraded === true,
    rules
  }
}

export class AutomationRuleStore {
  private readonly userDataPath: () => string
  private readonly now: () => number
  private state: StoredRules = emptyState()
  private loaded = false
  /** 迁移结果，供启动日志/报告读取（不含任何 id）。 */
  private lastMigrationPlan: LeaveNotificationMigrationPlan | null = null

  constructor(dependencies: AutomationRuleStoreDependencies = {}) {
    this.userDataPath = dependencies.userDataPath ?? (() => app.getPath('userData'))
    this.now = dependencies.now ?? (() => Date.now())
  }

  listRules(): AutomationRule[] {
    this.ensureLoaded()
    return this.state.rules.map((rule) => structuredClone(rule))
  }

  getRule(id: string): AutomationRule | undefined {
    const key = String(id || '').trim()
    if (!key) return undefined
    const found = this.listRules().find((rule) => rule.id === key)
    return found
  }

  /** 上一次迁移的判定结果（未迁移时为 null）。 */
  getLastLeaveNotificationMigration(): LeaveNotificationMigrationPlan | null {
    this.ensureLoaded()
    return this.lastMigrationPlan ? { ...this.lastMigrationPlan } : null
  }

  createRule(draft: unknown): AutomationRule {
    this.ensureLoaded()
    const timestamp = this.now()
    const normalized = normalizeRuleDraft(draft)
    const rule: AutomationRule = {
      ...normalized,
      id: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp
    }
    this.state.rules = [...this.state.rules, rule]
    this.persist()
    return structuredClone(rule)
  }

  updateRule(id: string, draft: unknown): AutomationRule | undefined {
    this.ensureLoaded()
    const key = String(id || '').trim()
    const index = this.state.rules.findIndex((rule) => rule.id === key)
    if (index < 0) return undefined
    const current = this.state.rules[index]
    // 名字留空时沿用原名，而不是变成「未命名自动化」—— 编辑页只改开关时不该改名。
    const normalized = normalizeRuleDraft(draft, current.name)
    const rule: AutomationRule = {
      ...current,
      ...normalized,
      id: current.id,
      // ruleType 不允许被草稿改掉：它是规则的**身份**，不是可编辑字段。
      ruleType: current.ruleType,
      ...(current.ruleType === 'leave_notification' && normalized.leaveNotification
        ? { leaveNotification: normalized.leaveNotification }
        : {}),
      createdAt: current.createdAt,
      updatedAt: this.now()
    }
    // 切类型时不能留下另一种类型才认识的字段。
    if (rule.ruleType === 'daily_report') delete rule.leaveNotification
    this.state.rules = this.state.rules.map((item, at) => (at === index ? rule : item))
    this.persist()
    return structuredClone(rule)
  }

  /**
   * 保存「退群通知」规则（**singleton upsert**）。
   *
   * 不存在则创建（固定 id），存在则更新 —— 所以点多少次保存都只有一条规则。
   */
  saveLeaveNotificationRule(draft: unknown): AutomationRule {
    this.ensureLoaded()
    const existing = this.state.rules.find(
      (rule) => rule.id === BUILTIN_LEAVE_NOTIFICATION_RULE_ID
    )
    if (existing) {
      const updated = this.updateRule(existing.id, { ...(draft as object), ruleType: 'leave_notification' })
      if (updated) return updated
    }
    const timestamp = this.now()
    const normalized = normalizeRuleDraft({ ...(draft as object), ruleType: 'leave_notification' })
    const rule: AutomationRule = {
      ...createDefaultLeaveNotificationRule(timestamp),
      ...normalized,
      id: BUILTIN_LEAVE_NOTIFICATION_RULE_ID,
      ruleType: 'leave_notification',
      name: normalized.name || '退群通知',
      createdAt: timestamp,
      updatedAt: timestamp
    }
    this.state.rules = [...this.state.rules, rule]
    this.persist()
    return structuredClone(rule)
  }

  deleteRule(id: string): boolean {
    this.ensureLoaded()
    const key = String(id || '').trim()
    const before = this.state.rules.length
    this.state.rules = this.state.rules.filter((rule) => rule.id !== key)
    if (this.state.rules.length === before) return false
    this.persist()
    return true
  }

  setRuleEnabled(id: string, enabled: boolean): AutomationRule | undefined {
    const rule = this.getRule(id)
    if (!rule) return undefined
    return this.updateRule(id, { ...rule, enabled: enabled === true })
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    let stored: StoredRules
    try {
      stored = normalizeStored(fs.readJsonSync(this.rulesFilePath()) as unknown)
    } catch {
      stored = emptyState()
    }
    if (!stored.builtinSeeded) {
      stored.builtinSeeded = true
      stored.rules = [...stored.rules, createDefaultDailyReportRule(this.now())]
    }
    if (!stored.leaveNotificationMigrated) {
      stored.leaveNotificationMigrated = true
      stored.rules = this.migrateLeaveNotification(stored.rules)
    }
    if (!stored.notificationTemplateUpgraded) {
      stored.notificationTemplateUpgraded = true
      const upgraded = upgradeLeaveNotificationTemplate(stored.rules)
      stored.rules = upgraded.rules
      // 只记条数，**不记模板正文**。
      if (upgraded.count > 0) {
        console.log(`[Automation] 退群通知模板已补上群名变量（${upgraded.count} 条）`)
      }
    }
    stored.version = CURRENT_VERSION
    this.state = stored
    this.persist()
  }

  /** 旧退群通知配置 → 内置退群通知规则。**只跑一次**，且先备份旧配置。 */
  private migrateLeaveNotification(rules: AutomationRule[]): AutomationRule[] {
    if (rules.some((rule) => rule.id === BUILTIN_LEAVE_NOTIFICATION_RULE_ID)) return rules
    const timestamp = this.now()
    const legacy = this.readLegacyLeaveNotificationState()
    if (!legacy) {
      // 全新安装：没有历史可迁，直接建默认规则（默认目标：文件传输助手）。
      this.logMigration('fresh_install', null)
      return [...rules, createDefaultLeaveNotificationRule(timestamp)]
    }
    const plan = planLeaveNotificationMigration(legacy)
    this.lastMigrationPlan = plan
    this.writeMigrationBackup(legacy, plan)
    this.logMigration(plan.outcome, plan)
    return [
      ...rules,
      createDefaultLeaveNotificationRule(timestamp, {
        template: plan.template,
        target: plan.target,
        enabled: plan.enabled,
        targetNeedsReview: plan.targetNeedsReview
      })
    ]
  }

  /**
   * 读旧退群监控状态文件里的通知相关字段。
   *
   * 只读、只在这里读一次；运行期其余代码**不再读** legacy（避免双读）。
   * 读失败视为"没有历史配置"，不抛。
   */
  private readLegacyLeaveNotificationState(): LegacyLeaveNotificationState | null {
    try {
      const raw = fs.readJsonSync(
        path.join(this.userDataPath(), LEGACY_MONITOR_FILE)
      ) as Partial<LegacyLeaveNotificationState>
      if (!raw || typeof raw !== 'object') return null
      return {
        monitoredRoomIds: Array.isArray(raw.monitoredRoomIds) ? raw.monitoredRoomIds : [],
        notificationRoomIds: Array.isArray(raw.notificationRoomIds) ? raw.notificationRoomIds : [],
        ...(raw.notificationTemplate !== undefined
          ? { notificationTemplate: raw.notificationTemplate }
          : {})
      }
    } catch {
      return null
    }
  }

  /**
   * 迁移前把旧配置原样落一份 backup。
   *
   * §「不要不可逆直接覆盖」：旧状态文件本身也**不删**，只是不再被运行时代码读取。
   */
  private writeMigrationBackup(
    legacy: LegacyLeaveNotificationState,
    plan: LeaveNotificationMigrationPlan
  ): void {
    try {
      const filePath = path.join(this.userDataPath(), STORAGE_DIR, MIGRATION_BACKUP_FILE)
      fs.ensureDirSync(path.dirname(filePath))
      fs.writeJsonSync(
        filePath,
        {
          migratedAt: this.now(),
          outcome: plan.outcome,
          // 备份里保留原始 roomId：这是**用户数据**，不是日志，不进任何用户可见界面。
          legacy: {
            monitoredRoomIds: legacy.monitoredRoomIds,
            notificationRoomIds: legacy.notificationRoomIds,
            notificationTemplate: legacy.notificationTemplate
          },
          applied: {
            enabled: plan.enabled,
            targetType: plan.target.type,
            targetNeedsReview: plan.targetNeedsReview
          }
        },
        { spaces: 2 }
      )
    } catch (error) {
      console.warn(
        `[Automation] 写入退群通知迁移备份失败: ${errorText(error)}`
      )
    }
  }

  /** 迁移日志：只允许出现判定结果与布尔量，**禁止** roomId / 模板正文。 */
  private logMigration(outcome: string, plan: LeaveNotificationMigrationPlan | null): void {
    if (!plan) {
      console.log(`[Automation] 退群通知迁移 outcome=${outcome}`)
      return
    }
    console.log(
      `[Automation] 退群通知迁移 outcome=${outcome} enabled=${plan.enabled}` +
        ` targetType=${plan.target.type} needsReview=${plan.targetNeedsReview}`
    )
  }

  private rulesFilePath(): string {
    return path.join(this.userDataPath(), STORAGE_DIR, RULES_FILE)
  }

  private persist(): void {
    try {
      const filePath = this.rulesFilePath()
      fs.ensureDirSync(path.dirname(filePath))
      fs.writeJsonSync(filePath, this.state, { spaces: 2 })
    } catch (error) {
      console.warn(
        `[Automation] 保存规则失败: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const automationRuleStore = new AutomationRuleStore()
