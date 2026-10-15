import {
  AUTOMATION_REPLY_DELAY_MAX_SECONDS,
  SCHEDULED_REPORT_MAX_TIMEOUT_SECONDS,
  SCHEDULED_REPORT_MIN_TIMEOUT_SECONDS,
  SCHEDULED_REPORT_POSTFIX_MAX_LENGTH,
  normalizeRuleDraft,
  type AutomationRuleDraft,
  type AutomationRuleType
} from '../automation'
import { validateGroupExitNotificationTemplate } from '../group-exit-monitor'
import { isSelectableReportTemplateId } from '../report-templates'
import {
  type ScheduledReportMemberNameMode,
  type ScheduledReportMessageType,
  type ScheduledReportRange
} from '../scheduled-report'
import type { AgentAutomationValidationIssue } from './contracts'

type JsonRecord = Record<string, unknown>

const RULE_TYPES: AutomationRuleType[] = ['daily_report', 'scheduled_report', 'leave_notification']
const SCOPES = ['group', 'direct', 'all'] as const
const KEYWORD_MODES = ['contains', 'exact', 'prefix'] as const
const ACTION_TYPES = ['replyText', 'generateReport', 'sendReportImage'] as const
const SCHEDULE_RANGES: ScheduledReportRange[] = ['today', 'yesterday', '7days', 'recent24h']
const MESSAGE_TYPES: ScheduledReportMessageType[] = [
  'text',
  'image',
  'sticker',
  'video',
  'voice',
  'share',
  'system'
]
const MEMBER_NAME_MODES: ScheduledReportMemberNameMode[] = [
  'groupNickname',
  'wechatNickname',
  'remark'
]
const TARGET_TYPES = ['source_chat', 'self', 'file_transfer', 'contact'] as const

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined
}

function addIssue(
  issues: AgentAutomationValidationIssue[],
  path: string,
  code: string,
  message: string
): void {
  issues.push({ path, code, message })
}

function checkObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  issues: AgentAutomationValidationIssue[]
): JsonRecord | undefined {
  const record = asRecord(value)
  if (!record) {
    addIssue(issues, path, 'invalid_type', '必须是 JSON 对象')
    return undefined
  }
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      addIssue(issues, `${path}.${key}`, 'unknown_field', '不支持此字段')
    }
  }
  return record
}

function checkString(
  value: unknown,
  path: string,
  issues: AgentAutomationValidationIssue[],
  options: { required?: boolean; max?: number; allowEmpty?: boolean } = {}
): value is string {
  if (typeof value !== 'string') {
    if (options.required || value !== undefined) {
      addIssue(issues, path, 'invalid_type', '必须是字符串')
    }
    return false
  }
  const trimmed = value.trim()
  if (options.required && !trimmed) addIssue(issues, path, 'required', '不能为空')
  if (!options.allowEmpty && !options.required && value.length > 0 && !trimmed) {
    addIssue(issues, path, 'invalid_value', '不能只包含空白字符')
  }
  if (options.max !== undefined && value.length > options.max) {
    addIssue(issues, path, 'too_long', `最多 ${options.max} 个字符`)
  }
  return true
}

function checkBoolean(
  value: unknown,
  path: string,
  issues: AgentAutomationValidationIssue[],
  required = false
): void {
  if (value === undefined && !required) return
  if (typeof value !== 'boolean') addIssue(issues, path, 'invalid_type', '必须是布尔值')
}

function checkInteger(
  value: unknown,
  path: string,
  issues: AgentAutomationValidationIssue[],
  min: number,
  max: number,
  required = false
): void {
  if (value === undefined && !required) return
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    addIssue(issues, path, 'out_of_range', `必须是 ${min} 到 ${max} 之间的整数`)
  }
}

function checkEnum(
  value: unknown,
  path: string,
  values: readonly string[],
  issues: AgentAutomationValidationIssue[],
  required = false
): void {
  if (value === undefined && !required) return
  if (typeof value !== 'string' || !values.includes(value)) {
    addIssue(issues, path, 'invalid_enum', `仅支持：${values.join(', ')}`)
  }
}

