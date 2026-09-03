import { app } from 'electron'
import { createHash, randomUUID } from 'crypto'
import fs from 'fs-extra'
import path from 'path'
import type {
  PersonalWechatSendCapability,
  PersonalWechatSendRequest,
  PersonalWechatSendResult
} from '../../shared/personal-wechat'
import type {
  PolicyDecision,
  WechatActionAuditRecord,
  WechatActionContent,
  WechatActionErrorCode,
  WechatActionMemberEventReference,
  WechatActionRequest,
  WechatActionResult
} from '../../shared/wechat-action'
import { personalWechatCapabilityService } from './personal-wechat-capability-service'
import { personalWechatSendService } from './personal-wechat-send-service'

const MAX_AUDIT_RECORDS = 500
const MAX_CONTENT_PREVIEW_LENGTH = 240
export const AUTOMATION_SEND_INTERVAL_MS = 3_000
const AUTOMATION_PURPOSE_ALLOWLIST = new Set(['scheduled_report', 'member_left_notification'])

export interface WechatActionGatewayDependencies {
  getCapability?: () => Promise<PersonalWechatSendCapability>
  send?: (request: PersonalWechatSendRequest) => Promise<PersonalWechatSendResult>
  getMemberEvent?: (
    sourceId: string
  ) =>
    | WechatActionMemberEventReference
    | Promise<WechatActionMemberEventReference | undefined>
    | undefined
  getUserDataPath?: () => string
  now?: () => Date
  wait?: (milliseconds: number) => Promise<void>
}

interface LoadedAuditState {
  path: string
  records: WechatActionAuditRecord[]
}

export interface WechatActionPolicyContext {
  memberEvent?: WechatActionMemberEventReference
}

const defaultDependencies = (): Required<
  Pick<
    WechatActionGatewayDependencies,
    'getCapability' | 'send' | 'getUserDataPath' | 'now' | 'wait'
  >
> => ({
  getCapability: () => personalWechatCapabilityService.getPersonalWechatSendCapability(),
  send: (request) => personalWechatSendService.send(request),
  getUserDataPath: () => app.getPath('userData'),
  now: () => new Date(),
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
})

/**
 * 统一管理微信发送操作，在真正发送前完成必要检查；
 * 具体发送由底层服务处理，使用者只需提供发送内容和对象。
 */
export class WechatActionGateway {
  private readonly deps: Required<
    Pick<
      WechatActionGatewayDependencies,
      'getCapability' | 'send' | 'getUserDataPath' | 'now' | 'wait'
    >
  > &
    Omit<
      WechatActionGatewayDependencies,
      'getCapability' | 'send' | 'getUserDataPath' | 'now' | 'wait'
    >
  private readonly memberEvents = new Map<string, WechatActionMemberEventReference>()
  private readonly inFlight = new Map<string, Promise<WechatActionResult>>()
  private auditState: LoadedAuditState | null = null
  private automationSendTail: Promise<void> = Promise.resolve()
  private lastAutomationSendStartedAt: number | undefined

  constructor(deps: WechatActionGatewayDependencies = {}) {
    this.deps = { ...defaultDependencies(), ...deps }
  }

  /** 记录退群事件，发送通知前可确认事件所属群聊。 */
  registerMemberEvent(event: WechatActionMemberEventReference): void {
    const id = String(event?.id || '').trim()
    const roomId = String(event?.roomId || '').trim()
    if (!id || !roomId) return
    this.memberEvents.set(id, { id, roomId })
  }

  registerMemberEvents(events: WechatActionMemberEventReference[]): void {
    for (const event of events) this.registerMemberEvent(event)
  }

  clearMemberEvents(): void {
    this.memberEvents.clear()
  }

  listAuditRecords(): WechatActionAuditRecord[] {
    return this.loadAuditState().records.map((record) => ({ ...record }))
  }

