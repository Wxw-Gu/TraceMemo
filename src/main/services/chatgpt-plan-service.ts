import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import type { ChatGPTClient, ResponseInputMessage } from '@siwc/local'
import {
  CHATGPT_PLAN_PROVIDER_PREFIX,
  CHATGPT_PLAN_USAGE_URL,
  type ChatGPTPlanStatus
} from '../../shared/chatgpt-plan'
import type { ReportModelChoice } from '../../shared/ai-provider'

let runtime: Promise<ChatGPTClient> | undefined

function getClient(): Promise<ChatGPTClient> {
  runtime ??= import('@siwc/local').then(({ createChatGPT }) =>
    createChatGPT({
      appName: 'TraceMemo',
      appId: 'tracememo',
      storageDir: join(app.getPath('userData'), 'chatgpt-plan'),
      redirectPort: 0,
      sendHostId: true,
      openBrowser: (url) => shell.openExternal(url),
      credentialEncryption: {
        id: 'electron-safe-storage',
        isAvailable: async () =>
          app.isReady() &&
          (process.platform === 'darwin'
            ? await safeStorage.isAsyncEncryptionAvailable()
            : safeStorage.isEncryptionAvailable() &&
              (process.platform !== 'linux' ||
                safeStorage.getSelectedStorageBackend() !== 'basic_text')),
        encrypt: (value) =>
          process.platform === 'darwin'
            ? safeStorage.encryptStringAsync(value)
            : safeStorage.encryptString(value),
        decrypt: async (value) => {
          const ciphertext = Buffer.from(value)
          if (process.platform !== 'darwin') return safeStorage.decryptString(ciphertext)
          return (await safeStorage.decryptStringAsync(ciphertext)).result
        }
      }
    })
  )
  return runtime
}

function messageFor(error: unknown): string {
  return error instanceof Error && error.name === 'ChatGPTError'
    ? error.message
    : 'ChatGPT 连接操作失败，请检查网络和系统凭据存储。'
}

async function status(error?: string): Promise<ChatGPTPlanStatus> {
  try {
    const client = await getClient()
    const session = await client.getSession()
    const profiles = await client.listProfiles()
    return {
      profileId: session.profileId,
      sharing: session.sharing,
      error: error || session.error?.message,
      profiles: profiles.map(({ id, label, identity, status, sharing, pending }) => ({
        id,
        label,
        email: identity?.email,
        status,
        sharing,
        pending
      }))
    }
  } catch (failure) {
    return { sharing: false, profiles: [], error: error || messageFor(failure) }
  }
}

async function changeConnection(operation: () => Promise<unknown>): Promise<ChatGPTPlanStatus> {
  try {
    await operation()
    return status()
  } catch (error) {
    return status(messageFor(error))
  }
}

async function reportModels(): Promise<ReportModelChoice[]> {
  const client = await getClient()
  const session = await client.getSession()
  if (!session.sharing || !session.profileId) return []
  const models = await client.listModels({ signal: AbortSignal.timeout(10_000) })
  const current = await client.getSession()
  if (!current.sharing || current.profileId !== session.profileId) return []
  return models.map(({ slug, displayName }) => ({
    providerId: CHATGPT_PLAN_PROVIDER_PREFIX + session.profileId,
    providerName: 'ChatGPT 订阅',
    model: slug,
    modelName: displayName,
    configured: true,
    status: 'untested'
  }))
}

export function registerChatGPTPlanHandlers(): void {
  ipcMain.handle('chatgpt-plan:status', () => status())
  ipcMain.handle('chatgpt-plan:sign-in', (_, profileId?: string, reconsent?: boolean) =>
    changeConnection(async () =>
      (await getClient()).signIn(
        profileId ? { profileId, reconsent: reconsent === true } : { newProfile: true }
      )
    )
  )
  ipcMain.handle('chatgpt-plan:cancel', async () => (await getClient()).cancelSignIn())
  ipcMain.handle('chatgpt-plan:select', (_, profileId: string) =>
    changeConnection(async () => (await getClient()).selectProfile(profileId))
  )
  ipcMain.handle('chatgpt-plan:disconnect', () =>
    changeConnection(async () => (await getClient()).disconnect())
  )
  ipcMain.handle('chatgpt-plan:usage', () => shell.openExternal(CHATGPT_PLAN_USAGE_URL))
  ipcMain.handle('chatgpt-plan:models', () => reportModels())
  ipcMain.handle('chatgpt-plan:test', async (_, providerId: string, model: string) =>
    requestChatGPTPlan(
      providerId,
      model,
      [{ role: 'user', content: 'Reply with exactly OK.' }],
      60_000
    )
  )
}

export async function confirmChatGPTReport(window: BrowserWindow): Promise<boolean> {
  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    title: '使用 ChatGPT 订阅生成日报',
    message: '将此日报的输入发送给 OpenAI？',
    detail:
      '输入可能包含所选微信群聊的消息、转录文字和成员名称。本次请求会使用当前连接的 ChatGPT 订阅额度。',
    buttons: ['取消', '发送并生成'],
    defaultId: 0,
    cancelId: 0
  })
  return response === 1
}

export async function requestChatGPTPlan(
  providerId: string,
  model: string,
  messages: { role: string; content: string }[],
  timeoutMs = 180_000
): Promise<{ success: boolean; data?: string; finishReason?: string; error?: string }> {
  try {
    const client = await getClient()
    const session = await client.getSession()
    if (!session.sharing || providerId !== CHATGPT_PLAN_PROVIDER_PREFIX + session.profileId) {
      return { success: false, error: 'ChatGPT 订阅连接已变更，请重新选择模型。' }
    }

    const input = messages.map(({ role, content }): ResponseInputMessage => {
      if (role === 'system') return { role: 'developer', content }
      if (role === 'user' || role === 'assistant' || role === 'developer') return { role, content }
      throw new Error('Unsupported message role')
    })
    const signal = AbortSignal.timeout(
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 180_000) : 180_000
    )
    const { text } = await client.streamResponse({ model, input, signal })
    return { success: true, data: text, finishReason: 'stop' }
  } catch (error) {
    return { success: false, error: messageFor(error) }
  }
}
