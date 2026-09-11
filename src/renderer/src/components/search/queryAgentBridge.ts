import type {
  AskWechatConfig,
  AskWechatQueryRequest,
  AskWechatQueryResult
} from '../../../../shared/query-agent'

/**
 * Renderer → Query Agent 的最小桥。
 *
 * Renderer 不直接碰 Query Agent 语义，只做「开关 + 转发 + 展示」；
 * preload 契约缺失时（旧 preload / 测试环境）安全回退到 Legacy ——
 * 这属于**能力缺失**的兜底，不是「查 0 条就回退」那种语义回退。
 */
interface AskWechatBridge {
  getAskWechatConfig?: () => Promise<AskWechatConfig>
  runAskWechatQuery?: (request: AskWechatQueryRequest) => Promise<AskWechatQueryResult>
  forgetAskWechatConversation?: () => Promise<void>
}

const bridge = (): AskWechatBridge => window.api as unknown as AskWechatBridge

export async function resolveQueryAgentEnabled(): Promise<boolean> {
  try {
    const config = await bridge().getAskWechatConfig?.()
    return config?.queryAgentEnabled === true
  } catch {
    return false
  }
}

/** 桥不可用时返回 null，调用方据此走 Legacy。 */
export async function requestAskWechatQuery(
  request: AskWechatQueryRequest
): Promise<AskWechatQueryResult | null> {
  const run = bridge().runAskWechatQuery
  if (!run) return null
  return run(request)
}

/** 用户开始新问题时清掉澄清上下文（有界内存，不涉及持久化）。 */
export function forgetAskWechatConversation(): void {
  try {
    void bridge().forgetAskWechatConversation?.()
  } catch {
    // 清理失败不影响主流程
  }
}