  async execute(request: WechatActionRequest): Promise<WechatActionResult> {
    const normalized = normalizeActionRequest(request)
    const idempotencyKey = normalized ? this.idempotencyKey(normalized) : undefined
    if (idempotencyKey) {
      const existing = await this.findExisting(idempotencyKey)
      if (existing) return existing
      const running = this.inFlight.get(idempotencyKey)
      if (running) return running
    }

    const promise = this.executeOnce(request, normalized, idempotencyKey)
    if (idempotencyKey) this.inFlight.set(idempotencyKey, promise)
    try {
      return await promise
    } finally {
      if (idempotencyKey && this.inFlight.get(idempotencyKey) === promise) {
        this.inFlight.delete(idempotencyKey)
      }
    }
  }

  private async executeOnce(
    originalRequest: WechatActionRequest,
    request: WechatActionRequest | null,
    idempotencyKey?: string
  ): Promise<WechatActionResult> {
    const startedAt = this.deps.now().toISOString()
    const actionId = String(originalRequest?.id || '').trim() || randomUUID()
    if (!request) {
      return this.finishBlocked(
        actionId,
        originalRequest,
        idempotencyKey,
        startedAt,
        validationErrorCode(originalRequest),
        validationErrorReason(originalRequest)
      )
    }

    const eventContext = await this.resolveEventContext(request)
    const policy = evaluateWechatActionPolicy(request, eventContext)
    if (policy.decision !== 'allow') {
      return this.finishBlocked(
        actionId,
        request,
        idempotencyKey,
        startedAt,
        policy.reasonCode || 'POLICY_BLOCKED',
        policy.reason || '该发送动作未通过策略检查'
      )
    }

    const capabilityType = request.content.type
    let capability: PersonalWechatSendCapability | undefined
    try {
      capability = await this.deps.getCapability()
    } catch (error) {
      return this.finishFailed(
        actionId,
        request,
        idempotencyKey,
        startedAt,
        'SEND_CAPABILITY_UNAVAILABLE',
        error instanceof Error ? error.message : String(error)
      )
    }
    if (!capability || !capability.ready) {
      return this.finishFailed(
        actionId,
        request,
        idempotencyKey,
        startedAt,
        'SEND_CAPABILITY_UNAVAILABLE',
        capability?.error || capability?.message || '个人微信发送能力不可用'
      )
    }
    if (!capability.capabilities?.[capabilityType]) {
      return this.finishFailed(
        actionId,
        request,
        idempotencyKey,
        startedAt,
        'SEND_NOT_READY',
        capability.message || `个人微信尚未准备好发送${contentTypeLabel(capabilityType)}`
      )
    }

    let sendResult: PersonalWechatSendResult
    try {
      sendResult = await this.send(request)
    } catch (error) {
      return this.finishFailed(
        actionId,
        request,
        idempotencyKey,
        startedAt,
        'SEND_FAILED',
        error instanceof Error ? error.message : String(error)
      )
    }
    if (!sendResult.success) {
      return this.finishFailed(
        actionId,
        request,
        idempotencyKey,
        startedAt,
        'SEND_FAILED',
        sendResult.error || '微信发送失败',
        sendResult
      )
    }
    return this.finishSent(actionId, request, idempotencyKey, startedAt, sendResult)
  }

  private send(request: WechatActionRequest): Promise<PersonalWechatSendResult> {
    const sendRequest = toPersonalWechatSendRequest(request)
    if (request.triggerType !== 'automation') return this.deps.send(sendRequest)

    const queued = this.automationSendTail.then(async () => {
      const now = this.deps.now().getTime()
      const remaining = this.lastAutomationSendStartedAt !== undefined
        ? Math.max(0, AUTOMATION_SEND_INTERVAL_MS - (now - this.lastAutomationSendStartedAt))
        : 0
      if (remaining > 0) await this.deps.wait(remaining)
      this.lastAutomationSendStartedAt = this.deps.now().getTime()
      return this.deps.send(sendRequest)
    })
    this.automationSendTail = queued.then(
      () => undefined,
      () => undefined
    )
    return queued
  }

  private async resolveEventContext(
    request: WechatActionRequest
  ): Promise<WechatActionPolicyContext> {
    if (request.purpose !== 'member_left_notification') return {}
    const sourceId = String(request.sourceId || '').trim()
    if (!sourceId) return {}
    let memberEvent: WechatActionMemberEventReference | undefined = this.memberEvents.get(sourceId)
    if (!memberEvent && this.deps.getMemberEvent) {
      let resolved: WechatActionMemberEventReference | undefined
      try {
        resolved = await this.deps.getMemberEvent(sourceId)
      } catch {
        resolved = undefined
      }
      if (resolved && String(resolved.id || '').trim() === sourceId) {
        memberEvent = { id: String(resolved.id), roomId: String(resolved.roomId) }
        this.registerMemberEvent(memberEvent)
      }
    }
    return memberEvent ? { memberEvent } : {}
  }

