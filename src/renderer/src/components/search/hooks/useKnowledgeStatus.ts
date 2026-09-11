import { useEffect, useRef, useState } from 'react'
import type { KnowledgeRuntimeStatus } from '../../../../../shared/knowledge'

type UseKnowledgeStatusOptions = {
  dbReady: boolean
  onNotice: (message: string) => void
}

export function useKnowledgeStatus({ dbReady, onNotice }: UseKnowledgeStatusOptions): {
  knowledgeStatus: KnowledgeRuntimeStatus | null
  syncStarting: boolean
  knowledgeSyncing: boolean
  knowledgeSyncingRef: React.MutableRefObject<boolean>
  cancelRequested: boolean
  startKnowledgeSync: () => Promise<void>
  cancelKnowledgeSync: () => Promise<void>
} {
  const [knowledgeStatus, setKnowledgeStatus] = useState<KnowledgeRuntimeStatus | null>(null)
  const [syncStarting, setSyncStarting] = useState(false)
  /**
   * 本地「取消已发出、但还没落地」的状态。
   *
   * Worker 侧 abort 之后，当前会话还要安全收尾（事务提交 / 不残留 indexing），
   * 主进程的 `pass.cancellable=false` 会先到，`phase='cancelled'` 后到。
   * 这中间的窗口如果只靠 status 渲染，按钮会闪回"取消同步"。
   */
  const [cancelRequested, setCancelRequested] = useState(false)
  const knowledgeSyncingRef = useRef(false)
  const knowledgeSyncing =
    syncStarting || knowledgeStatus?.state === 'building' || knowledgeStatus?.state === 'syncing'
  knowledgeSyncingRef.current = knowledgeSyncing

  useEffect(() => {
    let active = true
    void window.api
      .getKnowledgeStatus()
      .then((status) => {
        if (active) setKnowledgeStatus(status)
      })
      .catch(() => undefined)
    const unsubscribe = window.api.onKnowledgeStatus((status) => {
      if (!active) return
      setKnowledgeStatus(status)
      // 一遍 pass 真的结束了（不再可取消 / 已经有终态）→ 清掉本地的"正在取消"。
      const phase = status.pass?.phase
      if (phase === 'idle' || phase === 'cancelled' || phase === 'error') setCancelRequested(false)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const startKnowledgeSync = async (): Promise<void> => {
    if (!dbReady) {
      onNotice('请先连接微信数据后再建立本地知识库')
      return
    }
    setSyncStarting(true)
    setCancelRequested(false)
    try {
      const status = await window.api.startKnowledgeIndex()
      setKnowledgeStatus(status)
      onNotice(
        status.state === 'syncing'
          ? '已开始同步最新聊天记录'
          : '已开始建立本地知识库，可继续使用软件'
      )
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '启动知识库同步失败')
    } finally {
      setSyncStarting(false)
    }
  }

  /**
   * 取消同步。
   *
   * 关键语义（不能简化成"点一下就当取消成功"）：
   * - 只有真的中止到了任务，才提示"已取消"；
   * - `cancelled: false` 表示请求时已经没有可取消的任务（例如刚好自己跑完了），
   *   这时候说"已取消"是假话；
   * - 已索引数据不会被清空，下次同步会从断点继续。
   */
  const cancelKnowledgeSync = async (): Promise<void> => {
    if (cancelRequested) return
    setCancelRequested(true)
    try {
      const result = await window.api.cancelKnowledgeIndex()
      if (!result.cancellable) {
        setCancelRequested(false)
        onNotice('当前没有正在进行的同步')
        return
      }
      if (!result.cancelled) {
        setCancelRequested(false)
        onNotice('同步刚刚已经结束，无需取消')
        return
      }
      onNotice('已取消同步，已建立的部分会保留，下次可继续')
    } catch (error) {
      setCancelRequested(false)
      onNotice(error instanceof Error ? error.message : '取消同步失败')
    }
  }

  return {
    knowledgeStatus,
    syncStarting,
    knowledgeSyncing,
    knowledgeSyncingRef,
    cancelRequested,
    startKnowledgeSync,
    cancelKnowledgeSync
  }
}
