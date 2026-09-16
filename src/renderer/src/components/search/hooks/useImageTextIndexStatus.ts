import { useCallback, useEffect, useState } from 'react'
import type {
  ImageTextIndexCountResult,
  ImageTextIndexStartOptions,
  ImageTextIndexStatus
} from '../../../../../shared/image-text-index'

type UseImageTextIndexStatusOptions = {
  /** 微信数据是否已就绪。未就绪时既不统计也不允许建立索引。 */
  dbReady: boolean
  onNotice: (message: string) => void
}

export type ImageTextIndexAction = 'start' | 'pause' | 'resume' | 'cancel' | 'reset' | 'repair'

/**
 * 「图片文字索引」的 renderer 侧状态。
 *
 * 三条不能省的语义：
 * 1. **重启后进度是真的**：进度与覆盖度全部来自主进程的派生库快照，
 *    renderer 不自己累加、也不缓存百分比。应用重启后重新拉一次即可恢复真实进度。
 * 2. **数量统计是显式动作**：COUNT(*) 要走一遍会话列表，不在每次渲染时触发；
 *    只在「未建立」时拉一次、以及点击建立前重新拉一次（确认弹窗里的数字必须新鲜）。
 * 3. **暂停 / 继续 / 取消都是待确认操作**：主进程返回 started/paused/cancelled
 *    才提示成功；例如 `started: false` 表示已经有任务在跑，此时说"已开始"是假话。
 */