  private async findExisting(idempotencyKey: string): Promise<WechatActionResult | undefined> {
    const state = this.loadAuditState()
    const existing = state.records.find((record) => record.idempotencyKey === idempotencyKey)
    if (!existing) return undefined
    return {
      actionId: existing.actionId,
      status: existing.sendStatus,
      decision: existing.decision,
      ...(existing.errorCode ? { errorCode: existing.errorCode } : {}),
      ...(existing.decisionReason ? { reason: existing.decisionReason } : {}),
      startedAt: existing.startedAt,
      finishedAt: existing.finishedAt
    }
  }

  private idempotencyKey(request: WechatActionRequest): string | undefined {
    const explicit = String(request.idempotencyKey || '').trim()
    if (explicit) return explicit
    if (request.purpose === 'member_left_notification' && request.sourceId) {
      return `member_left_notification:${request.sourceId}`
    }
    if (request.origin === 'scheduled_report' && request.executionId) {
      return `scheduled_report:${request.executionId}`
    }
    return undefined
  }

  private finishSent(
    actionId: string,
    request: WechatActionRequest,
    idempotencyKey: string | undefined,
    startedAt: string,
    sendResult: PersonalWechatSendResult
  ): WechatActionResult {
    const finishedAt = this.deps.now().toISOString()
    const result: WechatActionResult = {
      actionId,
      status: 'sent',
      decision: 'allow',
      startedAt,
      finishedAt,
      sendResult
    }
    this.writeAudit(request, idempotencyKey, result)
    return result
  }

  private finishFailed(
    actionId: string,
    request: WechatActionRequest,
    idempotencyKey: string | undefined,
    startedAt: string,
    errorCode: WechatActionErrorCode,
    reason: string,
    sendResult?: PersonalWechatSendResult
  ): WechatActionResult {
    const finishedAt = this.deps.now().toISOString()
    const result: WechatActionResult = {
      actionId,
      status: 'failed',
      decision: 'allow',
      errorCode,
      reason,
      startedAt,
      finishedAt,
      ...(sendResult ? { sendResult } : {})
    }
    this.writeAudit(request, idempotencyKey, result)
    return result
  }

  private finishBlocked(
    actionId: string,
    request: WechatActionRequest,
    idempotencyKey: string | undefined,
    startedAt: string,
    errorCode: WechatActionErrorCode,
    reason: string
  ): WechatActionResult {
    const finishedAt = this.deps.now().toISOString()
    const result: WechatActionResult = {
      actionId,
      status: 'blocked',
      decision: 'block',
      errorCode,
      reason,
      startedAt,
      finishedAt
    }
    this.writeAudit(request, idempotencyKey, result)
    return result
  }

  private loadAuditState(): LoadedAuditState {
    const filePath = this.auditFilePath()
    if (this.auditState?.path === filePath) return this.auditState
    let records: WechatActionAuditRecord[] = []
    try {
      const value = fs.readJsonSync(filePath) as unknown
      if (Array.isArray(value)) records = normalizeAuditRecords(value)
      else if (
        value &&
        typeof value === 'object' &&
        Array.isArray((value as { actions?: unknown }).actions)
      ) {
        records = normalizeAuditRecords((value as { actions: unknown[] }).actions)
      }
    } catch {
      records = []
    }
    this.auditState = { path: filePath, records }
    return this.auditState
  }

