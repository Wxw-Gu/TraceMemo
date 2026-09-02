import { describe, expect, it, vi } from 'vitest'
import { ensureAiSearchDataConsent } from '../../src/renderer/src/components/search/services/aiSearchProviderConsent'

const makeApi = (): {
  getAiSearchProviderStatus: ReturnType<typeof vi.fn>
  authorizeAiSearchExternalProvider: ReturnType<typeof vi.fn>
} => ({
  getAiSearchProviderStatus: vi.fn(),
  authorizeAiSearchExternalProvider: vi.fn()
})

describe('ensureAiSearchDataConsent', () => {
  it('bypasses consent when the configured provider does not require it', async () => {
    const api = makeApi()
    api.getAiSearchProviderStatus.mockResolvedValue({ configured: true, requiresConsent: false })
    const requestConsent = vi.fn()

    await expect(
      ensureAiSearchDataConsent({
        requestId: 'req-1',
        api,
        requestExternalProviderConsent: requestConsent
      })
    ).resolves.toBe(true)
    expect(requestConsent).not.toHaveBeenCalled()
    expect(api.authorizeAiSearchExternalProvider).not.toHaveBeenCalled()
  })

  it('preserves provider fields through consent and authorization', async () => {
    const api = makeApi()
    api.getAiSearchProviderStatus.mockResolvedValue({
      configured: true,
      requiresConsent: true,
      providerId: 'provider-1',
      providerName: 'Remote Provider',
      recipient: 'remote@example.test'
    })
    api.authorizeAiSearchExternalProvider.mockResolvedValue({ success: true })
    const requestConsent = vi.fn().mockResolvedValue(true)

    await expect(
      ensureAiSearchDataConsent({
        requestId: 'req-1',
        api,
        requestExternalProviderConsent: requestConsent
      })
    ).resolves.toBe(true)
    expect(requestConsent).toHaveBeenCalledWith('Remote Provider', 'remote@example.test')
    expect(api.authorizeAiSearchExternalProvider).toHaveBeenCalledWith({
      requestId: 'req-1',
      providerId: 'provider-1',
      recipient: 'remote@example.test'
    })
  })

  it('does not authorize when the user rejects consent', async () => {
    const api = makeApi()
    api.getAiSearchProviderStatus.mockResolvedValue({
      configured: true,
      requiresConsent: true,
      providerId: 'provider-1',
      recipient: 'remote@example.test'
    })
    const requestConsent = vi.fn().mockResolvedValue(false)

    await expect(
      ensureAiSearchDataConsent({
        requestId: 'req-1',
        api,
        requestExternalProviderConsent: requestConsent
      })
    ).resolves.toBe(false)
    expect(api.authorizeAiSearchExternalProvider).not.toHaveBeenCalled()
  })

  it('preserves incomplete-status and authorization errors', async () => {
    const api = makeApi()
    api.getAiSearchProviderStatus.mockResolvedValue({ configured: true, requiresConsent: true })
    await expect(
      ensureAiSearchDataConsent({
        requestId: 'req-1',
        api,
        requestExternalProviderConsent: vi.fn()
      })
    ).rejects.toThrow('当前 AI 服务信息不完整')

    api.getAiSearchProviderStatus.mockResolvedValue({
      configured: true,
      requiresConsent: true,
      providerId: 'provider-1',
      recipient: 'remote@example.test'
    })
    api.authorizeAiSearchExternalProvider.mockResolvedValue({ success: false, error: '授权失败' })
    await expect(
      ensureAiSearchDataConsent({
        requestId: 'req-1',
        api,
        requestExternalProviderConsent: vi.fn().mockResolvedValue(true)
      })
    ).rejects.toThrow('授权失败')
  })
})
