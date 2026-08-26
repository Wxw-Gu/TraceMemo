import React, { useEffect, useRef, useState } from 'react'
import type { PublishWechatShareCardResult } from '../../../../shared/wechat-share-card'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea
} from '../ui'

interface WechatShareCardDialogProps {
  pngPath: string
  initialTitle: string
  initialDescription: string
  onClose: () => void
}

export function WechatShareCardDialog({
  pngPath,
  initialTitle,
  initialDescription,
  onClose
}: WechatShareCardDialogProps): React.ReactElement {
  const [title, setTitle] = useState(initialTitle)
  const [description, setDescription] = useState(initialDescription)
  const [serviceUrl, setServiceUrl] = useState('https://share.example.com')
  const [uploadToken, setUploadToken] = useState('')
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [editingConfig, setEditingConfig] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<PublishWechatShareCardResult | null>(null)
  const [copied, setCopied] = useState(false)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  const closeDialog = (): void => {
    const restoreFocus = restoreFocusRef.current
    restoreFocusRef.current = null
    onClose()
    queueMicrotask(() => restoreFocus?.focus())
  }

  useEffect(() => {
    void window.api.getWechatShareConfig().then((response) => {
      setConfigured(Boolean(response.success && response.configured))
      if (response.serviceUrl) setServiceUrl(response.serviceUrl)
      if (!response.success) setError(response.error || '读取卡片服务配置失败')
    })
  }, [])

  const publish = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (!configured || editingConfig) {
        const saved = await window.api.saveWechatShareConfig({ serviceUrl, uploadToken })
        if (!saved.success) {
          setError(saved.error || '保存卡片服务配置失败')
          return
        }
        setConfigured(true)
        setEditingConfig(false)
      }
      const published = await window.api.publishWechatShareCard({
        pngPath,
        title,
        description,
        expiresInDays: 7
      })
      if (!published.success) {
        setError(published.error || '微信卡片生成失败')
        return
      }
      setResult(published)
    } finally {
      setBusy(false)
    }
  }

  const copyLink = async (): Promise<void> => {
    if (!result?.shareUrl) return
    await navigator.clipboard.writeText(result.shareUrl)
    setCopied(true)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent
        className="max-h-[calc(100vh-3rem)] max-w-[540px] overflow-y-auto p-0"
        onOpenAutoFocus={() => {
          restoreFocusRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
      >
        <DialogHeader className="border-b border-border px-6 py-5 pr-12">
          <DialogTitle className="text-xl">生成微信分享卡片</DialogTitle>
          <DialogDescription>卡片和日报将在 7 天后自动失效。</DialogDescription>
        </DialogHeader>

        {result?.qrCodeDataUrl ? (
          <div className="grid justify-items-center gap-3 p-7 text-center">
            <img
              className="w-[260px] max-w-[80%] rounded-lg border-[10px] border-surface shadow-floating"
              src={result.qrCodeDataUrl}
              alt="微信分享二维码"
            />
            <h3 className="text-lg font-semibold">使用微信扫码</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              打开页面后点击右上角 ···，发送给好友或群聊。
            </p>
            {result.expiresAt && (
              <small className="text-muted-foreground">
                有效期至 {new Date(result.expiresAt).toLocaleString('zh-CN')}
              </small>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="outline" onClick={() => void copyLink()}>
                {copied ? '链接已复制' : '复制分享链接'}
              </Button>
              <Button onClick={closeDialog}>完成</Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 px-6 py-5">
            <label className="grid gap-2">
              <span className="text-sm font-medium">卡片标题</span>
              <Input
                maxLength={64}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="grid gap-2">
              <span className="text-sm font-medium">卡片描述</span>
              <Textarea
                maxLength={120}
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            {configured === true && !editingConfig && (
              <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-background p-3">
                <div className="grid min-w-0 gap-1">
                  <span className="text-xs text-muted-foreground">卡片服务</span>
                  <b className="overflow-hidden text-ellipsis whitespace-nowrap text-sm">
                    {serviceUrl}
                  </b>
                </div>
                <Button variant="outline" size="sm" onClick={() => setEditingConfig(true)}>
                  更改
                </Button>
              </div>
            )}
            {(configured === false || editingConfig) && (
              <div className="grid min-w-0 gap-3 rounded-md border border-primary/20 bg-primary/5 p-4">
                <h3 className="text-sm font-semibold text-primary">首次配置卡片服务</h3>
                <label className="grid gap-2">
                  <span className="text-sm font-medium">服务地址</span>
                  <Input
                    value={serviceUrl}
                    onChange={(event) => setServiceUrl(event.target.value)}
                  />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-medium">上传密钥</span>
                  <Input
                    type="password"
                    autoComplete="off"
                    value={uploadToken}
                    onChange={(event) => setUploadToken(event.target.value)}
                    placeholder="Cloudflare Worker 的 UPLOAD_TOKEN"
                  />
                </label>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  上传密钥仅加密保存在本机，不是公众号 AppSecret。
                </p>
              </div>
            )}
            <div className="rounded-md bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
              生成后会将当前日报长图和缩略图上传到你的私有 R2 存储。
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <footer className="flex justify-end gap-2">
              <Button variant="outline" onClick={closeDialog}>
                取消
              </Button>
              <Button
                disabled={
                  busy ||
                  configured === null ||
                  !title.trim() ||
                  ((!configured || editingConfig) && uploadToken.trim().length < 24)
                }
                onClick={() => void publish()}
              >
                {busy ? '正在生成卡片…' : '生成二维码'}
              </Button>
            </footer>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
