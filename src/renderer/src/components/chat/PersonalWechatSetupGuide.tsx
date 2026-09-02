import { useState } from 'react'
import type { PersonalWechatSenderStatus } from '../../../../shared/personal-wechat'
import type {
  PersonalWechatRuntimeProgressEvent,
  PersonalWechatRuntimeStatus
} from '../../../../shared/personal-wechat-runtime'
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui'
import { PersonalWechatSupportedVersionsContent } from './PersonalWechatSupportedVersionsContent'

interface PersonalWechatSetupGuideProps {
  runtimeStatus: PersonalWechatRuntimeStatus | null
  senderStatus: PersonalWechatSenderStatus | null
  runtimeProgress: PersonalWechatRuntimeProgressEvent | null
  runtimeBusy: boolean
  binding: boolean
  detecting: boolean
  detectionAttempted: boolean
  onDownloadRuntime: () => void
  onBind: () => void
  onDetect: () => void
  onStartSending: () => void
  onOpenTextToSpeechSettings?: () => void
}

function capabilityLabel(ready: boolean, detectionAttempted: boolean): string {
  if (ready) return '已就绪'
  return detectionAttempted ? '未检测' : '待检测'
}

function diagnosticValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '未检测到'
  return String(value)
}

function bindingHint(status: PersonalWechatSenderStatus): string {
  if (status.state === 'wechat_not_running') return '请先启动并登录微信。'
  if (status.state === 'unsupported_platform') return '当前系统暂不支持个人微信发送。'
  if (status.state === 'unsupported_version')
    return '当前微信版本暂不支持，请查看语音设置中的支持版本。'
  if (status.state === 'runtime_missing') return '请先完成语音模型准备。'
  if (status.state === 'error') return '连接微信时遇到问题，请稍后重试。'
  return '请启动并登录当前微信，TraceMemo 会自动绑定正在使用的账号。'
}

function isWechatBound(status: PersonalWechatSenderStatus): boolean {
  if (status.state === 'online') return true
  return Boolean(
    status.state === 'hook_not_ready' &&
    status.wechatPid &&
    status.boundWechatPid === status.wechatPid &&
    status.attachReady &&
    status.baseAddressReady
  )
}

