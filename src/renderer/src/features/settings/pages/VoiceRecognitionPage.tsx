import { useCallback, useEffect, useMemo, useState } from 'react'
import type { VoiceModelStatus } from '../../../../../shared/voice-recognition'

const SENSEVOICE_URL = 'https://github.com/FunAudioLLM/SenseVoice'
const SHERPA_URL = 'https://github.com/k2-fsa/sherpa-onnx'

const STATUS_LABELS: Record<VoiceModelStatus['state'], string> = {
  missing: '未下载',
  downloading: '下载中',
  ready: '已就绪',
  invalid: '需要修复',
  error: '下载失败',
  unsupported: '暂不支持'
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatPlatform(status: VoiceModelStatus): string {
  if (status.platform === 'win32')
    return `Windows ${status.architecture === 'x64' ? '64 位' : status.architecture}`
  if (status.platform === 'darwin') {
    return status.architecture === 'arm64' ? 'macOS Apple 芯片' : 'macOS Intel'
  }
  return `${status.platform} ${status.architecture}`
}

export function VoiceRecognitionPage({
  onNotice
}: {
  onNotice: (message: string) => void
}): React.ReactElement {
  const [status, setStatus] = useState<VoiceModelStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setStatus(await window.api.getVoiceModelStatus())
  }, [])

  useEffect(() => {
    let active = true
    void window.api.getVoiceModelStatus().then((next) => active && setStatus(next))
    const unsubscribe = window.api.onVoiceModelProgress((next) => {
      if (active) setStatus(next)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const badgeClass = useMemo(() => {
    if (status?.state === 'ready') return 'ready'
    if (status?.state === 'downloading') return 'checking'
    if (status?.state === 'invalid' || status?.state === 'error') return 'error'
    if (status?.state === 'unsupported') return 'unavailable'
    return 'warning'
  }, [status?.state])

  const download = async (): Promise<void> => {
    setBusy(true)
    setStatus((current) =>
      current ? { ...current, state: 'downloading', downloadedBytes: 0, progress: 0 } : current
    )
    try {
      const result = await window.api.downloadVoiceModel()
      setStatus(result.status)
      onNotice(result.success ? '离线语音模型已准备好' : result.error || '模型下载失败')
    } finally {
      setBusy(false)
    }
  }

  const cancelDownload = async (): Promise<void> => {
    await window.api.cancelVoiceModelDownload()
    onNotice('正在取消模型下载')
  }

  const removeModel = async (): Promise<void> => {
    if (!window.confirm('删除离线语音模型？以后使用语音转文字时需要重新下载。')) return
    setBusy(true)
    try {
      setStatus(await window.api.removeVoiceModel())
      onNotice('离线语音模型已删除')
    } catch (error) {
      onNotice(error instanceof Error ? `模型删除失败：${error.message}` : '模型删除失败')
    } finally {
      setBusy(false)
    }
  }

  const openDirectory = async (): Promise<void> => {
    const result = await window.api.openVoiceModelDirectory()
    if (!result.success) onNotice(result.error || '无法打开模型目录')
  }

  return (
    <div className="settings-page voice-recognition-page">
      <header className="settings-page-header">
        <div>
          <h1>语音转文字</h1>
          <p>管理本地语音识别环境和离线模型</p>
        </div>
        <div className="voice-header-status">
          <span className={`settings-status-badge ${badgeClass}`}>
            {status?.state === 'downloading'
              ? `下载中 ${Math.round(status.progress * 100)}%`
              : status
                ? STATUS_LABELS[status.state]
                : '检测中'}
          </span>
          {status?.state === 'downloading' && (
            <progress value={status.progress} max={1} aria-label="顶部语音模型下载进度" />
          )}
        </div>
      </header>
      <div className="settings-page-scroll">
        <div className="settings-page-content voice-recognition-content">
          <section className="settings-privacy-notice">
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M12 3 5.5 5.7v5.2c0 4.3 2.7 8.2 6.5 10.1 3.8-1.9 6.5-5.8 6.5-10.1V5.7L12 3Z" />
            </svg>
            <div>
              <strong>语音内容仅在本机处理</strong>
              <p>识别过程不会上传语音、聊天内容或转写结果，也不需要配置在线 AI 服务。</p>
            </div>
          </section>

          <h2 className="settings-section-heading">运行环境</h2>
          <section className="settings-card voice-runtime-card">
            <dl>
              <div>
                <dt>当前平台</dt>
                <dd>{status ? formatPlatform(status) : '检测中...'}</dd>
              </div>
              <div>
                <dt>离线识别</dt>
                <dd className={status?.supported ? 'voice-status-success' : 'voice-status-error'}>
                  {status?.supported ? '支持' : '暂不支持'}
                </dd>
              </div>
              <div>
                <dt>识别引擎</dt>
                <dd>sherpa-onnx · SenseVoice</dd>
              </div>
            </dl>
          </section>

          <h2 className="settings-section-heading">离线模型</h2>
          <section className="settings-card voice-model-card">
            <div className="voice-model-summary">
              <span className="settings-card-kicker">SenseVoice Small INT8</span>
              <strong>
                {status?.state === 'downloading'
                  ? `正在下载 ${Math.round(status.progress * 100)}%`
                  : status
                    ? STATUS_LABELS[status.state]
                    : '正在检测'}
              </strong>
              <small>
                {status
                  ? `版本 ${status.version} · ${formatBytes(status.totalBytes)}`
                  : '读取模型状态...'}
              </small>
              {status?.error && <p className="voice-model-error">{status.error}</p>}
              <p className="voice-model-license">
                上游模型：
                <a href={SENSEVOICE_URL} target="_blank" rel="noreferrer">
                  SenseVoice（MIT）
                </a>
                <span> · </span>
                推理运行库：
                <a href={SHERPA_URL} target="_blank" rel="noreferrer">
                  sherpa-onnx（Apache-2.0）
                </a>
              </p>
            </div>
            <div className="voice-model-actions">
              {status?.state === 'downloading' ? (
                <button type="button" onClick={() => void cancelDownload()}>
                  取消下载
                </button>
              ) : status?.state === 'ready' ? (
                <>
                  <button type="button" onClick={() => void openDirectory()}>
                    打开模型目录
                  </button>
                  <button
                    type="button"
                    className="settings-danger-button"
                    disabled={busy}
                    onClick={() => void removeModel()}
                  >
                    删除模型
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="settings-primary-button"
                  disabled={busy || !status?.supported}
                  onClick={() => void download()}
                >
                  {status?.state === 'invalid' || status?.state === 'error'
                    ? '重新下载模型'
                    : '下载模型'}
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => void refresh()}>
                重新检测
              </button>
            </div>
            {status?.state === 'downloading' && (
              <div className="voice-model-progress">
                <div>
                  <span>{Math.round(status.progress * 100)}%</span>
                  <small>
                    {formatBytes(status.downloadedBytes)} / {formatBytes(status.totalBytes)}
                  </small>
                </div>
                <progress value={status.progress} max={1} aria-label="语音模型下载进度" />
              </div>
            )}
          </section>

          <h2 className="settings-section-heading">平台支持</h2>
          <section className="settings-card voice-platform-list">
            <div>
              <strong>Windows</strong>
              <span>支持 Windows 10/11 64 位</span>
            </div>
            <div>
              <strong>macOS</strong>
              <span>支持 Intel 与 Apple 芯片</span>
            </div>
          </section>
          <p className="settings-footnote">
            模型由两个平台共用；应用会随安装包提供对应系统的本地识别运行库。
          </p>
        </div>
      </div>
    </div>
  )
}
