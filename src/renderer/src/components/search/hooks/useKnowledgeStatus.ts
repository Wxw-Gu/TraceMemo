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
  startKnowledgeSync: () => Promise<void>
} {
  const [knowledgeStatus, setKnowledgeStatus] = useState<KnowledgeRuntimeStatus | null>(null)
  const [syncStarting, setSyncStarting] = useState(false)
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
      if (active) setKnowledgeStatus(status)
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

  return {
    knowledgeStatus,
    syncStarting,
    knowledgeSyncing,
    knowledgeSyncingRef,
    startKnowledgeSync
  }
}
