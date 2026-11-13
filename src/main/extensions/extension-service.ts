import { AIProviderService } from '../services/ai-provider-service'
import {
  getChatDb,
  getSelfAccountInfo,
  isReady,
  listContacts,
  listMessagesAsync,
  resolveMd5
} from '../services/chat-service'
import { personalWechatCapabilityService } from '../services/personal-wechat-capability-service'
import { wechatActionGateway } from '../services/wechat-action-gateway'
import { ExtensionError } from '../../shared/extensions/errors'
import type {
  ExtensionMessagesQueryRequest,
  ExtensionQueriedMessage
} from '../../shared/extensions/rpc'
import { checkExtensionSendEntitlement } from './extension-entitlement'
import { ExtensionManager } from './extension-manager'
import { getExtensionPaths } from './extension-paths'

let manager: ExtensionManager | null = null

export interface ExtensionSystemOptions {
  appVersion: string
  onChange: (extensionId: string, reason: string) => void
}

/**
 * 扩展系统的主进程接线。
 *
 * 这里只做依赖注入：所有能力都来自既有服务，扩展系统自己不实现第二套
 * 消息监听、发送通道或 AI Provider。
 */
export async function initExtensionSystem(options: ExtensionSystemOptions): Promise<void> {
  if (manager) return
  manager = new ExtensionManager({
    paths: getExtensionPaths(),
    appVersion: options.appVersion,
    getCapability: () => personalWechatCapabilityService.getPersonalWechatSendCapability(),
    checkEntitlement: () => checkExtensionSendEntitlement(),
    executeAction: (request) => wechatActionGateway.execute(request),
    queryMessages: queryConversationMessages,
    listGroups: async () => {
      try {
        return listContacts()
          .filter((contact) => contact.type === 'group')
          .map((contact) => ({
            id: contact.m_nsUsrName,
            name: contact.m_nsNickName || contact.m_nsUsrName
          }))
      } catch {
        return []
      }
    },
    aiChat: chatWithConfiguredProvider,
    getAccountId: () => String(getSelfAccountInfo()?.wxid || ''),
    getSelfUsernames: () => {
      try {
        return (getChatDb()?.getWcdb4Client()?.getMyUsernameCandidates?.() ?? []).filter(Boolean)
      } catch {
        return []
      }
    },
    isDatabaseReady: () => {
      try {
        return isReady()
      } catch {
        return false
      }
    },
    onChange: (extensionId, reason) => options.onChange(extensionId, reason)
  })
  await manager.initialize()
}

export function getExtensionManager(): ExtensionManager {
  if (!manager) throw new Error('扩展系统尚未初始化')
  return manager
}

export function hasExtensionManager(): boolean {
  return manager !== null
}

export async function disposeExtensionSystem(): Promise<void> {
  const current = manager
  manager = null
  if (current) await current.dispose()
}

async function queryConversationMessages(
  request: ExtensionMessagesQueryRequest
): Promise<ExtensionQueriedMessage[]> {
  const contact = resolveMd5(request.conversationId)
  if (!contact?.md5) throw new ExtensionError('DATABASE_NOT_READY', '找不到该会话或数据库未连接')
  const messages = await listMessagesAsync(
    contact.md5,
    Math.floor((request.startTime ?? Date.now() - 86_400_000) / 1000),
    Math.floor((request.endTime ?? Date.now()) / 1000),
    { limit: request.limit ?? 50 },
    '',
    'unknown'
  )
  return messages.map((message) => ({
    messageId: message.serverId || String(message.localId ?? message.id),
    conversationId: request.conversationId,
    ...(message.senderId ? { senderId: message.senderId } : {}),
    ...(message.name ? { senderName: message.name } : {}),
    isSelf: message.isSender === true,
    type: message.type,
    ...(message.type === 'text' ? { text: message.content } : {}),
    timestamp: Math.round((message.createTime ?? 0) * 1000)
  }))
}

async function chatWithConfiguredProvider(
  messages: Array<{ role: string; content: string }>
): Promise<{ text: string }> {
  const result = await new AIProviderService().chat(messages)
  if (!result.success) {
    throw new ExtensionError('CAPABILITY_UNAVAILABLE', result.error || 'AI 调用失败')
  }
  return { text: result.data || '' }
}

export function extensionManagerForTests(value: ExtensionManager | null): void {
  manager = value
}
