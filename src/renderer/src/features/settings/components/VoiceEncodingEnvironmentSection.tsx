import { useState } from 'react'
import type { PersonalWechatVoiceEncodingEnvironment } from '../../../../../shared/personal-wechat-voice-runtime'
import { Button } from '../../../components/ui'
import { isMac } from '../../../utils/runtime-environment'

function componentDetail(
  component: PersonalWechatVoiceEncodingEnvironment['python'],
  kind: 'python' | 'pilk' | 'ffmpeg'
): string {
  if (!component.ready) {
    const error = component.error || ''
    if (/ENOENT|not found|未找到/i.test(error)) return '未找到'
    if (kind === 'pilk' && /ModuleNotFoundError|No module named|未安装/i.test(error)) {
      return '未安装'
    }
    return error || '未找到'
  }
  return [component.version, component.executable || component.path].filter(Boolean).join(' · ')
}

function statusLabel(environment: PersonalWechatVoiceEncodingEnvironment | null): string {
  if (!environment) return '尚未检查'
  if (environment.state === 'ready') return '✓ 编码环境正常'
  if (environment.state === 'unsupported') return '当前系统不支持'
  if (environment.state === 'error') return '检查失败'
  return '⚠ 编码环境不完整'
}

function componentMark(ready: boolean): string {
  return ready ? '✓' : '✗'
}

export function VoiceEncodingEnvironmentSection({
  onNotice
}: {
  onNotice: (message: string) => void
}): React.ReactElement | null {
  const [environment, setEnvironment] = useState<PersonalWechatVoiceEncodingEnvironment | null>(
    null
  )
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)

  if (!isMac) return null

  const checkEnvironment = async (): Promise<void> => {
    const check = window.api.checkPersonalWechatVoiceEncodingEnvironment
    if (typeof check !== 'function') {
      onNotice('当前版本暂不支持语音编码环境检查')
      return
    }
    setChecking(true)
    try {
      setEnvironment(await check())
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '语音编码环境检查失败')
    } finally {
      setChecking(false)
    }
  }

  const installPilk = async (): Promise<void> => {
    const install = window.api.installPersonalWechatPilk
    if (typeof install !== 'function' || installing) {
      if (typeof install !== 'function') onNotice('当前版本暂不支持 pilk 安装')
      return
    }
    setInstalling(true)
    try {
      const result = await install()
      setEnvironment(result.environment)
      if (!result.success) {
        onNotice(result.error || 'pilk 安装失败')
        return
      }
      if (!result.environment.ready) {
        onNotice(
          result.environment.message || 'pilk 已安装，但仍有语音编码环境未就绪。请重新检查。'
        )
      } else if (result.restarted) {
        onNotice('语音编码环境已修复，语音发送服务已重启')
      } else if (result.restartError) {
        onNotice(`语音编码环境已修复，但语音发送服务重启失败：${result.restartError}`)
      } else {
        onNotice('语音编码环境已修复。重新启动语音发送服务后生效。')
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'pilk 安装失败')
    } finally {
      setInstalling(false)
    }
  }

  const openPythonDownload = async (): Promise<void> => {
    const open = window.api.openPersonalWechatVoicePythonDownload
    if (typeof open !== 'function') return onNotice('当前版本暂不支持打开 Python 下载页面')
    const result = await open()
    if (!result.success) onNotice(result.error || '无法打开 Python 下载页面')
  }

  const openFfmpegDownload = async (): Promise<void> => {
    const open = window.api.openPersonalWechatVoiceFfmpegDownload
    if (typeof open !== 'function') return onNotice('当前版本暂不支持打开 FFmpeg 安装页面')
    const result = await open()
    if (!result.success) onNotice(result.error || '无法打开 FFmpeg 安装页面')
  }

  const pythonMissing = Boolean(environment && !environment.python.ready)
  const pilkMissing = Boolean(environment && !environment.pilk.ready && environment.python.ready)
  const ffmpegMissing = Boolean(environment && !environment.ffmpeg.ready)
  const status = environment?.state || 'unknown'

  return (
    <section className={`settings-card voice-encoding-environment status-${status}`}>
      <div className="voice-encoding-heading">
        <div>
          <span className="settings-card-kicker">微信语音发送</span>
          <h2>语音编码环境</h2>
          <p>检查 TraceMemo 实际使用的 Python、pilk 和 FFmpeg，避免发送后才发现语音无法播放。</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={checking || installing}
          onClick={() => void checkEnvironment()}
        >
          {checking ? '检查中…' : '检查编码环境'}
        </Button>
      </div>

      <div className="voice-encoding-status" role="status">
        <strong>{statusLabel(environment)}</strong>
        {environment?.message ? <span>{environment.message}</span> : null}
      </div>

      {environment ? (
        <div className="voice-encoding-checks">
          <div
            className={`voice-encoding-check ${environment.python.ready ? 'is-ready' : 'is-missing'}`}
          >
            <span>Python {componentMark(environment.python.ready)}</span>
            <small>{componentDetail(environment.python, 'python')}</small>
            {pythonMissing ? (
              <Button variant="link" size="sm" onClick={() => void openPythonDownload()}>
                安装 Python
              </Button>
            ) : null}
          </div>
          <div
            className={`voice-encoding-check ${environment.pilk.ready ? 'is-ready' : 'is-missing'}`}
          >
            <span>
              pilk {environment.pilk.version || '0.2.4'} {componentMark(environment.pilk.ready)}
            </span>
            <small>{componentDetail(environment.pilk, 'pilk')}</small>
            {pilkMissing ? (
              <Button
                variant="link"
                size="sm"
                disabled={installing}
                onClick={() => void installPilk()}
              >
                {installing ? '安装中…' : '安装 pilk'}
              </Button>
            ) : null}
          </div>
          <div
            className={`voice-encoding-check ${environment.ffmpeg.ready ? 'is-ready' : 'is-missing'}`}
          >
            <span>ffmpeg {componentMark(environment.ffmpeg.ready)}</span>
            <small>{componentDetail(environment.ffmpeg, 'ffmpeg')}</small>
            {ffmpegMissing ? (
              <Button variant="link" size="sm" onClick={() => void openFfmpegDownload()}>
                安装 ffmpeg
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="voice-encoding-empty">点击“检查编码环境”后查看实际运行环境。</p>
      )}
    </section>
  )
}
