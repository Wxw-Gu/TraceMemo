import {
  BUILTIN_DAILY_REPORT_RULE_ID,
  BUILTIN_LEAVE_NOTIFICATION_RULE_ID,
  calculateNextRunAt,
  type AutomationExecution,
  type AutomationRule,
  type AutomationRuleDraft,
  type AutomationRuleType
} from '../../shared/automation'
import { resolveContact } from './contact-resolution-service'
import { validateAutomationDraftShape } from '../../shared/agent-api/automation-validation'
import type {
  AgentAutomationExecution,
  AgentAutomationValidationIssue,
  AgentAutomationValidationResult,
  ApplicationCapabilities
} from '../../shared/agent-api/contracts'
import type {
  AgentGroupExitMonitorEvent,
  AgentGroupExitMonitorState
} from '../../shared/agent-api/group-exit-monitor'
import type { AgentGroupMemberStats } from '../../shared/agent-api/group-stats'
import type { GroupExitMonitorEvent } from '../../shared/group-exit-monitor'
import type { GroupMemberStatsQuery, GroupMemberStatsResult } from '../../shared/group-stats'
import type { Contact } from '../../shared/types'
import type { PersonalWechatSendCapability } from '../../shared/personal-wechat'
import type { AutomationExecutionLogService } from './automation-execution-log-service'
import type { AutomationRuleStore } from './automation-rule-store'

type AutomationRuleStoreApi = Pick<
  AutomationRuleStore,
  'listRules' | 'getRule' | 'createRule' | 'updateRule' | 'deleteRule' | 'setRuleEnabled'
>
type AutomationExecutionLogApi = Pick<AutomationExecutionLogService, 'list'>
type RuleScope = 'any' | 'person' | 'group'

type GroupExitMonitorStateSource = {
  enabled: boolean
  running: boolean
  monitoredRoomIds?: string[]
  nativeMonitorActive?: boolean
  monitoredGroupCount?: number
  monitorSelectionConfigured?: boolean
  lastCheckedAt?: number
  lastReadAt?: number
  unreadCount?: number
  totalEventCount?: number
  events?: GroupExitMonitorEvent[]
}

type GroupExitMonitorConfiguration = {
  enabled?: boolean
  monitoredRoomIds?: string[]
}

type GroupExitMonitorEventQuery = {
  roomId?: string
  sinceMs?: number
  untilMs?: number
  limit?: number
}

export class LocalAgentApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'LocalAgentApiError'
  }
}

export interface LocalAgentApiDependencies {
  automationRuleStore: AutomationRuleStoreApi
  automationExecutionLogService: AutomationExecutionLogApi
  listContacts: () => Promise<Contact[]>
  isDatabaseReady: () => boolean
  getVersion: () => string
  getPersonalWechatCapability: () => Promise<PersonalWechatSendCapability>
  getAgentHubStatus: () => { connector: string }
  getGroupExitMonitorState: () => GroupExitMonitorStateSource
  /** Preferred atomic monitor configuration operation. */
  configureGroupExitMonitor?: (
    configuration: GroupExitMonitorConfiguration
  ) => Promise<GroupExitMonitorStateSource> | GroupExitMonitorStateSource
  setGroupExitMonitorRoomIds?: (roomIds: string[]) => Promise<GroupExitMonitorStateSource>
  setGroupExitMonitorEnabled?: (enabled: boolean) => Promise<GroupExitMonitorStateSource>
  listGroupExitMonitorEvents?: (query: GroupExitMonitorEventQuery) => GroupExitMonitorEvent[]
  getGroupMemberStats?: (query: GroupMemberStatsQuery) => Promise<GroupMemberStatsResult>
}

const RULE_TYPES: AutomationRuleType[] = ['daily_report', 'scheduled_report', 'leave_notification']
const EXECUTION_STATUSES: AutomationExecution['status'][] = ['running', 'success', 'failed']
const UPDATE_FIELDS = new Set([
  'name',
  'trigger',
  'scope',
  'conditions',
  'actions',
  'cooldownSeconds',
  'replyDelaySeconds',
  'leaveNotification',
  'scheduledReport'
])

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function toDraft(rule: AutomationRule): AutomationRuleDraft {
  return {
    name: rule.name,
    enabled: false,
    ruleType: rule.ruleType,
    trigger: rule.trigger,
    scope: rule.scope,
    conditions: structuredClone(rule.conditions),
    actions: structuredClone(rule.actions),
    cooldownSeconds: rule.cooldownSeconds,
    replyDelaySeconds: rule.replyDelaySeconds,
    ...(rule.leaveNotification
      ? { leaveNotification: structuredClone(rule.leaveNotification) }
      : {}),
    ...(rule.scheduledReport ? { scheduledReport: structuredClone(rule.scheduledReport) } : {})
  }
}

