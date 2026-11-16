import { app, safeStorage } from 'electron'
import path from 'node:path'
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

/**
 * 官方模板资源根目录。
 *
 * 打包后是 `<resources>/extension-templates`；开发态读构建产物目录。
 * 两者都不指向 `examples/extensions`——源码树不是运行时依赖。
 */
function resolveTemplateRoot(): string {
  const override = process.env.TRACEMEMO_EXTENSION_TEMPLATES_DIR
  if (override && override.trim()) return path.resolve(override.trim())
  if (app.isPackaged) return path.join(process.resourcesPath, 'extension-templates')
  return path.join(app.getAppPath(), 'build', 'extension-templates')
}

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
    aiStatus: () => {
      // 只读「是否已配置 + 模型显示名」，不返回 key 或 endpoint。
      const config = new AIProviderService().getRuntimeConfig()
      return { configured: config.configured, modelName: config.modelName }
    },
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
    templatesRoot: resolveTemplateRoot(),
    secretCipher: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain: string) => safeStorage.encryptString(plain),
      decrypt: (payload: Buffer) => safeStorage.decryptString(payload)
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
