import type {
  WechatActionContent,
  WechatActionErrorCode,
  WechatActionOrigin,
  WechatActionPurpose,
  WechatActionRecipient,
  WechatActionStatus,
  WechatActionTriggerType
} from './wechat-action'

export interface ActionLogEntry {
  id: string
  category: 'wechat_send'
  source: WechatActionOrigin
  purpose: WechatActionPurpose
  triggerType?: WechatActionTriggerType
  timestamp: string
  recipientType: WechatActionRecipient['type']
  recipientId: string
  recipientName?: string
  contentType: WechatActionContent['type']
  contentPreview?: string
  status: WechatActionStatus
  errorCode?: WechatActionErrorCode
  reason?: string
  executionId?: string
  idempotencyKey?: string
}
