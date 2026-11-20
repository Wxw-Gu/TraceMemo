import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { AIProviderConfig } from '../../src/shared/ai-provider'

const root = mkdtempSync(join(tmpdir(), 'tracememo-openai-parameters-'))

vi.mock('electron', () => ({
  app: { getPath: () => root },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { AIProviderService } from '../../src/main/services/ai-provider-service'

function provider(model: string, baseUrl = 'https://api.openai.com/v1'): AIProviderConfig {
  return {
    id: 'fixture-provider',
    name: 'Fixture Provider',
    type: 'openai-compatible',
    baseUrl,
    auth: { type: 'none' },
    models: [
      {
        id: model,
        name: model,
        capabilities: { chat: true, vision: true, ocr: true, longContext: true },
        maxTokens: 2048
      }
    ],
    defaultModel: model,
    advanced: { timeoutMs: 120_000, temperature: 0.7, maxTokens: 4096, extraHeaders: {} }
  }
}

function mockResponse(): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'OK', tool_calls: [] }, finish_reason: 'stop' }],
        output_text: 'OK',
        status: 'completed',
        content: [{ type: 'text', text: 'OK' }]
      }),
      { headers: { 'content-type': 'application/json' } }
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function requestBody(fetchMock: ReturnType<typeof mockResponse>): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
}

describe('OpenAI request parameter compatibility', () => {
  afterEach(() => vi.unstubAllGlobals())
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it.each(['gpt-5', 'gpt-5-mini', 'gpt-5.4', 'gpt-6.1-sol', 'o1', 'o3-mini', 'o4-mini'])(
    'omits temperature and uses max_completion_tokens for %s',
    async (model) => {
      const service = new AIProviderService()
      expect(service.save(provider(model)).success).toBe(true)
      const fetchMock = mockResponse()

      expect((await service.chat([{ role: 'user', content: 'hello' }])).success).toBe(true)
      expect(requestBody(fetchMock)).toMatchObject({ model, max_completion_tokens: 2048 })
      expect(requestBody(fetchMock)).not.toHaveProperty('max_tokens')
      expect(requestBody(fetchMock)).not.toHaveProperty('temperature')
    }
  )

  it.each(['chat-completions', 'responses'] as const)(
    'omits temperature in %s connection tests',
    async (apiProtocol) => {
      const service = new AIProviderService()
      const config = provider('gpt-6.1-sol')
      config.advanced.apiProtocol = apiProtocol
      expect(service.save(config).success).toBe(true)
      const fetchMock = mockResponse()

      expect((await service.test(config.id)).success).toBe(true)
      expect(requestBody(fetchMock)).not.toHaveProperty('temperature')
      expect(requestBody(fetchMock)).not.toHaveProperty('max_tokens')
      expect(requestBody(fetchMock)).toHaveProperty(
        apiProtocol === 'responses' ? 'max_output_tokens' : 'max_completion_tokens',
        apiProtocol === 'responses' ? 128 : 8
      )
    }
  )

  it.each([false, true])('keeps Responses token limits with stream=%s', async (stream) => {
    const service = new AIProviderService()
    const config = provider('gpt-6.1-sol', 'https://api.openai.com/v1/chat/completions')
    config.advanced = { ...config.advanced, apiProtocol: 'responses', stream }
    expect(service.save(config).success).toBe(true)
    const fetchMock = mockResponse()

    const result = await service.chat([{ role: 'user', content: 'hello' }])
    expect(result).toMatchObject({ success: true, data: 'OK' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses')
    expect(requestBody(fetchMock)).toMatchObject({ max_output_tokens: 2048, store: false })
    expect(requestBody(fetchMock)).not.toHaveProperty('temperature')
    expect(requestBody(fetchMock)).not.toHaveProperty('max_tokens')
    expect(requestBody(fetchMock)).not.toHaveProperty('max_completion_tokens')
  })

  it.each(['gpt-5', 'gpt-4.1'])(
    'uses modern token limits in the tool calling path for %s',
    async (model) => {
      const service = new AIProviderService()
      expect(service.save(provider(model)).success).toBe(true)
      const fetchMock = mockResponse()
      const tools = [
        {
          type: 'function' as const,
          function: { name: 'fixture_tool', description: 'fixture', parameters: { type: 'object' } }
        }
      ]

      expect(
        (await service.chatWithTools([{ role: 'user', content: 'hello' }], tools)).success
      ).toBe(true)
      expect(requestBody(fetchMock)).toMatchObject({ max_completion_tokens: 2048, tools })
      expect(requestBody(fetchMock)).not.toHaveProperty('max_tokens')
      if (model === 'gpt-5') expect(requestBody(fetchMock)).not.toHaveProperty('temperature')
      else expect(requestBody(fetchMock)).toHaveProperty('temperature', 0.7)
    }
  )

  it('preserves temperature for non-reasoning models on the official endpoint', async () => {
    const service = new AIProviderService()
    expect(service.save(provider('gpt-4.1')).success).toBe(true)
    const fetchMock = mockResponse()

    await service.chat([{ role: 'user', content: 'hello' }])
    expect(requestBody(fetchMock)).toMatchObject({ temperature: 0.7, max_completion_tokens: 2048 })
    expect(requestBody(fetchMock)).not.toHaveProperty('max_tokens')
  })

  it('uses the selected model rather than the provider default for compatibility', async () => {
    const service = new AIProviderService()
    const config = provider('gpt-4.1', 'https://relay.example.test/v1')
    config.models.push({ ...config.models[0], id: 'openai/gpt-6.1-sol', maxTokens: 1024 })
    expect(service.save(config).success).toBe(true)
    const fetchMock = mockResponse()

    await service.chat([{ role: 'user', content: 'hello' }], {
      providerId: config.id,
      modelId: 'openai/gpt-6.1-sol'
    })
    expect(requestBody(fetchMock)).toMatchObject({
      model: 'openai/gpt-6.1-sol',
      max_completion_tokens: 1024
    })
    expect(requestBody(fetchMock)).not.toHaveProperty('temperature')
    expect(requestBody(fetchMock)).not.toHaveProperty('max_tokens')
  })

  it.each(['chat', 'test', 'tools'] as const)(
    'preserves third-party Chat Completions parameters during %s',
    async (operation) => {
      const service = new AIProviderService()
      const config = provider('deepseek-chat', 'https://relay.example.test/v1')
      expect(service.save(config).success).toBe(true)
      const fetchMock = mockResponse()
      const messages = [{ role: 'user', content: 'hello' }]

      const result =
        operation === 'test'
          ? await service.test(config.id)
          : operation === 'tools'
            ? await service.chatWithTools(messages, [])
            : await service.chat(messages)
      expect(result.success).toBe(true)
      expect(requestBody(fetchMock)).toMatchObject({
        temperature: 0.7,
        max_tokens: operation === 'test' ? 8 : 2048
      })
      expect(requestBody(fetchMock)).not.toHaveProperty('max_completion_tokens')
    }
  )

  it('preserves Anthropic parameters even when the model alias resembles OpenAI', async () => {
    const service = new AIProviderService()
    const config = provider('gpt-6.1-sol', 'https://anthropic.example.test/v1')
    config.type = 'anthropic-messages'
    expect(service.save(config).success).toBe(true)
    const fetchMock = mockResponse()

    expect((await service.chat([{ role: 'user', content: 'hello' }])).success).toBe(true)
    expect(requestBody(fetchMock)).toMatchObject({ temperature: 0.7, max_tokens: 2048 })
    expect(requestBody(fetchMock)).not.toHaveProperty('max_completion_tokens')
  })
})
