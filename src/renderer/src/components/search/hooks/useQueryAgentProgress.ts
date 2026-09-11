import { useEffect, useRef, useState } from 'react'
import type {
  QueryAgentProgressEvent,
  QueryAgentProgressStage
} from '../../../../../shared/query-agent'

export interface QueryAgentProgressState {
  stage: QueryAgentProgressStage
  elapsedMs: number
  toolName?: string
  modelCallCount: number
  toolCallCount: number
}

/**
 * 「问问微信」的真实进度订阅。
 *
 * 设计约束：
 * - 只认自己那一次 requestId：用户连问两次时旧请求的进度不能串台；
 * - 事件是**真实生命周期边界**（understanding / searching / organizing_evidence /
 *   generating_answer / completed），没有百分比、没有定时器伪进度；
 * - 不缓存历史阶段：每次 `begin(requestId)` 重置，避免上一次的阶段残留成"假进度"。
 */
export function useQueryAgentProgress(): {
  progress: QueryAgentProgressState | null
  begin: (requestId: string) => void
  end: () => void
} {
  const [progress, setProgress] = useState<QueryAgentProgressState | null>(null)
  const activeRequestRef = useRef<string | null>(null)

  useEffect(() => {
    // 桥缺失（旧 preload / 测试替身 / 尚未升级的宿主）时必须**静默降级**：
    // 进度只是增强信息，缺了它查询本身完全不受影响 —— 但抛异常会把整个工作区打挂。
    const subscribe = window.api?.onAskWechatProgress
    if (typeof subscribe !== 'function') return
    const unsubscribe = subscribe(
      (requestId: string, event: QueryAgentProgressEvent) => {
        if (activeRequestRef.current !== requestId) return
        setProgress({
          stage: event.stage,
          elapsedMs: event.elapsedMs,
          ...(event.toolName ? { toolName: event.toolName } : {}),
          modelCallCount: event.modelCallCount,
          toolCallCount: event.toolCallCount
        })
      }
    )
    return unsubscribe
  }, [])

  return {
    progress,
    begin: (requestId: string) => {
      activeRequestRef.current = requestId
      setProgress(null)
    },
    end: () => {
      activeRequestRef.current = null
      setProgress(null)
    }
  }
}

/** 进度阶段 → 用户可读文案。内部工具名绝不外泄（不出现 toolName / SQL / FTS / 内部 id）。 */
export function queryAgentProgressLabel(
  progress: QueryAgentProgressState | null,
  /**
   * 本次语料范围是不是"跨会话的大范围"（所有聊天记录 / 全部群聊）。
   *
   * 用它决定 Tool 阶段的副提示，而不是用工具调用次数猜：范围是 UI 自己定的边界，
   * 是**事实**；调用次数只是间接信号，容易把"重试一次"误报成"范围很大"。
   */
  wideScope: boolean
): string {
  if (!progress) return '正在准备查询'
  switch (progress.stage) {
    case 'understanding':
      return progress.modelCallCount <= 1 ? '正在理解你的问题' : '正在重新理解你的问题'
    case 'searching':
      // 跨会话检索明显比单会话慢一个量级，提前把预期说清楚，避免用户以为卡住了。
      return wideScope ? '正在搜索较大范围的聊天记录…' : '正在搜索聊天记录…'
    case 'organizing_evidence':
      return '正在整理找到的聊天记录'
    case 'generating_answer':
      return '正在生成回答'
    case 'completed':
      return '已完成'
  }
}

/** 真实阶段顺序（与 Runtime 的生命周期一一对应），用于渲染进度列表。 */
export const QUERY_AGENT_PROGRESS_STEPS: ReadonlyArray<{
  stage: QueryAgentProgressStage
  label: string
}> = [
  { stage: 'understanding', label: '理解问题' },
  { stage: 'searching', label: '查找相关聊天' },
  { stage: 'organizing_evidence', label: '整理证据' },
  { stage: 'generating_answer', label: '生成回答' }
]

/** 当前处于第几步（0-based）；`completed` 视为全部完成。 */
export function queryAgentProgressStepIndex(
  progress: QueryAgentProgressState | null
): number {
  if (!progress || progress.stage === 'completed') return progress ? QUERY_AGENT_PROGRESS_STEPS.length : 0
  const index = QUERY_AGENT_PROGRESS_STEPS.findIndex((step) => step.stage === progress.stage)
  return index < 0 ? 0 : index
}
