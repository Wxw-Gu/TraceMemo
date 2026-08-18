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
} from '../../../components/ui'

export function DangerZone({
  disabled,
  onClear
}: {
  disabled: boolean
  onClear: () => void
}): React.ReactElement {
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <section className="database-key-danger image-key-danger">
        <h2>图片密钥管理</h2>
        <div>
          <span>
            <strong>清除图片密钥</strong>
            <small>聊天记录和微信原始图片不会被删除。</small>
          </span>
          <Button variant="destructive" disabled={disabled} onClick={() => setConfirming(true)}>
            清除图片密钥
          </Button>
        </div>
      </section>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认清除图片解密配置？</AlertDialogTitle>
            <AlertDialogDescription>
              清除后聊天记录仍然存在，但图片需要重新配置后才能解析。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onClear}
            >
              清除图片密钥
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
