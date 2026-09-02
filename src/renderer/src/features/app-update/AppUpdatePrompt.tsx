import { useState } from 'react'
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
  const shouldPrompt =
    update.status === 'available' &&
    update.source === 'startup' &&
    Boolean(update.version) &&
    update.version !== dismissedVersion

  const dismiss = (): void => setDismissedVersion(update.version)

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
