import { useEffect, useState } from 'react'
import type { ChatGPTPlanStatus } from '../../../../../shared/chatgpt-plan'
import { Button } from '../../../components/ui'

export function ChatGPTPlanCard({ onChange }: { onChange: () => void }): React.ReactElement {
  const [status, setStatus] = useState<ChatGPTPlanStatus>({ profiles: [], sharing: false })
  const [busy, setBusy] = useState('loading')
  const [result, setResult] = useState('')
  const active = status.profiles.find((profile) => profile.id === status.profileId)

  useEffect(() => {
    if (!window.api.getChatGPTPlanStatus) {
      setBusy('')
      return
    }
    void window.api
      .getChatGPTPlanStatus()
      .then(setStatus)
      .catch(() => {
        setResult('无法读取 ChatGPT 连接。')
      })
      .finally(() => setBusy(''))
  }, [])

  async function change(label: string, operation: () => Promise<ChatGPTPlanStatus>): Promise<void> {
    setBusy(label)
    setResult('')
    try {
      setStatus(await operation())
      onChange()
    } catch {
      setResult('ChatGPT 连接操作失败。')
    } finally {
      setBusy('')
    }
  }

  async function test(): Promise<void> {
    setBusy('test')
    setResult('')
    try {
      const [model] = await window.api.listChatGPTPlanModels()
      if (!model) {
        setResult('当前账号没有可用模型。')
        return
      }
      const response = await window.api.testChatGPTPlan(model.providerId, model.model)
      if (response.success && response.data?.trim()) onChange()
      setResult(
        response.success && response.data?.trim()
          ? `订阅推理成功（${model.modelName}）`
          : response.error || '模型没有返回文字。'
      )
    } catch {
      setResult('无法加载订阅模型。请等当前连接操作完成后重试。')
    } finally {
      setBusy('')
    }
  }

  const signIn = (profileId?: string, reconsent?: boolean): void => {
    void change('sign-in', () => window.api.signInChatGPTPlan(profileId, reconsent))
  }
  const activeLabel = status.sharing
    ? '订阅已授权'
    : active?.status === 'connected'
      ? '待授权'
      : active
        ? '待登录'
        : '未连接'

  return (
    <section className="settings-card chatgpt-plan-card">
      <header>
        <div>
          <h2>ChatGPT 订阅</h2>
          <p>用于手动群聊日报的文字总结。授权后，在日报页选择订阅模型。</p>
        </div>
        <span className={`settings-status-badge ${status.sharing ? '' : 'unavailable'}`}>
          {busy === 'loading' ? '正在读取' : activeLabel}
        </span>
      </header>
      <div className="chatgpt-plan-actions">
        {status.sharing ? (
          <Button disabled={Boolean(busy)} onClick={() => void test()}>
            {busy === 'test' ? '正在测试…' : '测试订阅推理'}
          </Button>
        ) : (
          <Button
            disabled={Boolean(busy)}
            onClick={() => signIn(active?.id, active?.status === 'connected')}
          >
            {active
              ? active.status === 'connected'
                ? '授权使用订阅'
                : '重新登录'
              : 'Continue with ChatGPT'}
          </Button>
        )}
        {busy === 'sign-in' && (
          <Button variant="outline" onClick={() => void window.api.cancelChatGPTPlanSignIn()}>
            取消登录
          </Button>
        )}
        {active?.status === 'connected' && (
          <Button
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => void change('disconnect', () => window.api.disconnectChatGPTPlan())}
          >
            断开当前连接
          </Button>
        )}
        <Button
          variant="outline"
          disabled={Boolean(busy)}
          onClick={() => {
            void window.api
              .openChatGPTPlanUsage()
              .catch(() => setResult('无法打开 ChatGPT 用量设置。'))
          }}
        >
          管理用量
        </Button>
      </div>
      {status.profiles.length > 0 && (
        <ul className="chatgpt-plan-connections" aria-label="已保存的连接">
          {status.profiles.map((profile) => {
            const isActive = profile.id === status.profileId
            return (
              <li key={profile.id}>
                <div>
                  <strong>{profile.email || profile.label}</strong>
                  <small>
                    {profile.label} ·{' '}
                    {isActive ? '当前连接' : profile.sharing ? '订阅已授权' : '待恢复'}
                  </small>
                </div>
                {!isActive && profile.status === 'connected' && !profile.pending && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void change('select', () => window.api.selectChatGPTPlan(profile.id))
                    }
                  >
                    切换
                  </Button>
                )}
                {!isActive && (profile.status !== 'connected' || profile.pending) && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(busy)}
                    onClick={() => signIn(profile.id)}
                  >
                    重新登录
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {status.profiles.length > 0 && (
        <Button variant="outline" disabled={Boolean(busy)} onClick={() => signIn()}>
          添加其他连接
        </Button>
      )}
      {(result || status.error) && <p role="status">{result || status.error}</p>}
    </section>
  )
}
