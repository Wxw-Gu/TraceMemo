import type {
  AiSearchExternalAuthorizationResult,
  AiSearchProviderStatus
} from '../../../../../shared/ai-provider'

export type AiSearchProviderConsentApi = {
  getAiSearchProviderStatus: () => Promise<AiSearchProviderStatus>
  authorizeAiSearchExternalProvider: (request: {
    requestId: string
    providerId: string
    recipient: string
  }) => Promise<AiSearchExternalAuthorizationResult>
}

export type RequestExternalProviderConsent = (
  providerName: string,
  recipient: string
) => Promise<boolean>

/**
 * Renderer adapter for the existing AI Search provider-consent IPC flow.
 * Provider identity and authorization policy remain owned by main/services.
 */
export async function ensureAiSearchDataConsent({
  requestId,
  api,
  requestExternalProviderConsent
}: {
  requestId: string
  api: AiSearchProviderConsentApi
  requestExternalProviderConsent: RequestExternalProviderConsent
}): Promise<boolean> {
  const status = await api.getAiSearchProviderStatus()
  if (!status.configured || !status.requiresConsent) return true
  if (!status.providerId || !status.recipient) throw new Error('当前 AI 服务信息不完整')

  const confirmed = await requestExternalProviderConsent(
    status.providerName || '当前 AI 服务',
    status.recipient
  )
  if (!confirmed) return false

  const authorized = await api.authorizeAiSearchExternalProvider({
    requestId,
    providerId: status.providerId,
    recipient: status.recipient
  })
  if (!authorized.success) throw new Error(authorized.error || '无法确认本次数据发送授权')
  return true
}
