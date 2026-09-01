import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AIProviderConfig } from '../../src/shared/ai-provider'

const root = mkdtempSync(join(tmpdir(), 'tracememo-ai-vision-routing-'))

vi.mock('electron', () => ({
  app: { getPath: () => root },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { AIProviderService } from '../../src/main/services/ai-provider-service'

const provider = (id: string, modelId: string, vision: boolean): AIProviderConfig => ({
  id,
  name: id === 'deepseek' ? 'DeepSeek' : 'OpenAI',
  type: 'openai-compatible',
  baseUrl: `https://${id}.example.test/v1`,
  auth: { type: 'none' },
  models: [
    {
      id: modelId,
      name: modelId,
      capabilities: { chat: true, vision, ocr: vision, longContext: true }
    }
  ],
  defaultModel: modelId,
  advanced: { timeoutMs: 120_000, extraHeaders: {} }
})

describe('AI provider vision routing', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('sends the disabled thinking control only when it is selected', async () => {
    const service = new AIProviderService()
    const configured = provider('thinking-provider', 'deepseek-v4-flash-vision-exp', false)
    configured.advanced.thinking = 'disabled'
    expect(service.save(configured).success).toBe(true)
    expect(service.setDefault(configured.id).success).toBe(true)

    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
          { headers: { 'content-type': 'application/json' } }
        )
      )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = await service.chat([{ role: 'user', content: 'hello' }])
      expect(result).toMatchObject({ success: true, data: 'ok', finishReason: 'stop' })
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>
      expect(body).toMatchObject({
        model: 'deepseek-v4-flash-vision-exp',
        thinking: { type: 'disabled' }
      })

      configured.advanced.thinking = 'default'
      expect(service.save(configured).success).toBe(true)
      await service.chat([{ role: 'user', content: 'hello' }])
      const defaultBody = JSON.parse(fetchMock.mock.calls[1][1].body as string) as Record<
        string,
        unknown
      >
      expect(defaultBody).not.toHaveProperty('thinking')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps DeepSeek as the text model while routing images to a verified vision model', () => {
    const service = new AIProviderService()
    expect(service.save(provider('deepseek', 'deepseek-chat', false)).success).toBe(true)
    expect(service.save(provider('sol-provider', 'gpt-5.6-sol', true)).success).toBe(true)
    expect(service.setDefault('deepseek').success).toBe(true)

    expect(service.getRuntimeConfig()).toMatchObject({
      providerId: 'deepseek',
      model: 'deepseek-chat'
    })
    expect(service.getVisionRuntimeConfig()).toMatchObject({
      providerId: 'sol-provider',
      model: 'gpt-5.6-sol',
      configured: true,
      source: 'vision-capability'
    })
  })

  it('reports unavailable when no configured model has vision capability', () => {
    const service = new AIProviderService()
    for (const item of service.list().providers) service.delete(item.id)
    expect(service.save(provider('deepseek', 'deepseek-chat', false)).success).toBe(true)

    expect(service.getVisionRuntimeConfig()).toMatchObject({
      configured: false,
      model: '',
      source: 'unavailable'
    })
  })
})
