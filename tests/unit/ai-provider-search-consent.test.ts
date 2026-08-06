import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AIProviderConfig } from '../../src/shared/ai-provider'

const root = mkdtempSync(join(tmpdir(), 'wxe-ai-search-consent-'))

vi.mock('electron', () => ({
  app: { getPath: () => root },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { AIProviderService } from '../../src/main/services/ai-provider-service'

const provider = (baseUrl: string): AIProviderConfig => ({
  id: 'fixture-provider',
  name: 'Fixture Provider',
  type: 'custom' as const,
  baseUrl,
  auth: { type: 'none' as const },
  models: [
    {
      id: 'fixture-model',
      name: 'Fixture Model',
      capabilities: { chat: true, vision: false, ocr: false, longContext: false }
    }
  ],
  defaultModel: 'fixture-model',
  advanced: { timeoutMs: 1_000, extraHeaders: {} }
})

describe('AI Search provider identity', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('classifies local providers by their URL rather than provider type', () => {
    const service = new AIProviderService()
    expect(service.save(provider('https://first.example.test/v1')).success).toBe(true)
    expect(service.getAiSearchProviderStatus()).toMatchObject({
      requiresConsent: true,
      recipient: 'https://first.example.test/v1'
    })
    expect(service.save({ ...provider('https://remote.example.test'), type: 'ollama' }).success).toBe(
      true
    )
    expect(service.getAiSearchProviderStatus()).toMatchObject({ requiresConsent: true })
    expect(service.save(provider('http://localhost:11434/')).success).toBe(true)
    expect(service.getAiSearchProviderStatus()).toMatchObject({
      requiresConsent: false,
      recipient: 'http://localhost:11434'
    })
    expect(service.save(provider('http://[::1]:11434')).success).toBe(true)
    expect(service.getAiSearchProviderStatus()).toMatchObject({ requiresConsent: false })
    expect(service.save(provider('http://127.0.0.1:11434')).success).toBe(true)
    expect(service.getAiSearchProviderStatus()).toMatchObject({ requiresConsent: false })
  })

  it('normalizes a provider recipient without persisting any AI Search authorization', () => {
    const service = new AIProviderService()
    expect(service.save(provider('HTTPS://REMOTE.EXAMPLE.TEST:443/v1/')).success).toBe(true)
    expect(service.getAiSearchProviderStatus()).toMatchObject({
      requiresConsent: true,
      recipient: 'https://remote.example.test/v1'
    })
    expect(service.list().providers[0]).not.toHaveProperty('aiSearchDataConsent')
  })

  it('serializes only the caller-provided content to a mocked provider payload', async () => {
    const service = new AIProviderService()
    service.save(provider('https://payload.example.test/v1'))
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const sent = await service.chat([
      { role: 'system', content: 'system instruction' },
      { role: 'user', content: 'minimal evidence only' }
    ])
    expect(sent.success).toBe(true)

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: string }>
    }
    expect(request.messages.map((message) => message.content)).toEqual([
      'system instruction',
      'minimal evidence only'
    ])
    expect(JSON.stringify(request)).not.toContain('conversationId')
    expect(JSON.stringify(request)).not.toContain('messageId')
    vi.unstubAllGlobals()
  })
})
