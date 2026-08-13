import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PublishWechatShareCardResult } from '../../../../shared/wechat-share-card'

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

  useEffect(() => {
    void window.api.getWechatShareConfig().then((response) => {
      setConfigured(Boolean(response.success && response.configured))
      if (response.serviceUrl) setServiceUrl(response.serviceUrl)
      if (!response.success) setError(response.error || '读取卡片服务配置失败')
    })
  }, [])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [busy, onClose])

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

  return createPortal(
    <div className="wechat-share-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="wechat-share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wechat-share-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="wechat-share-title">生成微信分享卡片</h2>
            <p>卡片和日报将在 7 天后自动失效。</p>
          </div>
          <button type="button" className="wechat-share-dialog-close" onClick={onClose}>
            ×
          </button>
        </header>

        {result?.qrCodeDataUrl ? (
          <div className="wechat-share-success">
            <img src={result.qrCodeDataUrl} alt="微信分享二维码" />
            <h3>使用微信扫码</h3>
            <p>打开页面后点击右上角 ···，发送给好友或群聊。</p>
            {result.expiresAt && (
              <small>有效期至 {new Date(result.expiresAt).toLocaleString('zh-CN')}</small>
            )}
            <div>
              <button type="button" onClick={() => void copyLink()}>
                {copied ? '链接已复制' : '复制分享链接'}
              </button>
              <button type="button" className="primary" onClick={onClose}>
                完成
              </button>
            </div>
          </div>
        ) : (
          <div className="wechat-share-form">
            <label>
              <span>卡片标题</span>
              <input
                maxLength={64}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label>
              <span>卡片描述</span>
              <textarea
                maxLength={120}
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            {configured === true && !editingConfig && (
              <div className="wechat-share-service-summary">
                <div>
                  <span>卡片服务</span>
                  <b>{serviceUrl}</b>
                </div>
                <button type="button" onClick={() => setEditingConfig(true)}>
                  更改
                </button>
              </div>
            )}
            {(configured === false || editingConfig) && (
              <div className="wechat-share-service-config">
                <h3>首次配置卡片服务</h3>
                <label>
                  <span>服务地址</span>
                  <input
                    value={serviceUrl}
                    onChange={(event) => setServiceUrl(event.target.value)}
                  />
                </label>
                <label>
                  <span>上传密钥</span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={uploadToken}
                    onChange={(event) => setUploadToken(event.target.value)}
                    placeholder="Cloudflare Worker 的 UPLOAD_TOKEN"
                  />
                </label>
                <p>上传密钥仅加密保存在本机，不是公众号 AppSecret。</p>
              </div>
            )}
            <div className="wechat-share-privacy">
              生成后会将当前日报长图和缩略图上传到你的私有 R2 存储。
            </div>
            {error && <p className="report-inline-error">{error}</p>}
            <footer>
              <button type="button" onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                disabled={
                  busy ||
                  configured === null ||
                  !title.trim() ||
                  ((!configured || editingConfig) && uploadToken.trim().length < 24)
                }
                onClick={() => void publish()}
              >
                {busy ? '正在生成卡片…' : '生成二维码'}
              </button>
            </footer>
          </div>
        )}
      </section>
    </div>,
    document.body
  )
}
