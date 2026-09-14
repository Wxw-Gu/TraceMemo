import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { AIProviderConfig } from '../../src/shared/ai-provider'

const root = mkdtempSync(join(tmpdir(), 'tracememo-opencode-session-'))
vi.mock('electron', () => ({
  app: { getPath: () => root },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))
import { AIProviderService } from '../../src/main/services/ai-provider-service'

const messages = [{ role: 'user', content: 'hello' }]
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
function setup(overrides: Partial<AIProviderConfig> = {}): {
  service: AIProviderService
  fetchMock: ReturnType<typeof vi.fn>
} {
  const service = new AIProviderService()
  const provider: AIProviderConfig = {
    id: 'custom-name',
    name: 'My model',
    type: 'openai-compatible',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    auth: { type: 'bearer' },
    apiKey: 'test-key',
    models: [
      {
        id: 'test-model',
        name: 'Test',
        capabilities: { chat: true, vision: true, ocr: true, longContext: true }
      }
    ],
    defaultModel: 'test-model',
    advanced: { timeoutMs: 1000, extraHeaders: { 'x-custom': 'kept' } },
    ...overrides
  }
  expect(service.save(provider).success).toBe(true)
  service.setDefault(provider.id)
  const fetchMock = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          output_text: 'ok',
          status: 'completed',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn'
        }),
        { headers: { 'content-type': 'application/json' } }
      )
  )
  vi.stubGlobal('fetch', fetchMock)
  return { service, fetchMock }
}
function headers(fetchMock: ReturnType<typeof vi.fn>, index = 0): Headers {
  return new Headers(fetchMock.mock.calls[index][1].headers)
}
afterEach(() => vi.unstubAllGlobals())
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('OpenCode Go session headers', () => {
  it('keeps a task ID across concurrent calls and retries without sharing it with another task', async () => {
    const { service, fetchMock } = setup()
    await Promise.all(
      ['task-a', 'task-b', 'task-a'].map((sessionId) => service.chat(messages, { sessionId }))
    )
    expect([0, 1, 2].map((i) => headers(fetchMock, i).get('x-opencode-session'))).toEqual([
      'task-a',
      'task-b',
      'task-a'
    ])
    expect(headers(fetchMock).get('authorization')).toBe('Bearer test-key')
    expect(headers(fetchMock).get('x-custom')).toBe('kept')
    expect(headers(fetchMock).get('user-agent')).toBe('TraceMemo')
    expect(
      service.list().providers.find((p) => p.id === 'custom-name')?.advanced.extraHeaders
    ).toEqual({ 'x-custom': 'kept' })
  })

  it.each(['chat-completions', 'responses', 'anthropic'] as const)(
    'covers %s inference and connection tests',
    async (protocol) => {
      const { service, fetchMock } = setup({
        type: protocol === 'anthropic' ? 'anthropic-messages' : 'openai-compatible',
        advanced: {
          timeoutMs: 1000,
          extraHeaders: {},
          apiProtocol: protocol === 'responses' ? 'responses' : 'chat-completions'
        }
      })
      expect(await service.chat(messages)).toMatchObject({ success: true, data: 'ok' })
      expect(await service.test('custom-name')).toMatchObject({ success: true })
      expect(headers(fetchMock).get('x-opencode-session')).toMatch(uuid)
      expect(headers(fetchMock, 1).get('x-opencode-session')).toMatch(uuid)
      expect(headers(fetchMock, 1).get('x-opencode-session')).not.toBe(
        headers(fetchMock).get('x-opencode-session')
      )
    }
  )

  it('covers image analysis and legacy caller options', async () => {
    const { service, fetchMock } = setup()
    expect(
      await service.analyzeImage(
        [
          {
            role: 'user',
            content: [{ type: 'image', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }]
          }
        ],
        { sessionId: 'image-task' }
      )
    ).toMatchObject({
      success: true
    })
    expect(
      await service.chat(messages, {
        apiKey: 'legacy-key',
        baseURL: 'https://opencode.ai/zen/go/v1',
        model: 'test-model',
        sessionId: 'legacy-task'
      })
    ).toMatchObject({ success: true })
    expect(headers(fetchMock).get('x-opencode-session')).toBe('image-task')
    expect(headers(fetchMock, 1).get('x-opencode-session')).toBe('legacy-task')
  })

  it('replaces stale static session headers case insensitively and preserves a custom user agent', async () => {
    const { service, fetchMock } = setup({
      advanced: {
        timeoutMs: 1000,
        extraHeaders: { 'X-OpenCode-Session': 'static', 'User-Agent': 'CustomTraceMemo' }
      }
    })
    await service.chat(messages, { sessionId: 'new-task' })
    expect(headers(fetchMock).get('x-opencode-session')).toBe('new-task')
    expect(headers(fetchMock).get('user-agent')).toBe('CustomTraceMemo')
  })

  it.each([
    'https://api.openai.com/v1',
    'https://opencode.ai/zen/v1',
    'https://opencode.ai.example.com/zen/go/v1',
    'https://opencode.ai/zen/gopher'
  ])('does not inject Go headers for %s', async (baseUrl) => {
    const { service, fetchMock } = setup({ baseUrl })
    await service.chat(messages, { sessionId: 'private-task' })
    expect(headers(fetchMock).has('x-opencode-session')).toBe(false)
    expect(headers(fetchMock).has('user-agent')).toBe(false)
  })
})
