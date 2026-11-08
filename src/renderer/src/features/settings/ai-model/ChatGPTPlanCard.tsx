import { useEffect, useState } from 'react'
import type { ChatGPTPlanStatus } from '../../../../../shared/chatgpt-plan'
import { Button } from '../../../components/ui'

export function ChatGPTPlanCard({ onChange }: { onChange: () => void }): React.ReactElement {
  const [status, setStatus] = useState<ChatGPTPlanStatus>({ profiles: [], sharing: false })
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState('')
  const active = status.profiles.find((profile) => profile.id === status.profileId)

  useEffect(() => {
    if (!window.api.getChatGPTPlanStatus) return
    void window.api
      .getChatGPTPlanStatus()
      .then(setStatus)
      .catch(() => {
        setResult('无法读取 ChatGPT 连接。')
      })
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
      setResult(
        response.success && response.data?.trim()
          ? `订阅推理成功（${model.modelName}）`
          : response.error || '模型没有返回文字。'
      )
    } catch {
      setResult('无法获取 ChatGPT 模型。')
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="settings-card ai-provider-empty">
      <h2>ChatGPT 订阅</h2>
      <p>授权使用 ChatGPT 订阅后，可以在手动生成群聊日报时选择订阅模型。</p>
      {active && (
        <p>
          {active.email || active.label} ·{' '}
          {status.sharing
            ? '已授权使用订阅'
            : active.status === 'connected'
              ? '已登录，未授权使用订阅'
              : '待登录'}
        </p>
      )}
      <Button
        disabled={Boolean(busy)}
        onClick={() => void change('sign-in', () => window.api.signInChatGPTPlan())}
      >
        Continue with ChatGPT
      </Button>{' '}
      {busy === 'sign-in' && (
        <Button onClick={() => void window.api.cancelChatGPTPlanSignIn()}>取消登录</Button>
      )}
      {status.sharing && (
        <Button disabled={Boolean(busy)} onClick={() => void test()}>
          测试订阅推理
        </Button>
      )}{' '}
      {active?.status === 'connected' && (
        <Button
          disabled={Boolean(busy)}
          onClick={() => void change('disconnect', () => window.api.disconnectChatGPTPlan())}
        >
          断开连接
        </Button>
      )}{' '}
      <Button
        disabled={Boolean(busy)}
        onClick={() => {
          void window.api
            .openChatGPTPlanUsage()
            .catch(() => setResult('无法打开 ChatGPT 用量设置。'))
        }}
      >
        管理用量
      </Button>
      {status.profiles.map((profile) => (
        <div key={profile.id}>
          <span>
            {profile.label}
            {profile.email ? `（${profile.email}）` : ''}
          </span>{' '}
          {profile.id !== status.profileId &&
            profile.status === 'connected' &&
            !profile.pending && (
              <Button
                disabled={Boolean(busy)}
                onClick={() =>
                  void change('select', () => window.api.selectChatGPTPlan(profile.id))
                }
              >
                切换
              </Button>
            )}{' '}
          {!profile.sharing && (
            <Button
              disabled={Boolean(busy)}
              onClick={() =>
                void change('sign-in', () =>
                  window.api.signInChatGPTPlan(profile.id, profile.status === 'connected')
                )
              }
            >
              {profile.status === 'connected' ? '授权使用订阅' : '重新登录'}
            </Button>
          )}
        </div>
      ))}
      {(result || status.error) && <p role="status">{result || status.error}</p>}
    </section>
  )
}