function validateDailyReport(raw: JsonRecord, issues: AgentAutomationValidationIssue[]): void {
  const conditions = checkObject(
    raw.conditions,
    'conditions',
    ['requireMentionMe', 'keyword', 'keywordMatchMode', 'conversationIds', 'ignoreSelf'],
    issues
  )
  if (conditions) {
    checkBoolean(conditions.requireMentionMe, 'conditions.requireMentionMe', issues, true)
    checkBoolean(conditions.ignoreSelf, 'conditions.ignoreSelf', issues, true)
    if (conditions.keyword === undefined) {
      addIssue(issues, 'conditions.keyword', 'required', '必须是字符串')
    } else {
      checkString(conditions.keyword, 'conditions.keyword', issues, { max: 200, allowEmpty: true })
    }
    checkEnum(
      conditions.keywordMatchMode,
      'conditions.keywordMatchMode',
      KEYWORD_MODES,
      issues,
      true
    )
    if (!Array.isArray(conditions.conversationIds)) {
      addIssue(issues, 'conditions.conversationIds', 'invalid_type', '必须是 ID 数组')
    } else {
      if (conditions.conversationIds.length > 100) {
        addIssue(issues, 'conditions.conversationIds', 'too_many_items', '最多支持 100 个会话')
      }
      conditions.conversationIds.forEach((id, index) =>
        checkString(id, `conditions.conversationIds[${index}]`, issues, {
          required: true,
          max: 300
        })
      )
    }
  }

  if (!Array.isArray(raw.actions)) {
    addIssue(issues, 'actions', 'invalid_type', '必须是动作数组')
    return
  }
  if (raw.actions.length > 3) addIssue(issues, 'actions', 'too_many_items', '最多支持 3 个动作')
  const seen = new Set<string>()
  raw.actions.forEach((actionValue, index) => {
    const path = `actions[${index}]`
    const action = checkObject(actionValue, path, ['type', 'enabled', 'text'], issues)
    if (!action) return
    checkEnum(action.type, `${path}.type`, ACTION_TYPES, issues, true)
    checkBoolean(action.enabled, `${path}.enabled`, issues, true)
    if (typeof action.type === 'string') {
      if (seen.has(action.type))
        addIssue(issues, `${path}.type`, 'duplicate_action', '动作不能重复')
      seen.add(action.type)
      if (action.type === 'replyText') {
        checkString(action.text, `${path}.text`, issues, {
          required: action.enabled === true,
          max: 2_000,
          allowEmpty: action.enabled !== true
        })
      } else if (action.text !== undefined) {
        addIssue(issues, `${path}.text`, 'unknown_field', '此动作不支持 text')
      }
    }
  })
}

function validateTarget(
  value: unknown,
  path: string,
  issues: AgentAutomationValidationIssue[]
): void {
  const target = checkObject(value, path, ['type', 'contactId'], issues)
  if (!target) return
  checkEnum(target.type, `${path}.type`, TARGET_TYPES, issues, true)
  if (target.type === 'contact') {
    checkString(target.contactId, `${path}.contactId`, issues, { required: true, max: 300 })
  } else if (target.contactId !== undefined) {
    addIssue(issues, `${path}.contactId`, 'unexpected_field', '仅 contact 目标可设置 contactId')
  }
}

function validateScheduledReport(raw: JsonRecord, issues: AgentAutomationValidationIssue[]): void {
  checkBoolean(raw.targetNeedsReview, 'scheduledReport.targetNeedsReview', issues)
  if (raw.targetNeedsReview === true) {
    addIssue(
      issues,
      'scheduledReport.targetNeedsReview',
      'target_needs_review',
      '发送目标需要在 TraceMemo 中重新确认'
    )
  }
  if (raw.postfixText !== undefined) {
    checkString(raw.postfixText, 'scheduledReport.postfixText', issues, {
      max: SCHEDULED_REPORT_POSTFIX_MAX_LENGTH,
      allowEmpty: true
    })
  }

  const schedule = checkObject(raw.schedule, 'scheduledReport.schedule', ['time'], issues)
  if (schedule) {
    if (typeof schedule.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
      addIssue(issues, 'scheduledReport.schedule.time', 'invalid_time', '时间必须使用 HH:mm 格式')
    }
  }

  const report = checkObject(
    raw.report,
    'scheduledReport.report',
    [
      'sourceConversationId',
      'range',
      'messageTypes',
      'templateId',
      'memberNameMode',
      'timeoutSeconds'
    ],
    issues
  )
  if (report) {
    checkString(
      report.sourceConversationId,
      'scheduledReport.report.sourceConversationId',
      issues,
      {
        required: true,
        max: 300
      }
    )
    checkEnum(report.range, 'scheduledReport.report.range', SCHEDULE_RANGES, issues, true)
    if (!Array.isArray(report.messageTypes) || report.messageTypes.length === 0) {
      addIssue(issues, 'scheduledReport.report.messageTypes', 'required', '至少选择一种消息类型')
    } else {
      report.messageTypes.forEach((type, index) =>
        checkEnum(
          type,
          `scheduledReport.report.messageTypes[${index}]`,
          MESSAGE_TYPES,
          issues,
          true
        )
      )
    }
    if (!isSelectableReportTemplateId(report.templateId)) {
      addIssue(issues, 'scheduledReport.report.templateId', 'invalid_template', '模板 ID 不受支持')
    }
    checkEnum(
      report.memberNameMode,
      'scheduledReport.report.memberNameMode',
      MEMBER_NAME_MODES,
      issues,
      true
    )
    checkInteger(
      report.timeoutSeconds,
      'scheduledReport.report.timeoutSeconds',
      issues,
      SCHEDULED_REPORT_MIN_TIMEOUT_SECONDS,
      SCHEDULED_REPORT_MAX_TIMEOUT_SECONDS,
      true
    )
  }
  validateTarget(raw.target, 'scheduledReport.target', issues)
}