export function useImageTextIndexStatus({
  dbReady,
  onNotice
}: UseImageTextIndexStatusOptions): {
  status: ImageTextIndexStatus | null
  count: ImageTextIndexCountResult | null
  counting: boolean
  pending: ImageTextIndexAction | null
  running: boolean
  paused: boolean
  established: boolean
  refreshCount: (sinceMs?: number) => Promise<ImageTextIndexCountResult | null>
  start: (options?: ImageTextIndexStartOptions) => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  cancel: () => Promise<void>
  resetFailures: () => Promise<void>
  repair: () => Promise<void>
} {
  const [status, setStatus] = useState<ImageTextIndexStatus | null>(null)
  const [count, setCount] = useState<ImageTextIndexCountResult | null>(null)
  const [counting, setCounting] = useState(false)
  const [pending, setPending] = useState<ImageTextIndexAction | null>(null)

  useEffect(() => {
    // 这是一个**次要侧栏能力**：桥接缺失（旧 preload / 测试里手写的 window.api）
    // 或推送异常，都不允许把整个「问问微信」拖垮。缺少桥接时按「未建立」降级即可。
    const bridge = window.api as unknown as {
      getImageTextIndexStatus?: () => Promise<ImageTextIndexStatus>
      onImageTextIndexStatus?: (
        callback: (status: ImageTextIndexStatus) => void
      ) => (() => void) | undefined
    }
    const loadStatus = bridge.getImageTextIndexStatus
    const subscribe = bridge.onImageTextIndexStatus
    if (typeof loadStatus !== 'function' || typeof subscribe !== 'function') return

    let active = true
    void loadStatus
      .call(bridge)
      .then((snapshot) => {
        if (active) setStatus(snapshot)
      })
      .catch(() => undefined)
    const unsubscribe = subscribe((snapshot) => {
      if (active) setStatus(snapshot)
    })
    return () => {
      active = false
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  const refreshCount = useCallback(
    async (sinceMs?: number): Promise<ImageTextIndexCountResult | null> => {
    if (!dbReady) return null
    setCounting(true)
    try {
      const result = await window.api.countImageMessages(sinceMs)
      setCount(result)
      return result
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '统计图片消息数量失败')
      return null
    } finally {
      setCounting(false)
    }
    },
    [dbReady, onNotice]
  )

  const established = status?.coverage.established ?? false
  void established

  const start = useCallback(
    async (options?: ImageTextIndexStartOptions): Promise<void> => {
      if (!dbReady) {
        onNotice('请先连接微信数据后再建立图片文字索引')
        return
      }
      setPending('start')
      try {
        const result = await window.api.startImageTextIndex(options)
        if (!result.started) {
          onNotice('图片文字索引已经在进行中')
          return
        }
        onNotice('已开始建立图片文字索引，可以继续使用软件')
      } catch (error) {
        onNotice(error instanceof Error ? error.message : '启动图片文字索引失败')
      } finally {
        setPending(null)
      }
    },
    [dbReady, onNotice]
  )

  const pause = useCallback(async (): Promise<void> => {
    setPending('pause')
    try {
      const result = await window.api.pauseImageTextIndex()
      onNotice(result.paused ? '已暂停，已完成的识别结果会保留' : '当前没有正在进行的索引')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '暂停失败')
    } finally {
      setPending(null)
    }
  }, [onNotice])

  const resume = useCallback(
    async (options?: ImageTextIndexStartOptions): Promise<void> => {
      setPending('resume')
      try {
        const result = await window.api.resumeImageTextIndex(options)
        onNotice(result.started ? '已继续建立图片文字索引' : '索引已经在进行中')
      } catch (error) {
        onNotice(error instanceof Error ? error.message : '继续失败')
      } finally {
        setPending(null)
      }
    },
    [onNotice]
  )

  const cancel = useCallback(async (): Promise<void> => {
    setPending('cancel')
    try {
      const result = await window.api.cancelImageTextIndex()
      if (!result.cancellable) {
        onNotice('当前没有正在进行的索引')
        return
      }
      if (!result.cancelled) {
        onNotice('索引刚刚已经结束，无需取消')
        return
      }
      onNotice('已取消，已识别的结果会保留，下次可从中断处继续')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '取消失败')
    } finally {
      setPending(null)
    }
  }, [onNotice])

  /**
   * 重置失败记录（代码修好后重跑）。
   *
   * 只说"已重置 N 条"是不够的 —— 必须同时讲清楚**成功记录没有被删**，
   * 否则用户会以为刚才把已经跑好的结果也清掉了。
   */
  const resetFailures = useCallback(async (): Promise<void> => {
    setPending('reset')
    try {
      const result = await window.api.resetImageTextIndexFailures()
      onNotice(
        result.reset > 0
          ? `已把 ${result.reset.toLocaleString()} 条失败记录重置为待处理；已成功识别的记录保持不变。可以点「更新图片文字索引」重新处理这些图片`
          : '没有需要重置的失败记录'
      )
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '重置失败记录失败')
    } finally {
      setPending(null)
    }
  }, [onNotice])

  /**
   * 派生索引修复：只重建 Knowledge 里的图片派生条目（L3），**不重新 OCR**（L1 不动）。
   *
   * 措辞必须讲清楚"没有重新识别"：否则用户会以为又要等一小时，
   * 从而不敢点这个按钮 —— 而这个按钮存在的全部意义就是"别重跑几万张图"。
   */
  const repair = useCallback(async (): Promise<void> => {
    setPending('repair')
    try {
      const result = await window.api.repairImageTextIndex()
      if (result.skipped) {
        onNotice('索引任务正在进行中，请等它结束后再修复搜索索引')
        return
      }
      onNotice(
        result.conversations > 0
          ? `已重建 ${result.conversations} 个会话的图片搜索索引；没有重新识别任何图片（已识别结果全部复用）`
          : '没有需要重建的图片搜索索引'
      )
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '修复图片搜索索引失败')
    } finally {
      setPending(null)
    }
  }, [onNotice])

  return {
    status,
    count,
    counting,
    pending,
    running: status?.progress.state === 'running',
    paused: status?.progress.state === 'paused',
    established,
    refreshCount,
    start,
    pause,
    resume,
    cancel,
    resetFailures,
    repair
  }
}