function deepMergeDraft(
  current: AutomationRuleDraft,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current, ...patch, enabled: false }
  if (patch.conditions !== undefined) {
    next.conditions = { ...current.conditions, ...record(patch.conditions) }
  }
  if (patch.leaveNotification !== undefined && current.leaveNotification) {
    const leavePatch = record(patch.leaveNotification) || {}
    next.leaveNotification = {
      ...current.leaveNotification,
      ...leavePatch,
      ...(leavePatch.target !== undefined ? { target: leavePatch.target } : {})
    }
    if (record(leavePatch.target)?.type !== undefined) {
      delete (next.leaveNotification as Record<string, unknown>).targetNeedsReview
    }
  }
  if (patch.scheduledReport !== undefined && current.scheduledReport) {
    const schedulePatch = record(patch.scheduledReport) || {}
    const currentConfig = current.scheduledReport
    next.scheduledReport = {
      ...currentConfig,
      ...schedulePatch,
      schedule: { ...currentConfig.schedule, ...record(schedulePatch.schedule) },
      report: { ...currentConfig.report, ...record(schedulePatch.report) },
      ...(schedulePatch.target !== undefined ? { target: schedulePatch.target } : {})
    }
    if (record(schedulePatch.target)?.type !== undefined) {
      delete (next.scheduledReport as Record<string, unknown>).targetNeedsReview
    }
  }
  return next
}

function stableId(contact: Contact): string {
  return contact.type === 'user' ? contact.wxid || contact.m_nsUsrName : contact.m_nsUsrName
}

