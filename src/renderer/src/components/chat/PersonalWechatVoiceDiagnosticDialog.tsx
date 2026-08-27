import { useMemo, useState } from 'react'
import type { PersonalWechatVoiceDiagnostic } from '../../../../shared/personal-wechat'
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui'

interface PersonalWechatVoiceDiagnosticDialogProps {
  open: boolean
  diagnostic: PersonalWechatVoiceDiagnostic | null
  onOpenChange: (open: boolean) => void
}

export function PersonalWechatVoiceDiagnosticDialog({
  open,
  diagnostic,
  onOpenChange
}: PersonalWechatVoiceDiagnosticDialogProps): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const json = useMemo(() => (diagnostic ? JSON.stringify(diagnostic, null, 2) : ''), [diagnostic])

  const copyDiagnostic = async (): Promise<void> => {
    if (!json) return
    const result = await window.api.copyText(json)
    setCopied(result.success)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setCopied(false)
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>语音发送诊断</DialogTitle>
        </DialogHeader>
        {json ? (
          <pre className="max-h-[min(50vh,420px)] overflow-auto rounded-md border border-border-subtle bg-muted/40 p-3 text-xs leading-5 text-foreground">
            {json}
          </pre>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">暂无诊断信息</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button onClick={() => void copyDiagnostic()} disabled={!json}>
            {copied ? '已复制' : '复制诊断 JSON'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
