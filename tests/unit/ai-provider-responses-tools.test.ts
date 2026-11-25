import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { AIProviderService } from '../../src/main/services/ai-provider-service'
import { QueryAgentService } from '../../src/main/services/query-agent-service'

const root = mkdtempSync(join(tmpdir(), 'tracememo-responses-tools-'))
vi.mock('electron', () => ({
  app: { getPath: () => root },
  safeStorage: { isEncryptionAvailable: () => true }
}))

function responsesProvider() {
  const provider = new AIProviderService()
  provider.save({
    id: 'fixture-provider',
    name: 'fixture-provider',
    type: 'openai-compatible',
    baseUrl: 'https://fixture.example/v1/responses',
    auth: { type: 'none' },
    models: [
      {
        id: 'fixture-model',
        name: 'fixture-model',
        capabilities: {
          chat: true,
          vision: true,
          ocr: true,
          longContext: true
        }
      }
    ],
    defaultModel: 'fixture-model',
    advanced: { apiProtocol: 'responses', stream: true, timeoutMs: 1000, extraHeaders: {} }
  })
  return provider
}

describe('Responses API query tools', () => {
  afterEach(() => vi.unstubAllGlobals())
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('round-trips stateless reasoning, parallel call IDs and bounded local tool outputs', async () => {
    const provider = responsesProvider()
    const argumentsJson = JSON.stringify({
      target: { query: 'fixture-group' },
      timeRange: { kind: 'all' },
      temporalBasis: { kind: 'none' },
      limit: 1
    })
    const output = [
      { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'fixture-ciphertext', summary: [] },
      ...['call_fixture_a', 'call_fixture_b'].map((call_id) => ({
        type: 'function_call',
        call_id,
        name: 'query_messages',
        arguments: argumentsJson
      }))
    ]
    const requests: RequestInit[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('https://fixture.example/v1/responses')
        requests.push(init)
        return Response.json({
          status: 'completed',
          output:
            requests.length === 1
              ? output
              : [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'fixture answer [E1]' }]
                  }
                ]
        })
      })
    )
    const executor = vi.fn(async () => ({
      status: 'completed',
      returnedCount: 1,
      messages: [{ messageRef: 'fixture-ref', text: 'fixture evidence' }]
    }))
    const result = await new QueryAgentService(provider, executor).run(
      '查看 fixture-group 中的第一条消息'
    )
    expect(result.answer).toBe('fixture answer [E1]')
    expect(executor).toHaveBeenCalledTimes(1) // After an exact match the host disables further calls.
    const [first, second] = requests.map((request) => JSON.parse(String(request.body)))
    expect(first).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
      tool_choice: 'auto',
      tools: expect.arrayContaining([
        expect.objectContaining({ type: 'function', name: 'query_messages', strict: false })
      ])
    })
    expect(first.tools[0]).not.toHaveProperty('function')
    expect(first.input[0].role).toBe('system')
    expect(second.input.slice(first.input.length, -2)).toEqual(output)
    expect(second.input.slice(-2)).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_fixture_a',
        output: expect.stringContaining('E1')
      },
      {
        type: 'function_call_output',
        call_id: 'call_fixture_b',
        output: expect.stringContaining('tool_availability')
      }
    ])
    expect(second.tools).toEqual([])
    expect(second.tool_choice).toBe('none')
    expect(JSON.stringify(result)).not.toContain('fixture-ciphertext')
  })

  it.each([
    { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] },
    {
      status: 'completed',
      output: [{ type: 'function_call', id: 'fc_fixture', name: 'query_messages', arguments: '{}' }]
    }
  ])('rejects unfinished output or a function call without its call_id', async (payload) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(payload))
    )
    const result = await responsesProvider().chatWithTools(
      [{ role: 'user', content: 'fixture' }],
      []
    )
    expect(result.success).toBe(false)
    expect(result.toolCalls).toBeUndefined()
  })

  it('keeps upstream diagnostics on a Responses failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: { message: 'fixture quota', code: 'insufficient_quota' } },
          { status: 429 }
        )
      )
    )
    const result = await responsesProvider().chatWithTools(
      [{ role: 'user', content: 'fixture' }],
      []
    )
    expect(result).toMatchObject({
      success: false,
      errorStatus: 429,
      errorCode: 'insufficient_quota'
    })
  })
})
