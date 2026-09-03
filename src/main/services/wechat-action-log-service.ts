import type { ActionLogEntry } from '../../shared/action-log'
import type { Contact } from '../../shared/types'
import type { WechatActionAuditRecord } from '../../shared/wechat-action'
import * as chat from './chat-service'
import { wechatActionGateway } from './wechat-action-gateway'

export interface WechatActionLogServiceDependencies {
  listAuditRecords?: () => WechatActionAuditRecord[]
  listContacts?: () => Contact[]
}

export class WechatActionLogService {
  private readonly listAuditRecords: () => WechatActionAuditRecord[]
  private readonly listContacts: () => Contact[]

  constructor(deps: WechatActionLogServiceDependencies = {}) {
    this.listAuditRecords = deps.listAuditRecords || (() => wechatActionGateway.listAuditRecords())
    this.listContacts = deps.listContacts || (() => chat.listContacts())
  }

  list(): ActionLogEntry[] {
    let contacts: Contact[] = []
    try {
      contacts = this.listContacts()
    } catch {
      // 数据库未连接时仍可查看历史审计。
    }
    const names = new Map(
      contacts.map((contact) => [
        contact.m_nsUsrName,
        contact.m_nsNickName?.trim() || contact.remark?.trim() || contact.m_nsUsrName
      ])
    )

    return this.listAuditRecords()
      .map((record) => ({
        id: record.actionId,
        category: 'wechat_send' as const,
        source: record.origin,
        purpose: record.purpose,
        timestamp: record.finishedAt || record.startedAt || record.createdAt,
        recipientType: record.recipientType,
        recipientId: record.recipientId,
        recipientName: record.recipientName || names.get(record.recipientId),
        contentType: record.contentType,
        contentPreview: record.contentPreview,
        status: record.sendStatus,
        errorCode: record.errorCode,
        reason: record.decisionReason
      }))
      .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
  }
}

export const wechatActionLogService = new WechatActionLogService()
