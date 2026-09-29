import type { PersonalWechatSenderStatus } from '../../../../shared/personal-wechat'
import { Button } from '../ui'

const GROUP_README_URL = 'https://github.com/Wxw-Gu/TraceMemo#-交流与反馈'

interface PersonalWechatSetupGuideProps {
  senderStatus: PersonalWechatSenderStatus | null
  binding: boolean
  detecting: boolean
  sessionBound: boolean
  onBind: () => void
  onStartSending: () => void
  onOpenTextToSpeechSettings?: () => void
}

function capabilityLabel(ready: boolean, initializing: boolean): string {
  if (ready) return '已就绪'
  return initializing ? '初始化中' : '未就绪'
}

function bindingHint(status: PersonalWechatSenderStatus): string {
  if (status.state === 'wechat_not_running') {
    return '请保持微信未登录窗口状态，点击“绑定微信”后，再点击微信窗口登录。'
  }
  if (status.state === 'unsupported_platform') return '当前系统暂不支持个人微信发送。'
  if (status.state === 'unsupported_version')
    return '当前微信版本暂不支持，请联系群主确认可用版本。'
  if (status.state === 'runtime_missing') {
    return '请先完成发送运行时准备。'
  }
  if (status.state === 'error') return '连接微信时遇到问题，请稍后重试。'
  return '请保持微信未登录窗口状态，点击“绑定微信”后，再点击微信窗口登录。'
}

function isWechatBound(status: PersonalWechatSenderStatus): boolean {
  return Boolean(
    status.wechatPid &&
    status.boundWechatPid === status.wechatPid &&
    status.attachReady &&
    status.baseAddressReady
  )
}

export function PersonalWechatSetupGuide({
  senderStatus,
  binding,
  detecting,
  sessionBound,
  onBind,
  onStartSending,
  onOpenTextToSpeechSettings
}: PersonalWechatSetupGuideProps): React.ReactElement {
  const runtimeUnavailable = senderStatus?.state === 'runtime_missing'
  const runtimeLabel = '发送运行时'
  const runtimeReady = senderStatus?.runtimeReady === true
  const connected = sessionBound && (senderStatus ? isWechatBound(senderStatus) : false)
  const canSendVoice = Boolean(senderStatus?.canSendVoice)
  const initializing = connected && !canSendVoice && senderStatus?.state !== 'error'
  const allReady = connected && Boolean(senderStatus?.canSend)

  return (
    <section className="personal-wechat-setup" aria-label="微信消息功能配置">
      <div className="personal-wechat-setup-heading">
        <div>
          <span className="personal-wechat-eyebrow">首次使用</span>
          <h2>先准备好微信消息功能</h2>
          <p>只需几步，TraceMemo 就能在当前会话中生成并发送语音。</p>
        </div>
        {allReady && <span className="personal-wechat-setup-complete">已完成</span>}
      </div>

      <ol className="personal-wechat-steps">
        <li className={runtimeReady ? 'is-complete' : 'is-current'}>
          <span className="personal-wechat-step-number">{runtimeReady ? '✓' : '1'}</span>
          <div className="personal-wechat-step-content">
            <strong>准备 {runtimeLabel}</strong>
            <p>
              {runtimeUnavailable
                ? `个人微信发送需要${runtimeLabel}，授权后即可使用。`
                : `${runtimeLabel}随 TraceMemo 一起提供，无需额外安装。`}
            </p>
            {runtimeReady ? (
              <span className="personal-wechat-step-status">✓ {runtimeLabel}已就绪</span>
            ) : runtimeUnavailable ? (
              <span className="personal-wechat-step-error">当前版本暂未提供微信消息发送功能</span>
            ) : (
              <span className="personal-wechat-step-status">正在检查 {runtimeLabel}…</span>
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
            <p>请保持微信未登录窗口状态，点击“绑定微信”后，再点击微信窗口登录。</p>
            {connected ? (
              <span className="personal-wechat-step-status">✓ 微信已绑定</span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={onBind}
                disabled={runtimeUnavailable || !runtimeReady || binding}
              >
                {binding ? '正在绑定…' : '绑定微信'}
              </Button>
            )}
            {!connected && senderStatus && !runtimeUnavailable && (
              <p className="personal-wechat-step-hint">{bindingHint(senderStatus)}</p>
            )}
            {!connected && runtimeUnavailable && (
              <div className="personal-wechat-authorization-warning" role="alert">
                <span aria-hidden>!</span>
                <p>
                  发送能力属授权制，需要联系群主。请先加入交流群，然后在群内添加群主申请授权。
                  进群请点击{' '}
                  <a href={GROUP_README_URL} target="_blank" rel="noreferrer">
                    这里
                  </a>{' '}
                  跳转。
                </p>
              </div>
            )}
            {!connected && !runtimeUnavailable && (
              <p className="personal-wechat-step-warning" role="note">
                绑定微信可能导致当前微信异常闪退，这是正常现象。若微信退出，请重新启动微信后，再回到这里重新检测/绑定。
                <br />
                微信总是自动更新？请在微信左下角打开“设置 →
                通用”，取消勾选“有更新时自动升级微信”，否则版本变化后可能无法绑定。
              </p>
            )}
          </div>
        </li>

        <li className={allReady ? 'is-complete' : connected ? 'is-current' : 'is-pending'}>
          <span className="personal-wechat-step-number">{allReady ? '✓' : '3'}</span>
          <div className="personal-wechat-step-content">
            <strong>初始化发送能力</strong>
            <p>绑定微信后，TraceMemo 会自动完成文字、图片和语音发送所需的初始化。</p>
            {initializing && (
              <p className="personal-wechat-step-hint" role="status">
                {detecting ? '正在初始化发送能力…' : '正在等待发送运行时完成初始化…'}
              </p>
            )}
            {senderStatus?.state === 'error' && (
              <p className="personal-wechat-step-hint" role="status">
                {senderStatus.message || '发送能力初始化失败，请重新绑定。'}
              </p>
            )}
          </div>
        </li>

        <li className={allReady ? 'is-complete' : initializing ? 'is-current' : 'is-pending'}>
          <span className="personal-wechat-step-number">{allReady ? '✓' : '4'}</span>
          <div className="personal-wechat-step-content">
            <strong>能力检测</strong>
            <div className="personal-wechat-capabilities" aria-label="微信消息能力">
              {[
                ['文字消息', Boolean(senderStatus?.canSendText)],
                ['图片消息', Boolean(senderStatus?.canSendImage)],
                ['语音消息', canSendVoice]
              ].map(([label, ready]) => (
                <span key={String(label)} className={ready ? 'is-ready' : ''}>
                  <b aria-hidden>{ready ? '✓' : '−'}</b>
                  {label}
                  <small>{capabilityLabel(Boolean(ready), initializing)}</small>
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
            ) : initializing ? (
              <p className="personal-wechat-step-hint" role="status">
                发送能力准备完成后会自动进入已就绪状态。
              </p>
            ) : null}
          </div>
        </li>
      </ol>

      {!runtimeReady && runtimeUnavailable && onOpenTextToSpeechSettings && (
        <Button
          variant="link"
          size="sm"
          className="personal-wechat-setup-link"
          onClick={onOpenTextToSpeechSettings}
        >
          查看语音设置
        </Button>
      )}
    </section>
  )
}
