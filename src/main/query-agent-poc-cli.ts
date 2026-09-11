/**
 * Query Agent CLI 的参数解析。
 *
 * 单独抽成纯函数便于单测，避免 entry 文件的副作用（app bootstrap / app.whenReady）影响测试。
 *
 * 两种模式：
 * 1. 自然语言：`"问题" [--scope '{...}']` → 走完整 Runtime（LLM tool loop）
 * 2. 裸工具诊断：`--tool <name> --args '{...json...}'` → 直接调 Local Query API，
 *    用于在没有 GUI 的情况下审计 engine 侧数据（group 解析、覆盖度、Evidence 计数）
 */
import type { QueryCorpusScope } from '../shared/local-query-api'

export function parsePocQuestion(argv: readonly string[]): string {
  const args = [...argv]
  // npm / pnpm 在复合 script（`build && electron ...`）里会把 `--` 一并追加到命令末尾，
  // 于是 separator 会落到 POC 的 argv 里，污染问题正文。
  // 只移除开头的这一个独立 separator；问题正文中间的合法 `--` 必须保留。
  if (args[0] === '--') args.shift()
  return args.join(' ').trim()
}

export type PocInvocation =
  | { kind: 'question'; question: string; scope?: QueryCorpusScope; pretty: boolean }
  | { kind: 'tool'; toolName: string; args: Record<string, unknown>; pretty: boolean }

export const POC_TOOL_NAMES = [
  'query_messages',
  'search_messages',
  'message_context',
  'conversation_overview'
] as const

/**
 * 解析 CLI 调用意图。任何参数错误都直接抛出，避免静默变成"提问"。
 */
export function parsePocInvocation(argv: readonly string[]): PocInvocation {
  const args = [...argv]
  if (args[0] === '--') args.shift()
  const pretty = args.includes('--pretty')
  const scopeIndex = args.indexOf('--scope')
  let scope: QueryCorpusScope | undefined
  if (scopeIndex >= 0) {
    const rawScope = args[scopeIndex + 1]
    if (!rawScope) throw new Error('缺少 --scope <json>')
    let parsedScope: unknown
    try {
      parsedScope = JSON.parse(rawScope)
    } catch {
      throw new Error('--scope 不是合法 JSON')
    }
    if (!parsedScope || typeof parsedScope !== 'object' || Array.isArray(parsedScope)) {
      throw new Error('--scope 必须是 JSON 对象')
    }
    const kind = (parsedScope as { kind?: unknown }).kind
    if (kind !== 'all' && kind !== 'groups' && kind !== 'contact' && kind !== 'current') {
      throw new Error('--scope.kind 必须是 all / groups / contact / current')
    }
    scope = parsedScope as QueryCorpusScope
    if ((kind === 'contact' || kind === 'current') && !(parsedScope as { conversationId?: unknown }).conversationId) {
      throw new Error('--scope.kind=contact|current 时必须给 conversationId')
    }
  }
  const toolIndex = args.indexOf('--tool')
  if (toolIndex < 0) {
    const question =
      scopeIndex < 0
        ? args.join(' ').trim()
        : args
            .filter((_, index) => index !== scopeIndex && index !== scopeIndex + 1)
            .join(' ')
            .trim()
    return { kind: 'question', question, ...(scope ? { scope } : {}), pretty }
  }

  const toolName = (args[toolIndex + 1] || '').trim()
  if (!POC_TOOL_NAMES.includes(toolName as (typeof POC_TOOL_NAMES)[number])) {
    throw new Error(`不支持的诊断工具: ${toolName || '(空)'}（可选：${POC_TOOL_NAMES.join(' / ')}）`)
  }
  const argsIndex = args.indexOf('--args')
  const rawArgs = argsIndex >= 0 ? args[argsIndex + 1] : undefined
  if (!rawArgs) throw new Error('缺少 --args <json>')
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArgs)
  } catch {
    throw new Error('--args 不是合法 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--args 必须是 JSON 对象')
  }
  return {
    kind: 'tool',
    toolName,
    args: { ...(parsed as Record<string, unknown>), ...(scope ? { scope } : {}) },
    pretty
  }
}
