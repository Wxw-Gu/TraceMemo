import type { DatabaseKeyState } from './types'

const PHASES = ['查找微信进程', '识别微信版本', '扫描候选密钥', '验证数据库', '获取完成']

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
  const platform = environment?.platform || window.electron.process.platform
  if (platform !== 'win32') {
    return (
      <section className="settings-card database-key-auto database-key-auto-manual">
        <div>
          <strong>当前 macOS 版本需要手动输入数据库密钥。</strong>
          <p>自动获取未在此平台开放，这不会影响手动验证与系统安全存储。</p>
        </div>
      </section>
    )
  }
  return (
    <section className="settings-card database-key-auto">
      <div className="database-key-auto-heading">
        <div>
          <strong>Windows 自动获取</strong>
          <p>TraceMemo 可在微信桌面端正在运行时，通过本机内存扫描尝试获取数据库密钥。</p>
        </div>
        <button
          type="button"
          className="database-key-secondary"
          onClick={onDetect}
          disabled={disabled}
        >
          {state.status === 'auto-detecting' ? '正在获取…' : '自动获取密钥'}
        </button>
      </div>
      <ul className="database-key-prerequisites">
        <li className={environment?.wechatRunning ? 'ok' : ''}>
          微信进程：{environment?.wechatRunning ? '正在运行' : '未检测到'}
        </li>
        <li className={environment?.accountIdentified ? 'ok' : ''}>
          当前账号：{environment?.accountIdentified ? '已识别' : '尚未识别'}
        </li>
        <li className={platform === 'win32' ? 'ok' : ''}>
          当前平台：{platform === 'win32' ? '支持' : '不支持'}
        </li>
      </ul>
      {state.status === 'auto-detecting' && (
        <ol className="database-key-phases">
          {PHASES.map((phase, index) => (
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
          <p>请保持微信正在运行，登录目标账号并打开几个聊天窗口后重试。</p>
          <button type="button" onClick={onRefresh}>
            刷新前置状态
          </button>
        </div>
      )}
    </section>
  )
}