export function PersonalWechatSetupGuide({
  runtimeStatus,
  senderStatus,
  runtimeProgress,
  runtimeBusy,
  binding,
  detecting,
  detectionAttempted,
  onDownloadRuntime,
  onBind,
  onDetect,
  onStartSending,
  onOpenTextToSpeechSettings
}: PersonalWechatSetupGuideProps): React.ReactElement {
  const [showSupportedVersions, setShowSupportedVersions] = useState(false)
  const runtimeReady = runtimeStatus?.state === 'ready' || senderStatus?.runtimeReady === true
  const runtimeDownloading = runtimeBusy || runtimeStatus?.state === 'downloading'
  const connected = senderStatus ? isWechatBound(senderStatus) : false
  const canSendText = Boolean(senderStatus?.canSendText)
  const canSendImage = Boolean(senderStatus?.canSendImage)
  const canSendVoice = Boolean(senderStatus?.canSendVoice)
  const mediaReady = canSendImage || canSendVoice
  const verificationComplete = canSendText && mediaReady
  const allReady = verificationComplete
  const progress = runtimeProgress || runtimeStatus
  const progressPercent = Math.max(0, Math.min(100, Math.round((progress?.progress || 0) * 100)))

  return (
    <section className="personal-wechat-setup" aria-label="微信消息功能配置">
      <div className="personal-wechat-setup-heading">
        <div>
          <span className="personal-wechat-eyebrow">首次使用</span>
          <h2>先准备好微信消息功能</h2>
          <p>只需几步，TraceMemo 就能像普通聊天窗口一样发送文字、图片和语音。</p>
        </div>
        {allReady && <span className="personal-wechat-setup-complete">已完成</span>}
      </div>

      <ol className="personal-wechat-steps">
        <li
          className={runtimeReady ? 'is-complete' : runtimeDownloading ? 'is-active' : 'is-current'}
        >
          <span className="personal-wechat-step-number">{runtimeReady ? '✓' : '1'}</span>
          <div className="personal-wechat-step-content">
            <strong>准备语音模型</strong>
            <p>发送语音消息需要本地模型，首次使用时下载一次即可。</p>
            {runtimeDownloading ? (
              <div className="personal-wechat-download-progress" aria-live="polite">
                <div>
                  <span>正在准备模型</span>
                  <span>{progressPercent}%</span>
                </div>
                <div className="personal-wechat-progress-track">
                  <span style={{ width: `${progressPercent}%` }} />
                </div>
              </div>
            ) : runtimeReady ? (
              <span className="personal-wechat-step-status">✓ 语音模型已准备</span>
            ) : (
              <Button
                size="sm"
                onClick={onDownloadRuntime}
                disabled={runtimeBusy || runtimeStatus?.state === 'unsupported'}
              >
                下载模型
              </Button>
            )}
            {runtimeStatus?.error && !runtimeDownloading && !runtimeReady && (
              <p className="personal-wechat-step-error">模型准备失败，请重试或查看语音设置。</p>
            )}
          </div>
        </li>

        <li
          className={
            connected
              ? 'is-complete'
              : binding
                ? 'is-active'
                : runtimeReady
                  ? 'is-current'
                  : 'is-pending'
          }
        >
          <span className="personal-wechat-step-number">{connected ? '✓' : '2'}</span>
          <div className="personal-wechat-step-content">
            <strong>绑定个人微信</strong>
            <p>请启动并登录当前微信，TraceMemo 会自动绑定正在使用的账号。</p>
            {connected ? (
              <span className="personal-wechat-step-status">✓ 微信已绑定</span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={onBind}
                disabled={!runtimeReady || binding || runtimeDownloading}
              >
                {binding ? '正在绑定…' : '绑定微信'}
              </Button>
            )}
            {!connected && senderStatus && (
              <p className="personal-wechat-step-hint">{bindingHint(senderStatus)}</p>
            )}
            {!connected && (
              <p className="personal-wechat-step-warning" role="note">
                绑定微信可能导致当前微信异常闪退，这是正常现象。若微信退出，请重新启动微信后，再回到这里重新检测/绑定。
                <br />
                微信总是自动更新？请在微信左下角打开“设置 → 通用”，取消勾选“有更新时自动升级微信”，否则版本变化后可能无法绑定。
              </p>
            )}
            <Button
              className="w-fit"
              variant="link"
              size="sm"
              onClick={() => setShowSupportedVersions(true)}
            >
              查看支持的微信版本
            </Button>
          </div>
        </li>

        <li
          className={verificationComplete ? 'is-complete' : connected ? 'is-current' : 'is-pending'}
        >
          <span className="personal-wechat-step-number">{verificationComplete ? '✓' : '3'}</span>
          <div className="personal-wechat-step-content">
            <strong>验证消息能力</strong>
            <p>
              请打开手机微信，给任意好友手动发送：
              <br />① 一条文字消息
              <br />② 一张图片
            </p>
            <p className="personal-wechat-step-hint">
              TraceMemo 需要通过你主动发送的消息初始化微信消息能力。完成后点击“重新检测”。
            </p>
            {!verificationComplete && (
              <Button
                size="sm"
                variant="outline"
                onClick={onDetect}
                disabled={detecting || binding}
              >
                {detecting ? '正在检测…' : '重新检测'}
              </Button>
            )}
            {detectionAttempted && !detecting && !verificationComplete && (
              <p className="personal-wechat-step-hint" role="status">
                暂未检测到新的消息，请确认已在手机微信中发送文字和图片，然后再次检测。
              </p>
            )}
          </div>
        </li>

        <li
          className={allReady ? 'is-complete' : verificationComplete ? 'is-current' : 'is-pending'}
        >
          <span className="personal-wechat-step-number">{allReady ? '✓' : '4'}</span>
          <div className="personal-wechat-step-content">
            <strong>能力检测</strong>
            <div className="personal-wechat-capabilities" aria-label="微信消息能力">
              {[
                ['文字消息', canSendText],
                ['图片和语音消息', mediaReady]
              ].map(([label, ready]) => (
                <span key={String(label)} className={ready ? 'is-ready' : ''}>
                  <b aria-hidden>{ready ? '✓' : '−'}</b>
                  {label}
                  <small>{capabilityLabel(Boolean(ready), detectionAttempted)}</small>
                </span>
              ))}
            </div>
            {allReady ? (
              <>
                <span className="personal-wechat-step-status">微信消息发送已配置完成</span>
                <Button size="sm" onClick={onStartSending}>
                  开始发送
                </Button>
              </>
            ) : verificationComplete ? (
              <>
                <p className="personal-wechat-step-hint">
                  语音能力还未就绪，请在微信中完成一次媒体消息初始化后重新检测。
                </p>
                <Button size="sm" variant="outline" onClick={onDetect} disabled={detecting}>
                  {detecting ? '正在检测…' : '重新检测能力'}
                </Button>
              </>
            ) : null}
          </div>
        </li>
      </ol>

      {!runtimeReady && runtimeStatus?.state === 'unsupported' && onOpenTextToSpeechSettings && (
        <Button
          variant="link"
          size="sm"
          className="personal-wechat-setup-link"
          onClick={onOpenTextToSpeechSettings}
        >
          查看语音设置
        </Button>
      )}

      <Dialog open={showSupportedVersions} onOpenChange={setShowSupportedVersions}>
        <DialogContent className="max-h-[calc(100vh-3rem)] max-w-[620px] overflow-y-auto">
          <DialogHeader className="pr-8">
            <DialogTitle className="text-lg">支持的微信版本</DialogTitle>
            <DialogDescription>请安装下列完整版本之一。</DialogDescription>
          </DialogHeader>
          <PersonalWechatSupportedVersionsContent />
        </DialogContent>
      </Dialog>

      <details className="personal-wechat-diagnostics">
        <summary>高级诊断</summary>
        <p>仅用于排查连接问题，普通使用无需关注这些信息。</p>
        <dl>
          {[
            ['微信进程', senderStatus?.wechatPid ? `PID ${senderStatus.wechatPid}` : '未检测到'],
            ['OneBot', senderStatus?.oneBotPid ? `PID ${senderStatus.oneBotPid}` : '未启动'],
            ['绑定进程', diagnosticValue(senderStatus?.boundWechatPid)],
            [
              '接口监听',
              `${diagnosticValue(senderStatus?.endpoint)} · ${senderStatus?.endpointReady ? '监听中' : '未监听'}`
            ],
            [
              '基址扫描',
              senderStatus?.baseAddress || (senderStatus?.baseAddressReady ? '已完成' : '未完成')
            ],
            ['文字 Hook', senderStatus?.textHookReady ? '已就绪' : '未就绪'],
            ['图片 Hook', senderStatus?.imageHookReady ? '已就绪' : '未就绪'],
            ['语音能力', senderStatus?.canSendVoice ? '可发送' : '未就绪'],
            ['消息监听', senderStatus?.messageListenerReady ? '正常' : '未就绪'],
            ['微信版本', diagnosticValue(senderStatus?.wechatVersion)],
            [
              '运行时',
              runtimeStatus?.version
                ? `${runtimeStatus.version} · ${runtimeStatus.state}`
                : diagnosticValue(senderStatus?.runtimeReady)
            ]
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  )
}
