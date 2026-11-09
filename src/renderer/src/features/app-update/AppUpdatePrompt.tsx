import { useEffect, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button
} from '../../components/ui'
import { useAppUpdateState } from './useAppUpdateState'

export function AppUpdatePrompt({
  onDownloadStart,
  onNotice
}: {
  onDownloadStart: () => void
  onNotice: (message: string) => void
}): React.ReactElement {
  const update = useAppUpdateState()
  const [dismissedVersion, setDismissedVersion] = useState<string>()
  /**
   * 已忽略的版本号。`null` 表示还没读回来 —— 这期间不弹，否则用户会看到
   * 弹窗闪一下就消失（启动时状态先到、设置后到）。
   */
  const [ignoredVersion, setIgnoredVersion] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.api
      .getIgnoredUpdateVersion()
      .then((version) => {
        if (active) setIgnoredVersion(version || '')
      })
      .catch(() => {
        // 读不到就按"没有忽略"处理：宁可多弹一次，也不要静默吞掉更新提示。
        if (active) setIgnoredVersion('')
      })
    return () => {
      active = false
    }
  }, [])

  const shouldPrompt =
    update.status === 'available' &&
    update.source === 'startup' &&
    Boolean(update.version) &&
    ignoredVersion !== null &&
    update.version !== ignoredVersion &&
    update.version !== dismissedVersion

  const dismiss = (): void => setDismissedVersion(update.version)

  const ignoreVersion = async (): Promise<void> => {
    const version = update.version
    if (!version) return
    setIgnoredVersion(version)
    dismiss()
    try {
      await window.api.setIgnoredUpdateVersion(version)
      onNotice(`已忽略 v${version} 的更新提示，可在「设置 → 关于」恢复`)
    } catch (error) {
      // 没写进磁盘就当作没忽略，否则用户以为设置生效了，下次启动照样弹。
      setIgnoredVersion('')
      onNotice(error instanceof Error ? error.message : '忽略更新提示失败')
    }
  }

  const continueUpdate = async (): Promise<void> => {
    dismiss()
    if (update.delivery === 'release-page') {
      const result = await window.api.openAppUpdateDownloadPage()
      if (!result.success) onNotice(result.error || '无法打开下载页面')
      return
    }
    onDownloadStart()
    const result = await window.api.downloadAppUpdate()
    if (result && !result.success) onNotice(result.state.message || '更新下载失败')
  }

  return (
    <AlertDialog open={shouldPrompt}>
      <AlertDialogContent aria-label="发现新版本">
        <AlertDialogHeader>
          <AlertDialogTitle>发现新版本 v{update.version}</AlertDialogTitle>
          <AlertDialogDescription>
            {update.isSimulation
              ? '开发模拟更新已准备好。'
              : update.delivery === 'release-page'
                ? '有新版本可用，前往 GitHub 下载最新版本。'
                : '是否立即下载？'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="ghost" className="sm:mr-auto" onClick={() => void ignoreVersion()}>
            忽略此版本
          </Button>
          <AlertDialogCancel asChild>
            <Button variant="outline" onClick={dismiss}>
              取消
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button onClick={() => void continueUpdate()}>
              {update.delivery === 'release-page' ? '前往下载' : '立即下载'}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
