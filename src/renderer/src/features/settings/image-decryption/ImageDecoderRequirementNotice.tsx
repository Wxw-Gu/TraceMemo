import { useEffect, useState } from 'react'
import type { ImageDecoderStatus } from '../../../../../shared/image-decryption'

interface ImageDecoderRequirementNoticeProps {
  status?: ImageDecoderStatus
  onNotice: (message: string) => void
}

export function ImageDecoderRequirementNotice({
  status,
  onNotice
}: ImageDecoderRequirementNoticeProps): React.ReactElement {
  const platform = window.electron.process.platform
  const [currentStatus, setCurrentStatus] = useState(status)
  const [selecting, setSelecting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => setCurrentStatus(status), [status])

  const selectDirectory = async (): Promise<void> => {
    setSelecting(true)
    setError(undefined)
    try {
      const result = await window.api.selectImageDecoder()
      if (result.canceled) return
      if (!result.success || !result.status) {
        setError(result.error || '没有在所选文件夹中找到 FFmpeg，请重新选择。')
        return
      }
      setCurrentStatus(result.status)
      onNotice(
        result.status.available
          ? 'FFmpeg 安装目录已保存，原图支持可以使用'
          : 'FFmpeg 安装目录已保存，但原图支持未通过检测'
      )
    } catch {
      setError('无法打开目录选择窗口，请稍后重试。')
    } finally {
      setSelecting(false)
    }
  }

  const checkOriginalSupport = async (): Promise<void> => {
    setChecking(true)
    setError(undefined)
    try {
      const nextStatus = await window.api.getImageDecoderStatus()
      setCurrentStatus(nextStatus)
      onNotice(nextStatus.available ? '原图支持检测通过' : '原图支持检测未通过')
    } catch {
      setError('原图支持检测失败，请稍后重试。')
    } finally {
      setChecking(false)
    }
  }

  const openDownload = async (): Promise<void> => {
    setError(undefined)
    try {
      const result = await window.api.openImageDecoderDownload()
      if (!result.success) setError(result.error || '无法打开 FFmpeg 下载页面')
    } catch {
      setError('无法打开 FFmpeg 下载页面，请检查系统默认浏览器设置。')
    }
  }

  const installed = currentStatus?.installed === true
  const supported = currentStatus?.available === true
  const downloadLabel = platform === 'darwin' ? '打开 Homebrew 官网' : '下载 FFmpeg'

  return (
    <section
      className={`image-decoder-requirement ${supported ? 'ready' : ''}`}
      aria-label="FFmpeg 原图支持"
    >
      <span className="image-decoder-requirement-icon" aria-hidden>
        {supported ? '✓' : '!'}
      </span>
      <div className="image-decoder-requirement-body">
        <div className="image-decoder-requirement-heading">
          <strong>FFmpeg 原图支持</strong>
          <span>
            {supported ? '原图支持可用' : installed ? 'FFmpeg 已安装' : '需要安装 FFmpeg'}
          </span>
        </div>

        <p>如需打开少量 wxgf/HEVC 特殊原图，必须安装 FFmpeg。未安装不会影响聊天记录和普通图片。</p>

        <div className="image-decoder-checks">
          <div>
            <span className={`image-decoder-check-index ${installed ? 'complete' : ''}`}>1</span>
            <div>
              <strong>FFmpeg 安装目录</strong>
              <small title={currentStatus?.directory}>
                {currentStatus?.directory || '尚未检测到 FFmpeg 安装目录'}
              </small>
            </div>
            <b className={installed ? 'success' : ''}>{installed ? '已检测' : '未检测'}</b>
          </div>
          <div>
            <span className={`image-decoder-check-index ${supported ? 'complete' : ''}`}>2</span>
            <div>
              <strong>原图支持检测</strong>
              <small>
                {supported
                  ? '已支持 wxgf/HEVC 特殊原图转换'
                  : installed
                    ? '尚未检测到 HEVC 原图转换能力'
                    : '请先安装并检测 FFmpeg 目录'}
              </small>
            </div>
            <b className={supported ? 'success' : ''}>{supported ? '已通过' : '未通过'}</b>
          </div>
        </div>

        <div className="image-decoder-requirement-actions">
          <button
            type="button"
            className="settings-header-action"
            onClick={() => void openDownload()}
          >
            {downloadLabel}
          </button>
          <button
            type="button"
            className="settings-primary-button"
            disabled={selecting}
            onClick={() => void selectDirectory()}
          >
            {selecting ? '正在保存…' : '填写 FFmpeg 安装目录'}
          </button>
          <button
            type="button"
            className="settings-header-action"
            disabled={!installed || checking}
            onClick={() => void checkOriginalSupport()}
          >
            {checking ? '正在检测…' : '检测原图支持'}
          </button>
        </div>

        <div className="image-decoder-platform-help">
          {platform === 'win32' ? (
            <>
              <strong>Windows 安装与定位</strong>
              <p>
                下载后右键压缩包选择“全部解压”，再填写解压后的文件夹。如果已经安装但没有自动找到，可在
                PowerShell 输入 <code>(Get-Command ffmpeg).Source</code>，或在命令提示符（CMD）输入{' '}
                <code>where ffmpeg</code>，然后选择返回路径所在的 bin 文件夹。
              </p>
            </>
          ) : platform === 'darwin' ? (
            <>
              <strong>macOS 安装与定位</strong>
              <p>
                打开“终端”并输入 <code>brew install ffmpeg</code>。如果提示没有
                brew，请先通过上方按钮打开 Homebrew 官网完成安装。安装后输入{' '}
                <code>which ffmpeg</code>，再选择返回路径所在的文件夹， 通常是{' '}
                <code>/opt/homebrew/bin</code> 或 <code>/usr/local/bin</code>。
              </p>
            </>
          ) : (
            <>
              <strong>Linux 安装与定位</strong>
              <p>
                通过系统包管理器安装 FFmpeg，执行 <code>which ffmpeg</code>{' '}
                查看位置，再选择返回路径所在的文件夹。
              </p>
            </>
          )}
        </div>

        {error && (
          <p className="image-decoder-requirement-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  )
}
