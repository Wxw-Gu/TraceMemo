import { describe, expect, it } from 'vitest'
import { formatProviderDiagnostics, formatTiming } from '../../src/main/query-agent-poc-report'
import type { QueryAgentResult } from '../../src/main/services/query-agent-service'

function result(patch: Partial<QueryAgentResult> = {}): QueryAgentResult {
  return {
    question: 'q',
    provider: 'Fixture Provider',
    model: 'fixture-model',
    modelCallCount: 0,
    toolCallCount: 0,
    toolTotalMs: 0,
    totalMs: 0,
    traces: [],
    modelDurationsMs: [],
    modelDiagnostics: [],
    ...patch
  }
}

describe('formatTiming', () => {
  it('处理 0 次模型调用', () => {
    const text = formatTiming(result({ error: '当前 AI Provider 尚未配置', totalMs: 3 }))
    expect(text).toContain('（未发生模型调用）')
    expect(text).toContain('Total')
    expect(text).toContain('error: 当前 AI Provider 尚未配置')
  })

  it('处理 1 次模型调用 + 0 次工具', () => {
    const text = formatTiming(result({ modelCallCount: 1, modelDurationsMs: [1234], totalMs: 1234 }))
    expect(text).toContain('Model #1')
    expect(text).toContain('1234 ms')
    expect(text).not.toContain('TM Tools')
    expect(text).toContain('Model total')
    expect(text).toContain('100.0%')
  })

  it('处理 2 次模型调用 + 1 次工具，并还原交错顺序', () => {
    const text = formatTiming(
      result({ modelCallCount: 2, toolCallCount: 1, modelDurationsMs: [18784, 19690], toolTotalMs: 551, totalMs: 39025 })
    )
    const model1 = text.indexOf('Model #1')
    const tools = text.indexOf('TM Tools')
    const model2 = text.indexOf('Model #2')
    expect(model1).toBeGreaterThanOrEqual(0)
    expect(tools).toBeGreaterThan(model1)
    expect(model2).toBeGreaterThan(tools)
    expect(text).toContain('38474 ms (98.6%)')
    expect(text).toContain('551 ms (1.4%)')
  })

  it('处理首次模型调用失败', () => {
    const text = formatTiming(
      result({ modelCallCount: 1, modelDurationsMs: [99419], totalMs: 99419, error: '模型服务返回了网页而不是 JSON（HTTP 502 Bad Gateway）' })
    )
    expect(text).toContain('Model #1')
    expect(text).toContain('99419 ms')
    expect(text).toContain('502')
  })

  it('处理末尾模型调用失败（有首次耗时、无 finalModelMs）', () => {
    const text = formatTiming(
      result({ modelCallCount: 2, toolCallCount: 1, modelDurationsMs: [800, 1200], toolTotalMs: 300, totalMs: 2300, error: 'AI 请求超时' })
    )
    expect(text).toContain('Model #2')
    expect(text).toContain('error: AI 请求超时')
  })

  it('3 次以上模型调用标注为聚合展示', () => {
    const text = formatTiming(result({ modelCallCount: 3, toolCallCount: 2, modelDurationsMs: [10, 20, 30], toolTotalMs: 5, totalMs: 65 }))
    expect(text).toContain('Model #3')
    expect(text).toContain('工具耗时按总计展示')
  })

  it('totalMs 为 0 时不产生 NaN 百分比', () => {
    const text = formatTiming(result({ modelCallCount: 1, modelDurationsMs: [5], totalMs: 0 }))
    expect(text).not.toContain('NaN')
    expect(text).toContain('n/a')
  })
})

describe('formatProviderDiagnostics', () => {
  it('输出 provider / model / host 与每次尝试的请求级诊断', () => {
    const text = formatProviderDiagnostics(
      result({
        provider: 'OpenAI',
        model: 'gpt-5.6-sol',
        modelCallCount: 1,
        modelDiagnostics: [{ index: 1, elapsedMs: 99419, status: 502, contentType: 'text/html', htmlInsteadOfJson: true, error: '模型服务返回了网页而不是 JSON（HTTP 502 Bad Gateway）' }]
      }),
      'relay.example.test'
    )
    expect(text).toContain('provider       OpenAI')
    expect(text).toContain('model          gpt-5.6-sol')
    expect(text).toContain('host           relay.example.test')
    expect(text).toContain('status=502')
    expect(text).toContain('contentType=text/html')
    expect(text).toContain('htmlInsteadOfJson=true')
    expect(text).toContain('upstreamGateway=true')
    expect(text).toContain('elapsedMs=99419')
  })

  it('标记超时', () => {
    const text = formatProviderDiagnostics(
      result({ modelCallCount: 1, modelDiagnostics: [{ index: 1, elapsedMs: 240000, timedOut: true, error: 'AI 请求超时' }] })
    )
    expect(text).toContain('timedOut=true')
    expect(text).toContain('(unknown)')
  })

  it('不泄漏凭据：输出中不出现 token / Authorization', () => {
    const text = formatProviderDiagnostics(
      result({ modelDiagnostics: [{ index: 1, elapsedMs: 1, status: 200, contentType: 'application/json' }] }),
      'relay.example.test'
    )
    expect(text).not.toMatch(/authorization/i)
    expect(text).not.toMatch(/bearer/i)
    expect(text).not.toMatch(/sk-/)
  })
})
