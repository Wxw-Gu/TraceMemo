import type { QueryAgentPocResult } from './services/query-agent-poc-service'

const WIDTH = 24

function row(label: string, value: string): string {
  return `${label.padEnd(14)}${value.padStart(10)}`
}

/**
 * 人类可读的耗时摘要。
 *
 * 只做展示，不改变 JSON 输出契约。需要能正确处理：
 * - 0 次模型调用（配置缺失等提前返回）
 * - 1 次模型调用 + 0 次工具
 * - 2 次模型调用 + N 次工具（此时可准确还原"模型 → 工具 → 模型"顺序）
 * - 3 次以上（无法逐段归属工具耗时时，明确标注为聚合）
 * - 首次模型调用失败 / 末尾模型调用失败
 */
export function formatTiming(result: QueryAgentPocResult): string {
  const durations = result.modelDurationsMs || []
  const toolTotalMs = result.toolTotalMs || 0
  const toolCount = result.toolCallCount || 0
  const lines: string[] = ['', '[Timing]']

  if (durations.length === 0) {
    lines.push('（未发生模型调用）')
  } else if (durations.length <= 2) {
    lines.push(row('Model #1', `${durations[0]} ms`))
    if (toolCount > 0) lines.push(row(`TM Tools(${toolCount})`, `${toolTotalMs} ms`))
    if (durations[1] !== undefined) lines.push(row('Model #2', `${durations[1]} ms`))
  } else {
    durations.forEach((duration, index) => lines.push(row(`Model #${index + 1}`, `${duration} ms`)))
    lines.push(row(`TM Tools(${toolCount})`, `${toolTotalMs} ms`))
    lines.push('（3 次以上模型调用：工具耗时按总计展示）')
  }

  const modelTotalMs = durations.reduce((sum, value) => sum + value, 0)
  const totalMs = result.totalMs || 0
  const share = (value: number): string =>
    totalMs > 0 ? `${((value / totalMs) * 100).toFixed(1)}%` : 'n/a'

  lines.push('-'.repeat(WIDTH))
  lines.push(row('Total', `${totalMs} ms`))
  lines.push('')
  lines.push(row('Model total', `${modelTotalMs} ms (${share(modelTotalMs)})`))
  lines.push(row('TM tool total', `${toolTotalMs} ms (${share(toolTotalMs)})`))
  if (result.error) lines.push(`error: ${result.error}`)
  return `${lines.join('\n')}\n`
}

/**
 * 请求级诊断。
 * 只输出 host 与状态字段；绝不输出 API key / Authorization / 完整 URL / 响应正文。
 */
export function formatProviderDiagnostics(result: QueryAgentPocResult, host?: string): string {
  const lines = [
    '',
    '[Provider]',
    `provider       ${result.provider}`,
    `model          ${result.model}`,
    `host           ${host || '(unknown)'}`,
    `model calls    ${result.modelCallCount}`,
    `tool calls     ${result.toolCallCount}`
  ]
  for (const entry of result.modelDiagnostics || []) {
    const parts = [`elapsedMs=${entry.elapsedMs}`]
    if (entry.status !== undefined) parts.push(`status=${entry.status}`)
    if (entry.contentType) parts.push(`contentType=${entry.contentType}`)
    if (entry.timedOut) parts.push('timedOut=true')
    if (entry.htmlInsteadOfJson) parts.push('htmlInsteadOfJson=true')
    if (entry.errorCode) parts.push(`code=${entry.errorCode}`)
    if (entry.errorType) parts.push(`type=${entry.errorType}`)
    if (entry.status !== undefined && [502, 503, 504].includes(entry.status)) parts.push('upstreamGateway=true')
    lines.push(`attempt #${entry.index}    ${parts.join(' ')}`)
    if (entry.error) lines.push(`              error: ${entry.error}`)
  }
  return `${lines.join('\n')}\n`
}