  private writeAudit(
    request: WechatActionRequest,
    idempotencyKey: string | undefined,
    result: WechatActionResult
  ): void {
    if (
      !request ||
      !request.recipient ||
      (request.recipient.type !== 'group' && request.recipient.type !== 'contact') ||
      !request.content ||
      (request.content.type !== 'text' &&
        request.content.type !== 'image' &&
        request.content.type !== 'voice')
    ) {
      return
    }
    const state = this.loadAuditState()
    const record: WechatActionAuditRecord = {
      actionId: result.actionId,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      origin: request.origin,
      purpose: request.purpose,
      triggerType: request.triggerType,
      ...(request.sourceId ? { sourceId: request.sourceId } : {}),
      ...(request.executionId ? { executionId: request.executionId } : {}),
      recipientType: request.recipient.type,
      recipientId: request.recipient.id,
      ...(request.recipient.name ? { recipientName: request.recipient.name } : {}),
      contentType: request.content.type,
      ...contentAudit(request.content),
      createdAt: result.startedAt,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      decision: result.decision,
      ...(result.reason ? { decisionReason: result.reason } : {}),
      sendStatus: result.status,
      ...(result.errorCode ? { errorCode: result.errorCode } : {})
    }
    const withoutKey = state.records.filter((item) => item.actionId !== record.actionId)
    state.records = [record, ...withoutKey].slice(0, MAX_AUDIT_RECORDS)
    try {
      fs.ensureDirSync(path.dirname(state.path))
      fs.writeJsonSync(state.path, state.records, { spaces: 2 })
    } catch (error) {
      console.warn('[WechatActionGateway] 保存 Action 审计失败:', error)
    }
  }

  private auditFilePath(): string {
    return path.join(this.deps.getUserDataPath(), 'actions', 'wechat-actions.json')
  }
}

export function evaluateWechatActionPolicy(
  request: WechatActionRequest,
  context: WechatActionPolicyContext = {}
): PolicyDecision {
  if (!request || typeof request !== 'object') {
    return {
      decision: 'block',
      source: 'deterministic',
      reasonCode: 'INVALID_REQUEST',
      reason: '发送动作请求格式无效'
    }
  }
  const recipient = request.recipient
  if (
    !recipient ||
    typeof recipient !== 'object' ||
    (recipient.type !== 'group' && recipient.type !== 'contact') ||
    !String(recipient.id || '').trim()
  ) {
    return {
      decision: 'block',
      source: 'deterministic',
      reasonCode: 'INVALID_RECIPIENT',
      reason: '发送动作必须指定有效的收件人'
    }
  }
  if (request.triggerType === 'automation' && !AUTOMATION_PURPOSE_ALLOWLIST.has(request.purpose)) {
    return {
      decision: 'block',
      source: 'deterministic',
      reasonCode: 'ACTION_NOT_ALLOWED',
      reason: `自动化动作不允许执行 purpose=${request.purpose}`
    }
  }
  if (request.purpose === 'member_left_notification') {
    if (
      !request.sourceId ||
      !context.memberEvent ||
      context.memberEvent.id !== request.sourceId ||
      !context.memberEvent.roomId
    ) {
      return {
        decision: 'block',
        source: 'deterministic',
        reasonCode: 'INVALID_REQUEST',
        reason: '退群通知必须关联已记录的退群事件'
      }
    }
    if (request.recipient.type !== 'group' || request.recipient.id !== context.memberEvent.roomId) {
      return {
        decision: 'block',
        source: 'deterministic',
        reasonCode: 'RECIPIENT_SCOPE_VIOLATION',
        reason: '退群通知只能发送回原事件所在群聊'
      }
    }
  }
  return { decision: 'allow', source: 'deterministic' }
}

/** 发送前会根据固定规则检查是否允许发送。 */
export function shouldUseAiPolicy(request: WechatActionRequest): boolean {
  void request
  return false
}

