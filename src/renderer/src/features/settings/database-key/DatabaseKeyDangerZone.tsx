import { useRef, useState } from 'react'
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

export function DatabaseKeyDangerZone({
  disabled,
  onClear,
  onReplace,
  onReturnToLogin
}: {
  disabled: boolean
  onClear: () => void
  onReplace: () => void
  onReturnToLogin: () => void
}): React.ReactElement {
  const [confirming, setConfirming] = useState(false)
  const [confirmingReturn, setConfirmingReturn] = useState(false)
  const clearTriggerRef = useRef<HTMLButtonElement>(null)
  const returnTriggerRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <section className="database-key-connection-actions">
        <h2>连接管理</h2>
        <div>
          <span>
            <strong>返回登录界面</strong>
            <small>断开当前数据库连接，回到密钥输入界面。不会删除已保存密钥或微信数据。</small>
          </span>
          <Button
            ref={returnTriggerRef}
            type="button"
            variant="outline"
            onClick={() => setConfirmingReturn(true)}
          >
            返回登录
          </Button>
        </div>
      </section>
      <section className="database-key-danger">
        <h2>密钥管理</h2>
        <div>
          <span>
            <strong>清除已保存密钥</strong>
            <small>从系统安全存储中删除密钥，不会删除微信数据库文件。</small>
          </span>
          <Button
            ref={clearTriggerRef}
            type="button"
            variant="destructive"
            onClick={() => setConfirming(true)}
            disabled={disabled}
          >
            清除密钥
          </Button>
        </div>
        <div>
          <span>
            <strong>替换当前密钥</strong>
            <small>回到编辑区输入并验证新的数据库密钥。</small>
          </span>
          <Button type="button" variant="outline" onClick={onReplace} disabled={disabled}>
            更换密钥
          </Button>
        </div>
      </section>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            window.queueMicrotask(() => clearTriggerRef.current?.focus())
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>确认清除数据库密钥？</AlertDialogTitle>
            <AlertDialogDescription>
              清除后 TraceMemo
              将暂时无法读取聊天记录，需要重新输入或获取密钥。该操作不会删除微信原始数据。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onClear}
            >
              清除密钥
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmingReturn} onOpenChange={setConfirmingReturn}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            window.queueMicrotask(() => returnTriggerRef.current?.focus())
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>返回登录界面？</AlertDialogTitle>
            <AlertDialogDescription>
              TraceMemo
              将断开当前数据库连接并回到密钥输入界面。已保存的数据库密钥和微信原始数据不会被删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={onReturnToLogin}>返回登录</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
