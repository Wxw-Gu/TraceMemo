import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AIProviderConfig } from '../../src/shared/ai-provider'

const root = mkdtempSync(join(tmpdir(), 'wxe-ai-provider-diagnostics-'))

vi.mock('electron', () => ({
  app: { getPath: () => root },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { AIProviderService } from '../../src/main/services/ai-provider-service'

function provider(baseUrl: string, timeoutMs = 120_000): AIProviderConfig {
  return {
    id: 'fixture-provider',
    name: 'Fixture Provider',
    type: 'openai-compatible' as const,
    baseUrl,
    auth: { type: 'none' as const },
    models: [
      { id: 'fixture-model', name: 'Fixture Model', capabilities: { chat: true, vision: false, ocr: false, longContext: false } }
    ],
    defaultModel: 'fixture-model',
    advanced: { timeoutMs, extraHeaders: {} }
  }
}

const TOOLS = [{ type: 'function' as const, function: { name: 'query_messages', description: 'read', parameters: { type: 'object' } } }]

describe('AI Provider 请求级诊断', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('200 JSON：成功并带请求耗时，无错误诊断字段', async () => {
    const service = new AIProviderService()
    service.save(provider('https://diag.example.test/v1'))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok', tool_calls: [] } }], usage: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    ))
    try {
      const result = await service.chatWithTools([{ role: 'user', content: 'q' }], TOOLS)
      expect(result.success).toBe(true)
      expect(typeof result.elapsedMs).toBe('number')
      expect(result).not.toHaveProperty('errorStatus')
      expect(result).not.toHaveProperty('htmlInsteadOfJson')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('502 text/html：保留清晰错误，并记录 status / content-type / elapsed，且不泄漏 HTML 正文', async () => {
    const service = new AIProviderService()
    service.save(provider('https://diag.example.test/v1'))
    const html = '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>relay error</body></html>'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(html, { status: 502, statusText: 'Bad Gateway', headers: { 'content-type': 'text/html' } })
    ))
    try {
      const result = await service.chatWithTools([{ role: 'user', content: 'q' }], TOOLS)
      expect(result.success).toBe(false)
      expect(result.errorStatus).toBe(502)
      expect(result.errorContentType).toBe('text/html')
      expect(result.htmlInsteadOfJson).toBe(true)
      expect(typeof result.elapsedMs).toBe('number')
      expect(result.error).toContain('网页而不是 JSON')
      expect(result.error).toContain('502')
      // HTML 正文不得出现在错误信息里
      expect(result.error).not.toContain('relay error')
      expect(result.error).not.toContain('<html')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('502 application/json：使用上游 error.message，并保留状态码', async () => {
    const service = new AIProviderService()
    service.save(provider('https://diag.example.test/v1'))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'upstream overloaded', code: 'overloaded', type: 'server_error' } }), {
        status: 502,
        headers: { 'content-type': 'application/json' }
      })
    ))
    try {
      const result = await service.chatWithTools([{ role: 'user', content: 'q' }], TOOLS)
      expect(result.success).toBe(false)
      expect(result.error).toBe('upstream overloaded')
      expect(result.errorStatus).toBe(502)
      expect(result.errorCode).toBe('overloaded')
      expect(result.errorType).toBe('server_error')
      expect(result.htmlInsteadOfJson).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('200 但 body 不是 JSON：明确报格式异常并带状态码', async () => {
    const service = new AIProviderService()
    service.save(provider('https://diag.example.test/v1'))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('plain text body', { status: 200, headers: { 'content-type': 'text/plain' } })
    ))
    try {
      const result = await service.chatWithTools([{ role: 'user', content: 'q' }], TOOLS)
      expect(result.success).toBe(false)
      expect(result.error).toContain('格式异常')
      expect(result.htmlInsteadOfJson).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('超时：标记 timedOut 且错误为 AI 请求超时', async () => {
    const service = new AIProviderService()
    service.save(provider('https://diag.example.test/v1', 1))
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })))
    try {
      const result = await service.chatWithTools([{ role: 'user', content: 'q' }], TOOLS)
      expect(result.success).toBe(false)
      expect(result.timedOut).toBe(true)
      expect(result.error).toBe('AI 请求超时')
    } finally {
      vi.unstubAllGlobals()
    }
  }, 5_000)

  it('只输出 host 作为 endpoint 诊断，不泄漏路径与 query', () => {
    const service = new AIProviderService()
    service.save(provider('https://relay.example.test/v1?token=secret-value'))
    expect(service.getRuntimeEndpointHost()).toBe('relay.example.test')
  })
})