export function normalizeActionRequest(value: unknown): WechatActionRequest | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<WechatActionRequest>
  const origin = String(input.origin || '').trim()
  const purpose = String(input.purpose || '').trim()
  const triggerType = input.triggerType
  const recipient = input.recipient
  const content = input.content
  if (!origin || !purpose || (triggerType !== 'automation' && triggerType !== 'user')) return null
  if (!recipient || typeof recipient !== 'object') return null
  const recipientType = (recipient as { type?: unknown }).type
  const recipientId = String((recipient as { id?: unknown }).id || '').trim()
  if (recipientType !== 'group' && recipientType !== 'contact') return null
  if (!recipientId) return null
  if (!content || typeof content !== 'object') return null
  const contentType = (content as { type?: unknown }).type
  if (contentType === 'text') {
    const text = String((content as { text?: unknown }).text || '').trim()
    if (!text || text.length > 2_000) return null
    return {
      ...input,
      origin,
      purpose,
      triggerType,
      ...(input.id ? { id: String(input.id).trim() } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: String(input.idempotencyKey).trim() } : {}),
      ...(input.sourceId ? { sourceId: String(input.sourceId).trim() } : {}),
      ...(input.executionId ? { executionId: String(input.executionId).trim() } : {}),
      recipient: {
        type: recipientType,
        id: recipientId,
        ...((recipient as { name?: unknown }).name
          ? { name: String((recipient as { name?: unknown }).name).trim() }
          : {})
      },
      content: { type: 'text', text }
    } as WechatActionRequest
  }
  if (contentType !== 'image' && contentType !== 'voice') return null
  const filePath = String((content as { path?: unknown }).path || '').trim()
  if (!filePath) return null
  return {
    ...input,
    origin,
    purpose,
    triggerType,
    ...(input.id ? { id: String(input.id).trim() } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: String(input.idempotencyKey).trim() } : {}),
    ...(input.sourceId ? { sourceId: String(input.sourceId).trim() } : {}),
    ...(input.executionId ? { executionId: String(input.executionId).trim() } : {}),
    recipient: {
      type: recipientType,
      id: recipientId,
      ...((recipient as { name?: unknown }).name
        ? { name: String((recipient as { name?: unknown }).name).trim() }
        : {})
    },
    content: { type: contentType, path: filePath }
  } as WechatActionRequest
}

function validationErrorCode(value: unknown): WechatActionErrorCode {
  if (!value || typeof value !== 'object') return 'INVALID_REQUEST'
  const recipient = (value as { recipient?: unknown }).recipient
  if (!recipient || typeof recipient !== 'object') return 'INVALID_RECIPIENT'
  const recipientValue = recipient as { type?: unknown; id?: unknown }
  if (
    (recipientValue.type !== 'group' && recipientValue.type !== 'contact') ||
    !String(recipientValue.id || '').trim()
  ) {
    return 'INVALID_RECIPIENT'
  }
  return 'INVALID_REQUEST'
}

function validationErrorReason(value: unknown): string {
  return validationErrorCode(value) === 'INVALID_RECIPIENT'
    ? '发送动作必须指定有效的收件人'
    : '发送动作请求格式无效'
}

function toPersonalWechatSendRequest(request: WechatActionRequest): PersonalWechatSendRequest {
  const base = {
    to: request.recipient.id,
    isGroup: request.recipient.type === 'group'
  }
  if (request.content.type === 'text') return { ...base, type: 'text', text: request.content.text }
  if (request.content.type === 'image') {
    return { ...base, type: 'image', filePath: request.content.path }
  }
  return { ...base, type: 'voice', filePath: request.content.path }
}

function contentAudit(
  content: WechatActionContent
): Pick<WechatActionAuditRecord, 'contentPreview' | 'contentHash'> {
  const raw = content.type === 'text' ? content.text : content.path
  const preview = content.type === 'text' ? raw : path.basename(raw)
  return {
    contentPreview: preview.slice(0, MAX_CONTENT_PREVIEW_LENGTH),
    contentHash: createHash('sha256').update(raw).digest('hex')
  }
}

function contentTypeLabel(type: WechatActionContent['type']): string {
  return type === 'text' ? '文字' : type === 'image' ? '图片' : '语音'
}

function normalizeAuditRecords(values: unknown[]): WechatActionAuditRecord[] {
  return values
    .filter((value): value is WechatActionAuditRecord => {
      if (!value || typeof value !== 'object') return false
      const record = value as Partial<WechatActionAuditRecord>
      return Boolean(
        String(record.actionId || '').trim() &&
        String(record.recipientId || '').trim() &&
        String(record.contentType || '').trim() &&
        String(record.startedAt || '').trim() &&
        String(record.finishedAt || '').trim()
      )
    })
    .slice(0, MAX_AUDIT_RECORDS)
}

export const wechatActionGateway = new WechatActionGateway()

/** 兼容性名称，方便已有调用继续使用。 */
export const personalWechatActionService = wechatActionGateway
