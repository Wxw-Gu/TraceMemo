import { ExtensionError } from '../../shared/extensions/errors'
import { hasExtensionPermission } from '../../shared/extensions/permissions'
import type { ExtensionAutomationActionOutput } from '../../shared/extensions/rpc'
import type { ExtensionMessageEvent } from '../../shared/extensions/events'
import { getExtensionManager, hasExtensionManager } from './extension-service'

export interface ExtensionActionContext {
  conversationId: string
  isGroup: boolean
  accountId: string
  message?: ExtensionMessageEvent
}

/**
 * 自动化 → 扩展动作的桥。
 *
 * 输入里的 `conversationId` / `accountId` / `message` 是**宿主注入的运行时上下文**，
 * 与用户在规则里配置的静态 `input` 合并；同名键以宿主值为准，扩展不能靠配置
 * 伪造一个假的会话或账号。
 */
export async function invokeExtensionAction(
  extensionId: string,
  actionId: string,
  input: Record<string, unknown>,
  context: ExtensionActionContext
): Promise<ExtensionAutomationActionOutput> {
  if (!hasExtensionManager()) {
    throw new ExtensionError('EXTENSION_HOST_UNAVAILABLE', '扩展系统尚未初始化')
  }
  const runtimeInput: Record<string, unknown> = {
    ...input,
    conversationId: context.conversationId,
    isGroup: context.isGroup,
    accountId: context.accountId,
    ...(context.message ? { message: context.message } : {})
  }
  return getExtensionManager().invokeAutomationAction(extensionId, actionId, runtimeInput)
}

export function canExtensionSendText(extensionId: string): boolean {
  if (!hasExtensionManager()) return false
  const extension = getExtensionManager().get(extensionId)
  if (!extension?.enabled) return false
  return hasExtensionPermission(extension.grantedPermissions, 'wechat.send.text')
}