function validateLeaveNotification(
  raw: JsonRecord,
  issues: AgentAutomationValidationIssue[]
): void {
  checkBoolean(raw.targetNeedsReview, 'leaveNotification.targetNeedsReview', issues)
  if (raw.targetNeedsReview === true) {
    addIssue(
      issues,
      'leaveNotification.targetNeedsReview',
      'target_needs_review',
      '发送目标需要在 TraceMemo 中重新确认'
    )
  }
  validateTarget(raw.target, 'leaveNotification.target', issues)
  checkEnum(raw.notifyScope, 'leaveNotification.notifyScope', ['all', 'selected'], issues, true)
  if (!Array.isArray(raw.notifyRoomIds)) {
    addIssue(issues, 'leaveNotification.notifyRoomIds', 'invalid_type', '必须是群聊 ID 数组')
  } else {
    if (raw.notifyRoomIds.length > 500) {
      addIssue(issues, 'leaveNotification.notifyRoomIds', 'too_many_items', '最多支持 500 个群聊')
    }
    raw.notifyRoomIds.forEach((id, index) =>
      checkString(id, `leaveNotification.notifyRoomIds[${index}]`, issues, {
        required: true,
        max: 300
      })
    )
  }
  checkString(raw.template, 'leaveNotification.template', issues, { required: true, max: 2_000 })
  const templateResult = validateGroupExitNotificationTemplate(raw.template)
  if (!templateResult.valid) {
    addIssue(
      issues,
      'leaveNotification.template',
      'invalid_template',
      templateResult.error || '模板无效'
    )
  }
}

/** Strict structural validation before the existing tolerant Store normalizer is called. */
export function validateAutomationDraftShape(input: unknown): {
  valid: boolean
  issues: AgentAutomationValidationIssue[]
  normalized?: AutomationRuleDraft
} {
  const issues: AgentAutomationValidationIssue[] = []
  const raw = checkObject(
    input,
    'draft',
    [
      'name',
      'enabled',
      'ruleType',
      'trigger',
      'scope',
      'conditions',
      'actions',
      'cooldownSeconds',
      'replyDelaySeconds',
      'leaveNotification',
      'scheduledReport'
    ],
    issues
  )
  if (!raw) return { valid: false, issues }

  checkString(raw.name, 'name', issues, { required: true, max: 100 })
  checkEnum(raw.ruleType, 'ruleType', RULE_TYPES, issues, true)
  if (raw.enabled !== undefined) checkBoolean(raw.enabled, 'enabled', issues, true)
  if (raw.enabled === true) {
    addIssue(
      issues,
      'enabled',
      'use_enable_operation',
      '创建和校验不能启用规则，请使用 enable 操作'
    )
  }
  checkEnum(raw.trigger, 'trigger', ['message'], issues, false)
  checkEnum(raw.scope, 'scope', SCOPES, issues, false)
  checkInteger(raw.cooldownSeconds, 'cooldownSeconds', issues, 0, 86_400)
  checkInteger(
    raw.replyDelaySeconds,
    'replyDelaySeconds',
    issues,
    0,
    AUTOMATION_REPLY_DELAY_MAX_SECONDS
  )

  if (raw.ruleType !== 'scheduled_report' && raw.scheduledReport !== undefined) {
    addIssue(issues, 'scheduledReport', 'unexpected_field', '此规则类型不支持 scheduledReport')
  }
  if (raw.ruleType !== 'leave_notification' && raw.leaveNotification !== undefined) {
    addIssue(issues, 'leaveNotification', 'unexpected_field', '此规则类型不支持 leaveNotification')
  }

  if (raw.ruleType === 'daily_report') validateDailyReport(raw, issues)
  if (raw.ruleType === 'scheduled_report') {
    if (raw.scheduledReport === undefined) {
      addIssue(issues, 'scheduledReport', 'required', '必须提供定时日报配置')
    } else {
      const scheduled = checkObject(
        raw.scheduledReport,
        'scheduledReport',
        ['schedule', 'report', 'target', 'postfixText', 'targetNeedsReview'],
        issues
      )
      if (scheduled) validateScheduledReport(scheduled, issues)
    }
  }
  if (raw.ruleType === 'leave_notification') {
    if (raw.leaveNotification === undefined) {
      addIssue(issues, 'leaveNotification', 'required', '必须提供退群通知配置')
    } else {
      const leave = checkObject(
        raw.leaveNotification,
        'leaveNotification',
        ['target', 'template', 'notifyScope', 'notifyRoomIds', 'targetNeedsReview'],
        issues
      )
      if (leave) validateLeaveNotification(leave, issues)
    }
  }

  if (issues.length) return { valid: false, issues }
  const ruleType = raw.ruleType as AutomationRuleType
  const normalized = normalizeRuleDraft({
    ...raw,
    enabled: false,
    ...(ruleType === 'daily_report'
      ? {}
      : {
          scope: 'group',
          conditions: {
            requireMentionMe: false,
            keyword: '',
            keywordMatchMode: 'contains',
            conversationIds: [],
            ignoreSelf: true
          },
          actions: [],
          cooldownSeconds: 0
        })
  })
  return { valid: true, issues: [], normalized: { ...normalized, enabled: false } }
}
