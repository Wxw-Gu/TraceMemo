import type { DatabaseKeyState } from './types'
import { runtimePlatform } from '../../../utils/runtime-environment'
import { Button } from '../../../components/ui'

const DEFAULT_PHASES = ['查找微信进程', '识别微信版本', '扫描候选密钥', '验证数据库', '获取完成']
const MAC_PHASES = ['查找微信进程', '等待管理员授权', '监听登录密钥', '验证数据库', '获取完成']

export function DatabaseKeyAutoDetect({
  state,
  disabled,
  onDetect,
  onRefresh
}: {
  state: DatabaseKeyState
  disabled: boolean
  onDetect: () => void
  onRefresh: () => void
}): React.ReactElement {
  const environment = state.environment
  const platform = environment?.platform || runtimePlatform
  const supported =
    environment?.autoDetectSupported ?? (platform === 'win32' || platform === 'darwin')
  if (!supported) {
    return (
      <section className="settings-card database-key-auto database-key-auto-manual">
        <div>
          <strong>当前平台需要手动输入数据库密钥。</strong>
          <p>自动获取未在此平台开放，可继续使用手动验证与系统安全存储。</p>
        </div>
      </section>
    )
  }
  const isMac = platform === 'darwin'
  const phases = isMac ? MAC_PHASES : DEFAULT_PHASES
  return (
    <section className="settings-card database-key-auto">
      <div className="database-key-auto-heading">
        <div>
          <strong>{isMac ? 'macOS 自动获取' : 'Windows 自动获取'}</strong>
          <p>
            TraceMemo 可在微信桌面端运行时，通过本机内存扫描尝试获取数据库密钥。
            {isMac
              ? '执行时会请求管理员授权；授权后在微信登录界面点击“登录”即可，已有登录凭据时通常不需要扫码。监听最长两分钟，结束后会明确显示结果。'
              : ''}
          </p>
        </div>
        <Button variant="outline" onClick={onDetect} disabled={disabled}>
          {state.status === 'auto-detecting' ? '正在获取…' : '自动获取密钥'}
        </Button>
      </div>
      <ul className="database-key-prerequisites">
        <li className={environment?.wechatRunning ? 'ok' : ''}>
          微信进程：{environment?.wechatRunning ? '正在运行' : '未检测到'}
        </li>
        <li className={environment?.accountIdentified ? 'ok' : ''}>
          当前账号：{environment?.accountIdentified ? '已识别' : '尚未识别'}
        </li>
        <li className={supported ? 'ok' : ''}>当前平台：{supported ? '支持' : '不支持'}</li>
      </ul>
      {state.status === 'auto-detecting' && (
        <ol className="database-key-phases">
          {phases.map((phase, index) => (
            <li key={phase} className={state.autoPhase >= index + 1 ? 'active' : ''}>
              {phase}
            </li>
          ))}
        </ol>
      )}
      {state.status === 'auto-detect-error' && (
        <div className="database-key-auto-error">
          <strong>暂未找到有效密钥</strong>
          <span>{state.error}</span>
          <p>
            {isMac
              ? '请先让微信停留在登录界面，点击自动获取并完成管理员授权，然后点击微信“登录”。'
              : '请保持微信正在运行，登录目标账号并打开几个聊天窗口后重试。'}
          </p>
          <Button
            variant="link"
            size="sm"
            className="h-auto justify-self-start p-0"
            onClick={onRefresh}
          >
            刷新前置状态
          </Button>
        </div>
      )}
    </section>
  )
}