function toIsoTimestamp(value: number | undefined): string | null {
  if (!Number.isFinite(value) || Number(value) <= 0) return null
  const date = new Date(Number(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export class LocalAgentApiService {
  private readonly deps: LocalAgentApiDependencies

  constructor(dependencies: LocalAgentApiDependencies) {
    this.deps = dependencies
  }

  async getCapabilities(): Promise<ApplicationCapabilities> {
    const databaseReady = this.deps.isDatabaseReady()
    const hub = this.deps.getAgentHubStatus()
    const monitor = this.deps.getGroupExitMonitorState()
    let personal: Pick<
      PersonalWechatSendCapability,
      'supported' | 'ready' | 'status' | 'capabilities'
    >
    try {
      personal = await this.deps.getPersonalWechatCapability()
    } catch {
      personal = {
        supported: true,
        ready: false,
        status: 'error',
        capabilities: { text: false, image: false, voice: false }
      }
    }

    return {
      version: this.deps.getVersion(),
      apiVersion: 'v1',
      database: { ready: databaseReady },
      query: {
        supported: true,
        available: databaseReady,
        ...(!databaseReady ? { reason: 'database_not_ready' } : {})
      },
      automations: {
        supported: true,
        available: true,
        ruleTypes: [...RULE_TYPES],
        operations: [
          'list',
          'get',
          'create',
          'update',
          'validate',
          'enable',
          'disable',
          'delete',
          'executions'
        ]
      },
      groupExitMonitor: {
        supported: true,
        available: databaseReady && monitor.running,
        operations: [
          'read_state',
          'configure_scope',
          'enable',
          'disable',
          'list_events'
        ],
        ...(!databaseReady
          ? { reason: 'database_not_ready' }
          : !monitor.enabled
            ? { reason: 'disabled' }
            : !monitor.running
              ? { reason: 'not_running' }
              : {})
      },
      groupStats: {
        supported: true,
        available: databaseReady,
        operations: ['member_stats'],
        ...(!databaseReady ? { reason: 'database_not_ready' } : {})
      },
      wechat: {
        personal: {
          supported: personal.supported,
          available: personal.ready,
          status: personal.status,
          content: { ...personal.capabilities },
          ...(!personal.ready ? { reason: personal.status } : {})
        },
        ilink: {
          supported: true,
          available: hub.connector === 'online',
          status: hub.connector,
          ...(hub.connector !== 'online' ? { reason: 'connector_not_online' } : {})
        }
      }
    }
  }

  getGroupExitMonitorState(): AgentGroupExitMonitorState {
    const state = this.deps.getGroupExitMonitorState()
    return {
      enabled: state.enabled === true,
      running: state.running === true,
      nativeMonitorActive: state.nativeMonitorActive === true,
      monitoredConversationIds: [...(state.monitoredRoomIds || [])],
      monitoredGroupCount: Number.isFinite(state.monitoredGroupCount)
        ? Number(state.monitoredGroupCount)
        : state.monitoredRoomIds?.length || 0,
      monitorSelectionConfigured: state.monitorSelectionConfigured !== false,
      lastCheckedAt: toIsoTimestamp(state.lastCheckedAt),
      lastReadAt: toIsoTimestamp(state.lastReadAt),
      eventCount: Number.isFinite(state.totalEventCount)
        ? Number(state.totalEventCount)
        : state.events?.length || 0,
      unreadCount: Number.isFinite(state.unreadCount) ? Number(state.unreadCount) : 0
    }
  }

  async updateGroupExitMonitor(input: unknown): Promise<AgentGroupExitMonitorState> {
    const patch = record(input)
    if (!patch) {
      throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', '请求体必须是 JSON 对象')
    }
    const keys = Object.keys(patch)
    const allowed = new Set(['enabled', 'monitoredConversationIds'])
    const unknown = keys.find((key) => !allowed.has(key))
    if (unknown) {
      throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', `不支持字段：${unknown}`)
    }
    if (keys.length === 0) {
      throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', '至少提供 enabled 或 monitoredConversationIds')
    }

    const enabled = patch.enabled
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', 'enabled 必须是布尔值')
    }

    let monitoredRoomIds: string[] | undefined
    if (patch.monitoredConversationIds !== undefined) {
      if (!Array.isArray(patch.monitoredConversationIds)) {
        throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', 'monitoredConversationIds 必须是数组')
      }
      monitoredRoomIds = []
      const seen = new Set<string>()
      for (const value of patch.monitoredConversationIds) {
        if (typeof value !== 'string' || !value.trim()) {
          throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', '监控群 ID 不能为空')
        }
        const roomId = value.trim()
        if (seen.has(roomId)) {
          throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', `监控群 ID 重复：${roomId}`)
        }
        if (!roomId.endsWith('@chatroom') || roomId.includes('/') || roomId.includes('\\')) {
          throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', `无效的群会话 ID：${roomId}`)
        }
        seen.add(roomId)
        monitoredRoomIds.push(roomId)
      }
    }

    if (!this.deps.isDatabaseReady()) {
      throw new LocalAgentApiError(409, 'DATABASE_NOT_READY', '数据库未就绪，无法修改退群监控配置')
    }
    if (monitoredRoomIds !== undefined) {
      const contacts = await this.deps.listContacts()
      const groups = new Set(
        contacts
          .filter((contact) => contact.type === 'group')
          .map((contact) => contact.m_nsUsrName)
      )
      const missing = monitoredRoomIds.find((roomId) => !groups.has(roomId))
      if (missing) {
        throw new LocalAgentApiError(
          422,
          'VALIDATION_FAILED',
          `监控群不存在或不是群联系人：${missing}`,
          [{ path: 'monitoredConversationIds', code: 'group_not_found', message: missing }]
        )
      }
    }

    const configuration: GroupExitMonitorConfiguration = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(monitoredRoomIds !== undefined ? { monitoredRoomIds } : {})
    }
    let nextState: GroupExitMonitorStateSource | undefined
    if (this.deps.configureGroupExitMonitor) {
      nextState = await this.deps.configureGroupExitMonitor(configuration)
    } else {
      // Test adapters and older embedders may only expose the two primitive operations.
      // All validation is complete before this fallback starts mutating state.
      const previous = this.deps.getGroupExitMonitorState()
      try {
        if (monitoredRoomIds !== undefined) {
          if (!this.deps.setGroupExitMonitorRoomIds) {
            throw new LocalAgentApiError(503, 'CAPABILITY_UNAVAILABLE', '退群监控配置能力尚未就绪')
          }
          nextState = await this.deps.setGroupExitMonitorRoomIds(monitoredRoomIds)
        }
        if (enabled !== undefined) {
          if (!this.deps.setGroupExitMonitorEnabled) {
            throw new LocalAgentApiError(503, 'CAPABILITY_UNAVAILABLE', '退群监控配置能力尚未就绪')
          }
          nextState = await this.deps.setGroupExitMonitorEnabled(enabled)
        }
      } catch (error) {
        // Best-effort rollback for legacy adapters. Production uses the atomic operation above.
        try {
          if (monitoredRoomIds !== undefined && this.deps.setGroupExitMonitorRoomIds) {
            await this.deps.setGroupExitMonitorRoomIds(previous.monitoredRoomIds || [])
          }
          if (enabled !== undefined && this.deps.setGroupExitMonitorEnabled) {
            await this.deps.setGroupExitMonitorEnabled(previous.enabled)
          }
        } catch {
          // Preserve the original error; an adapter that cannot roll back is non-atomic by definition.
        }
        throw error
      }
    }
    return this.toGroupExitMonitorState(nextState || this.deps.getGroupExitMonitorState())
  }

  listGroupExitMonitorEvents(query: URLSearchParams): {
    count: number
    events: AgentGroupExitMonitorEvent[]
  } {
    if (!this.deps.listGroupExitMonitorEvents) {
      throw new LocalAgentApiError(503, 'CAPABILITY_UNAVAILABLE', '退群事件查询能力尚未就绪')
    }
    const rawConversationId = query.get('conversationId')
    let roomId: string | undefined
    if (rawConversationId !== null) {
      roomId = rawConversationId.trim()
      if (!roomId || !roomId.endsWith('@chatroom') || roomId.includes('/') || roomId.includes('\\')) {
        throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', 'conversationId 必须是有效的群会话 ID')
      }
    }
    const since = this.parseDateFilter(query.get('since'), 'since')
    const until = this.parseDateFilter(query.get('until'), 'until')
    if (since !== undefined && until !== undefined && since > until) {
      throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', 'since 不能晚于 until')
    }
    const rawLimit = query.get('limit')
    const limit = rawLimit === null ? 50 : Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', 'limit 必须是 1 到 200 之间的整数')
    }
    const events = this.deps
      .listGroupExitMonitorEvents({ roomId, sinceMs: since, untilMs: until, limit })
      .slice()
      .sort((left, right) => left.detectedAt - right.detectedAt)
      .map((event) => this.toAgentGroupExitEvent(event))
    return { count: events.length, events }
  }

  async getGroupMemberStats(
    conversationId: string,
    query: URLSearchParams
  ): Promise<AgentGroupMemberStats> {
    if (!this.deps.isDatabaseReady()) {
      throw new LocalAgentApiError(409, 'DATABASE_NOT_READY', '数据库未就绪，无法查询群员统计')
    }
    const normalizedConversationId = conversationId.trim()
    if (!normalizedConversationId || normalizedConversationId.includes('/') || normalizedConversationId.includes('\\')) {
      throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', 'conversationId 格式无效')
    }
    const start = this.parseDateFilter(query.get('start'), 'start')
    const end = this.parseDateFilter(query.get('end'), 'end')
    if (start === undefined || end === undefined) {
      throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', 'start 和 end 必须同时提供')
    }
    if (start > end) {
      throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', 'start 不能晚于 end')
    }

    const contacts = await this.deps.listContacts()
    const matches = contacts.filter((contact) => contact.m_nsUsrName === normalizedConversationId)
    if (matches.length === 0) {
      throw new LocalAgentApiError(404, 'NOT_FOUND', '未找到指定会话')
    }
    if (matches.length > 1) {
      throw new LocalAgentApiError(409, 'AMBIGUOUS_CONTACT', 'conversationId 匹配到多个会话')
    }
    const contact = matches[0]
    if (contact.type !== 'group') {
      throw new LocalAgentApiError(422, 'NOT_GROUP_CONVERSATION', 'conversationId 不是群会话')
    }
    if (!contact.m_nsUsrName.endsWith('@chatroom')) {
      throw new LocalAgentApiError(422, 'NOT_GROUP_CONVERSATION', 'conversationId 不是有效的群会话 ID')
    }
    if (!this.deps.getGroupMemberStats) {
      throw new LocalAgentApiError(503, 'CAPABILITY_UNAVAILABLE', '群员统计能力尚未就绪')
    }

    const result = await this.deps.getGroupMemberStats({
      userMd5: contact.md5,
      startTime: start,
      endTime: end
    })
    return this.toAgentGroupMemberStats(contact, result)
  }

  async listAutomations(filter: {
    type?: string | null
    enabled?: string | null
  }): Promise<unknown[]> {
    if (filter.type && !RULE_TYPES.includes(filter.type as AutomationRuleType)) {
      throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', 'type 不受支持')
    }
    let enabled: boolean | undefined
    if (filter.enabled !== undefined && filter.enabled !== null) {
      if (filter.enabled !== 'true' && filter.enabled !== 'false') {
        throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', 'enabled 必须是 true 或 false')
      }
      enabled = filter.enabled === 'true'
    }
    const rules = this.deps.automationRuleStore
      .listRules()
      .filter(
        (rule) =>
          (!filter.type || rule.ruleType === filter.type) &&
          (enabled === undefined || rule.enabled === enabled)
      )
    return this.toApiRules(rules)
  }

  async getAutomation(id: string): Promise<unknown> {
    const rule = this.deps.automationRuleStore.getRule(id)
    if (!rule) throw new LocalAgentApiError(404, 'NOT_FOUND', '未找到自动化规则')
    return (await this.toApiRules([rule]))[0]
  }

  async validateAutomation(input: unknown): Promise<AgentAutomationValidationResult> {
    const structural = validateAutomationDraftShape(input)
    if (!structural.valid || !structural.normalized) {
      return { valid: false, issues: structural.issues }
    }

    const issues = [...structural.issues]
    const draft = structuredClone(structural.normalized)
    const references = await this.resolveDraftReferences(draft, issues)
    if (issues.length) return { valid: false, issues }

    const config = draft.scheduledReport
    const nextRunAt = config ? calculateNextRunAt(config.schedule.time) : null
    const effects = this.describeEffects(draft)
    return {
      valid: true,
      issues: [],
      normalized: draft,
      effects,
      nextRunAt,
      capabilities: {
        databaseReady: this.deps.isDatabaseReady(),
        referencedConversationsResolved: references
      }
    }
  }

  async createAutomation(input: unknown): Promise<unknown> {
    const raw = record(input)
    if (raw?.ruleType === 'leave_notification') {
      throw new LocalAgentApiError(409, 'SINGLETON_RULE', '退群通知是系统单例规则，请修改现有规则')
    }
    const validation = await this.validateAutomation(input)
    if (!validation.valid || !validation.normalized) {
      throw new LocalAgentApiError(
        422,
        'VALIDATION_FAILED',
        '自动化规则校验失败',
        validation.issues
      )
    }
    const contacts = await this.deps.listContacts()
    const storedDraft = this.toStoreDraft(validation.normalized as AutomationRuleDraft, contacts)
    storedDraft.enabled = false
    const created = this.deps.automationRuleStore.createRule(storedDraft)
    return (await this.toApiRules([created]))[0]
  }

  async updateAutomation(id: string, patchInput: unknown): Promise<unknown> {
    const current = this.deps.automationRuleStore.getRule(id)
    if (!current) throw new LocalAgentApiError(404, 'NOT_FOUND', '未找到自动化规则')
    const patch = record(patchInput)
    if (!patch) throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', '请求体必须是 JSON 对象')
    for (const key of Object.keys(patch)) {
      if (key === 'ruleType') {
        throw new LocalAgentApiError(400, 'RULE_TYPE_IMMUTABLE', 'ruleType 不可修改')
      }
      if (key === 'id' || key === 'createdAt' || key === 'updatedAt') {
        throw new LocalAgentApiError(400, 'IMMUTABLE_FIELD', `${key} 不允许由客户端修改`)
      }
      if (key === 'enabled') {
        throw new LocalAgentApiError(400, 'USE_ENABLE_OPERATION', '请使用 enable 或 disable 操作')
      }
      if (!UPDATE_FIELDS.has(key)) {
        throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', `不支持字段：${key}`)
      }
    }
    for (const configKey of ['leaveNotification', 'scheduledReport']) {
      if (Object.hasOwn(record(patch[configKey]) || {}, 'targetNeedsReview')) {
        throw new LocalAgentApiError(
          400,
          'IMMUTABLE_FIELD',
          `${configKey}.targetNeedsReview 只能通过更新 target 清除`
        )
      }
    }

    const apiCurrent = (await this.toApiRules([current]))[0] as AutomationRule & {
      requiresReview?: boolean
    }
    const candidate = deepMergeDraft(toDraft(apiCurrent), patch)
    const validation = await this.validateAutomation(candidate)
    if (!validation.valid || !validation.normalized) {
      throw new LocalAgentApiError(
        422,
        'VALIDATION_FAILED',
        '自动化规则校验失败',
        validation.issues
      )
    }

    const contacts = await this.deps.listContacts()
    const storedDraft = this.toStoreDraft(validation.normalized as AutomationRuleDraft, contacts)
    storedDraft.enabled = current.enabled
    const updated = this.deps.automationRuleStore.updateRule(id, storedDraft)
    if (!updated) throw new LocalAgentApiError(404, 'NOT_FOUND', '未找到自动化规则')
    return (await this.toApiRules([updated]))[0]
  }

  async setAutomationEnabled(id: string, enabled: boolean): Promise<unknown> {
    const current = this.deps.automationRuleStore.getRule(id)
    if (!current) throw new LocalAgentApiError(404, 'NOT_FOUND', '未找到自动化规则')
    if (enabled) {
      if (!this.deps.isDatabaseReady()) {
        throw new LocalAgentApiError(409, 'VALIDATION_FAILED', '数据库未就绪，无法启用自动化规则', [
          { path: 'database', code: 'database_not_ready', message: 'TraceMemo 数据库未初始化' }
        ])
      }
      const apiCurrent = (await this.toApiRules([current]))[0] as AutomationRule
      const draft = toDraft(apiCurrent)
      const validation = await this.validateAutomation(draft)
      if (!validation.valid) {
        throw new LocalAgentApiError(
          409,
          'VALIDATION_FAILED',
          '自动化规则校验失败，未启用',
          validation.issues
        )
      }
    }
    const updated = this.deps.automationRuleStore.setRuleEnabled(id, enabled)
    if (!updated) throw new LocalAgentApiError(404, 'NOT_FOUND', '未找到自动化规则')
    return (await this.toApiRules([updated]))[0]
  }

  async deleteAutomation(id: string): Promise<{ deletedId: string }> {
    if (id === BUILTIN_DAILY_REPORT_RULE_ID || id === BUILTIN_LEAVE_NOTIFICATION_RULE_ID) {
      throw new LocalAgentApiError(409, 'PROTECTED_RULE', '系统内置自动化规则不能删除')
    }
    const rule = this.deps.automationRuleStore.getRule(id)
    if (!rule) throw new LocalAgentApiError(404, 'NOT_FOUND', '未找到自动化规则')
    if (rule.ruleType === 'leave_notification') {
      throw new LocalAgentApiError(409, 'PROTECTED_RULE', '退群通知是系统单例规则，不能删除')
    }
    const deleted = this.deps.automationRuleStore.deleteRule(id)
    if (!deleted) throw new LocalAgentApiError(404, 'NOT_FOUND', '未找到自动化规则')
    return { deletedId: id }
  }

  listExecutions(query: URLSearchParams): {
    count: number
    executions: AgentAutomationExecution[]
  } {
    const ruleId = query.get('ruleId') || undefined
    const status = query.get('status') || undefined
    if (status && !EXECUTION_STATUSES.includes(status as AutomationExecution['status'])) {
      throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', 'status 不受支持')
    }
    const since = this.parseDateFilter(query.get('since'), 'since')
    const until = this.parseDateFilter(query.get('until'), 'until')
    if (since !== undefined && until !== undefined && since > until) {
      throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', 'since 不能晚于 until')
    }
    const rawLimit = query.get('limit')
    const limit = rawLimit === null ? 50 : Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', 'limit 必须是 1 到 200 之间的整数')
    }
    const rulesById = new Map(
      this.deps.automationRuleStore.listRules().map((rule) => [rule.id, rule])
    )
    const executions = this.deps.automationExecutionLogService
      .list({ limit: 200 })
      .filter((item) => !ruleId || item.ruleId === ruleId)
      .filter((item) => !status || item.status === status)
      .filter((item) => since === undefined || item.triggerTime >= since)
      .filter((item) => until === undefined || item.triggerTime <= until)
      .slice(0, limit)
      .map((item) => this.toApiExecution(item, rulesById.get(item.ruleId)?.ruleType))
    return { count: executions.length, executions }
  }

  private toGroupExitMonitorState(state: GroupExitMonitorStateSource): AgentGroupExitMonitorState {
    const eventCount = Number.isFinite(state.totalEventCount)
      ? Number(state.totalEventCount)
      : state.events?.length || 0
    return {
      enabled: state.enabled === true,
      running: state.running === true,
      nativeMonitorActive: state.nativeMonitorActive === true,
      monitoredConversationIds: [...(state.monitoredRoomIds || [])],
      monitoredGroupCount: Number.isFinite(state.monitoredGroupCount)
        ? Number(state.monitoredGroupCount)
        : state.monitoredRoomIds?.length || 0,
      monitorSelectionConfigured: state.monitorSelectionConfigured !== false,
      lastCheckedAt: toIsoTimestamp(state.lastCheckedAt),
      lastReadAt: toIsoTimestamp(state.lastReadAt),
      eventCount,
      unreadCount: Number.isFinite(state.unreadCount) ? Number(state.unreadCount) : 0
    }
  }

  private toAgentGroupExitEvent(event: GroupExitMonitorEvent): AgentGroupExitMonitorEvent {
    return {
      eventId: event.id,
      conversationId: event.roomId,
      groupName: event.groupName,
      memberId: event.memberWxid,
      memberName: event.memberName,
      wechatName: event.wechatName || '',
      groupRemark: event.groupRemark || '',
      contactRemark: event.contactRemark || '',
      previousCount: event.previousCount,
      currentCount: event.currentCount,
      delta: event.delta,
      message: event.message,
      detectedAt: new Date(event.detectedAt).toISOString()
    }
  }

  private toAgentGroupMemberStats(contact: Contact, result: GroupMemberStatsResult): AgentGroupMemberStats {
    const conversationName =
      contact.m_nsNickName || contact.remark || contact.wechatNickname || contact.m_nsUsrName
    return {
      conversation: { id: contact.m_nsUsrName, name: conversationName },
      conversationId: contact.m_nsUsrName,
      range: {
        start: new Date(result.startTime).toISOString(),
        end: new Date(result.endTime).toISOString()
      },
      memberCount: result.memberCount,
      activeMemberCount: result.activeMemberCount,
      silentMemberCount: result.silentMemberCount,
      activeMembers: result.activeMembers.map((member) => ({
        memberId: member.senderId,
        displayName: member.displayName,
        groupNickname: member.groupNickname,
        messageCount: member.messageCount,
        lastMessageAt: toIsoTimestamp(member.lastMessageTime)
      })),
      silentMembers: result.silentMembers.map((member) => ({
        memberId: member.senderId,
        displayName: member.displayName,
        groupNickname: member.groupNickname
      })),
      freshness: result.freshness,
      complete: result.complete,
      limitations: [...result.limitations],
      unattributedMessages: result.unattributedMessages,
      excludedSystemMessages: result.excludedSystemMessages,
      firstMessageAt:
        toIsoTimestamp(result.firstMessageTime ?? undefined)
    }
  }

  private parseDateFilter(value: string | null, name: string): number | undefined {
    if (value === null) return undefined
    if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', `${name} 必须是带时区的 ISO-8601 时间`)
    }
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) {
      throw new LocalAgentApiError(400, 'INVALID_ARGUMENT', `${name} 不是有效时间`)
    }
    return timestamp
  }

  private toApiExecution(
    execution: AutomationExecution,
    ruleType?: AutomationRuleType
  ): AgentAutomationExecution {
    return {
      executionId: execution.executionId,
      ruleId: execution.ruleId,
      ruleName: execution.ruleName,
      ...(ruleType ? { ruleType } : {}),
      ...(execution.trigger ? { trigger: execution.trigger } : {}),
      status: execution.status,
      triggerTime: execution.triggerTime,
      durationMs: execution.durationMs,
      sourceDisplayName: execution.sourceDisplayName,
      startedAt: new Date(execution.triggerTime).toISOString(),
      finishedAt:
        execution.status === 'running'
          ? null
          : new Date(execution.triggerTime + execution.durationMs).toISOString(),
      ...(execution.errorSummary ? { error: execution.errorSummary } : {})
    }
  }

  private async resolveDraftReferences(
    draft: AutomationRuleDraft,
    issues: AgentAutomationValidationIssue[]
  ): Promise<boolean> {
    const needsContacts =
      (draft.ruleType === 'daily_report' && draft.conditions.conversationIds.length > 0) ||
      draft.ruleType === 'scheduled_report' ||
      (draft.ruleType === 'leave_notification' &&
        (draft.leaveNotification?.target.type === 'contact' ||
          (draft.leaveNotification?.notifyRoomIds.length ?? 0) > 0))
    if (!needsContacts) return true
    if (!this.deps.isDatabaseReady()) {
      issues.push({
        path: 'database',
        code: 'database_not_ready',
        message: 'TraceMemo 数据库未初始化，无法解析联系人或群聊 ID'
      })
      return false
    }

    const contacts = await this.deps.listContacts()
    let resolved = true
    const resolve = (query: string, scope: RuleScope, path: string): Contact | undefined => {
      const direct = contacts.filter((contact) => {
        const identifiers = [
          contact.md5,
          contact.m_nsUsrName,
          contact.wxid,
          contact.wechatId,
          contact.alias
        ]
        return identifiers.some(
          (identifier) => identifier?.toLocaleLowerCase() === query.toLocaleLowerCase()
        )
      })
      const scopedDirect = direct.filter(
        (contact) =>
          scope === 'any' ||
          (scope === 'person' ? contact.type === 'user' : contact.type === 'group')
      )
      if (scopedDirect.length === 1) return scopedDirect[0]

      const result = resolveContact(query, contacts, scope)
      if (result.matched && result.conversationId) {
        return contacts.find((contact) => contact.md5 === result.conversationId)
      }
      resolved = false
      issues.push({
        path,
        code: result.ambiguous ? 'ambiguous_contact' : 'contact_not_found',
        message: result.ambiguous
          ? '标识匹配到多个联系人，请使用稳定 ID'
          : '无法解析到现有联系人或群聊',
        ...(result.ambiguous
          ? {
              details: {
                candidates: result.candidates.map((candidate) => {
                  const contact = contacts.find((item) => item.md5 === candidate.conversationId)
                  return contact
                    ? { id: stableId(contact), name: candidate.displayName }
                    : { id: candidate.conversationId, name: candidate.displayName }
                })
              }
            }
          : {})
      })
      return undefined
    }

    if (draft.ruleType === 'daily_report') {
      const scope: RuleScope =
        draft.scope === 'group' ? 'group' : draft.scope === 'direct' ? 'person' : 'any'
      const ids: string[] = []
      for (const [index, query] of draft.conditions.conversationIds.entries()) {
        const contact = resolve(query, scope, `conditions.conversationIds[${index}]`)
        if (contact) ids.push(stableId(contact))
      }
      draft.conditions.conversationIds = ids
    }

    if (draft.ruleType === 'scheduled_report' && draft.scheduledReport) {
      const source = resolve(
        draft.scheduledReport.report.sourceConversationId,
        'group',
        'scheduledReport.report.sourceConversationId'
      )
      if (source) draft.scheduledReport.report.sourceConversationId = source.m_nsUsrName
      if (draft.scheduledReport.target.type === 'contact') {
        const target = resolve(
          draft.scheduledReport.target.contactId || '',
          'person',
          'scheduledReport.target.contactId'
        )
        if (target) draft.scheduledReport.target.contactId = stableId(target)
      }
    }

    if (draft.ruleType === 'leave_notification' && draft.leaveNotification) {
      if (draft.leaveNotification.target.type === 'contact') {
        const target = resolve(
          draft.leaveNotification.target.contactId || '',
          'person',
          'leaveNotification.target.contactId'
        )
        if (target) draft.leaveNotification.target.contactId = stableId(target)
      }
      const ids: string[] = []
      for (const [index, query] of draft.leaveNotification.notifyRoomIds.entries()) {
        const group = resolve(query, 'group', `leaveNotification.notifyRoomIds[${index}]`)
        if (group) ids.push(group.m_nsUsrName)
      }
      draft.leaveNotification.notifyRoomIds = ids
    }
    return resolved
  }

  private toStoreDraft(draft: AutomationRuleDraft, contacts: Contact[]): AutomationRuleDraft {
    const stored = structuredClone(draft)
    if (stored.ruleType === 'daily_report') {
      stored.conditions.conversationIds = stored.conditions.conversationIds.map(
        (id) => contacts.find((contact) => stableId(contact) === id)?.md5 || id
      )
    }
    return stored
  }

  private async toApiRules(rules: AutomationRule[]): Promise<unknown[]> {
    const contacts = await this.deps.listContacts().catch(() => [])
    return rules.map((rule) => {
      const copy = structuredClone(rule) as AutomationRule & { requiresReview?: boolean }
      if (copy.ruleType === 'daily_report') {
        copy.conditions.conversationIds = copy.conditions.conversationIds.map((id) =>
          contacts.find((contact) => contact.md5 === id)
            ? stableId(contacts.find((contact) => contact.md5 === id)!)
            : id
        )
      }
      if (copy.ruleType === 'scheduled_report' && copy.scheduledReport) {
        copy.requiresReview = copy.scheduledReport.targetNeedsReview === true
        delete copy.scheduledReport.legacyTarget
        delete copy.scheduledReport.legacySourceGroup
        delete copy.scheduledReport.lastRunAt
        delete copy.scheduledReport.lastScheduledSlot
      }
      if (copy.ruleType === 'leave_notification' && copy.leaveNotification) {
        copy.requiresReview = copy.leaveNotification.targetNeedsReview === true
      }
      return copy
    })
  }

  private describeEffects(draft: AutomationRuleDraft): Record<string, unknown> {
    if (draft.ruleType === 'scheduled_report' && draft.scheduledReport) {
      const config = draft.scheduledReport
      return {
        generatesReport: true,
        sendsWechatMessage: true,
        sourceConversationId: config.report.sourceConversationId,
        target: config.target
      }
    }
    if (draft.ruleType === 'leave_notification' && draft.leaveNotification) {
      return {
        sendsWechatMessage: true,
        monitorScope: 'configured_in_group_exit_monitor',
        notificationScope: draft.leaveNotification.notifyScope,
        notificationRoomIds:
          draft.leaveNotification.notifyScope === 'selected'
            ? draft.leaveNotification.notifyRoomIds
            : undefined,
        target: draft.leaveNotification.target
      }
    }
    return {
      actions: draft.actions.filter((action) => action.enabled).map((action) => action.type),
      sendsWechatMessage: draft.actions.some(
        (action) => action.enabled && action.type === 'sendReportImage'
      )
    }
  }
}
