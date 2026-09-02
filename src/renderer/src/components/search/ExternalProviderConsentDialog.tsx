import * as React from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui'

export interface ExternalProviderConsent {
  providerName: string
  recipient: string
}

export interface ExternalProviderConsentDialogProps {
  consent: ExternalProviderConsent | null
  onConfirm: () => void
  onCancel: () => void
}

export function ExternalProviderConsentDialog({
  consent,
  onConfirm,
  onCancel
}: ExternalProviderConsentDialogProps): React.ReactElement {
  const open = Boolean(consent)
  const restoreFocusRef = React.useRef<HTMLElement | null>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && open) onCancel()
      }}
    >
      <DialogContent
        className="max-w-[460px] gap-0 p-5"
        onOpenAutoFocus={() => {
          restoreFocusRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          restoreFocusRef.current?.focus()
          restoreFocusRef.current = null
        }}
      >
        <DialogHeader className="gap-0">
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            AI SEARCH
          </span>
          <DialogTitle className="mt-1.5 text-lg">确认发送本次搜索资料</DialogTitle>
          <DialogDescription className="mt-3 text-[13px] leading-[21px]">
            将向 <strong className="font-semibold text-foreground">{consent?.providerName}</strong>{' '}
            （{consent?.recipient}）发送当前问题、受控检索所需的受限上下文，以及最多 8 条最终
            Evidence。
          </DialogDescription>
        </DialogHeader>
        <p className="mt-2.5 rounded-md bg-primary/10 p-2.5 text-[13px] leading-[21px] text-foreground">
          不会发送完整微信数据库、全量聊天记录、密钥、绝对路径或内部会话/消息引用 ID。
        </p>
        <DialogFooter className="mt-[18px] gap-2">
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={onConfirm}>继续并发送</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
