import React from 'react'
import type {
  AgentHubConversationMessage,
  AgentHubConversationSummary
} from '../../../../shared/agent-hub-conversation'
import { agentHubKindPlaceholder } from '../../../../shared/agent-hub-conversation'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button
} from '../../components/ui'

export interface AgentHubConversationPanelSelfInfo {
  wxid: string
  nickname: string
  avatar?: string
}

interface AgentHubConversationPanelProps {
  selfInfo: AgentHubConversationPanelSelfInfo | null
  /** 机器人账号对应的微信用户标识；与入站 from_user_id 相同即为"本机自己"。 */
  selfUserId?: string
}

/**
 * 机器人头像。
 *
 * iLink 只给 openid，拿不到真实头像，所以这里用固定的品牌色矢量头像，
 * 让"右侧是机器人"一眼可辨，且不依赖任何外部资源。
 */
function AgentHubBotAvatar({ size = 32 }: { size?: number }): React.ReactElement {
  return (
    <span className="agent-hub-bot-avatar" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} role="presentation">
        <rect x="4.5" y="8" width="15" height="11" rx="3" fill="currentColor" />
        <rect x="11" y="3.6" width="2" height="3.4" rx="1" fill="currentColor" />
        <circle cx="12" cy="3.2" r="1.4" fill="currentColor" />
        <circle cx="9.2" cy="12.6" r="1.5" fill="var(--wxex-bg-elevated)" />
        <circle cx="14.8" cy="12.6" r="1.5" fill="var(--wxex-bg-elevated)" />
        <rect x="9.4" y="16" width="5.2" height="1.4" rx="0.7" fill="var(--wxex-bg-elevated)" />
      </svg>
    </span>
  )
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatConversationTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const date = new Date(timestamp)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (timestamp >= startOfToday) return `今天 ${formatClock(timestamp)}`
  if (timestamp >= startOfToday - 24 * 60 * 60 * 1000) return `昨天 ${formatClock(timestamp)}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${formatClock(timestamp)}`
}

/** 去掉 @im.wechat 之类的后缀并截断，避免把完整 openid 铺在界面上。 */
function shortenUserId(userId: string): string {
  const bare = userId.split('@')[0]
  if (bare.length <= 10) return bare
  return `${bare.slice(0, 4)}…${bare.slice(-4)}`
}

interface ConversationIdentity {
  name: string
  avatar?: string
  initial: string
  isSelf: boolean
}

function resolveIdentity(
  userId: string,
  selfInfo: AgentHubConversationPanelSelfInfo | null,
  selfUserId?: string
): ConversationIdentity {
  // 扫码登录的那个人 == 跟机器人聊天的这个人：直接复用左下角账号的头像与昵称。
  if (selfUserId && userId === selfUserId) {
    const name = selfInfo?.nickname?.trim() || '我自己'
    return {
      name,
      ...(selfInfo?.avatar ? { avatar: selfInfo.avatar } : {}),
      initial: name.charAt(0),
      isSelf: true
    }
  }
  return { name: `微信用户 ${shortenUserId(userId)}`, initial: '微', isSelf: false }
}

function ConversationAvatar({
  identity,
  size = 36
}: {
  identity: ConversationIdentity
  size?: number
}): React.ReactElement {
  if (identity.avatar) {
    return (
      <img
        className="agent-hub-conversation-avatar"
        style={{ width: size, height: size }}
        src={identity.avatar}
        alt=""
        referrerPolicy="no-referrer"
      />
    )
  }
  return (
    <span
      className={`agent-hub-conversation-avatar is-fallback ${identity.isSelf ? 'is-self' : ''}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {identity.initial}
    </span>
  )
}

function messageBody(message: AgentHubConversationMessage): string {
  return message.text.trim() || agentHubKindPlaceholder(message.kind)
}

/**
 * Agent Hub 对话记录。
 *
 * 左侧是会话列表（默认就是本机账号自己），右侧是仿微信的收发气泡：
 * 对方在左、机器人在右。数据来自本机 `conversations.json`，不经过任何外部服务。
 */
export function AgentHubConversationPanel({
  selfInfo,
  selfUserId
}: AgentHubConversationPanelProps): React.ReactElement {
  const [summaries, setSummaries] = React.useState<AgentHubConversationSummary[]>([])
  const [selectedUserId, setSelectedUserId] = React.useState<string | null>(null)
  const [messages, setMessages] = React.useState<AgentHubConversationMessage[]>([])
  const [confirmingClear, setConfirmingClear] = React.useState(false)
  const bodyRef = React.useRef<HTMLDivElement>(null)
  // 用 ref 跟踪当前选中会话：推送回调里不能依赖闭包里的 selectedUserId，
  // 也不能在 setState 的 updater 里塞副作用（StrictMode 下会执行两次）。
  const selectedRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    let mounted = true
    void window.api.getAgentHubConversations().then((items) => {
      if (!mounted) return
      setSummaries(items)
      setSelectedUserId((current) => current ?? items[0]?.userId ?? null)
    })
    const unsubscribe = window.api.onAgentHubConversation(({ summary, message }) => {
      if (!mounted) return
      setSummaries((current) => {
        const withoutThis = current.filter((item) => item.userId !== summary.userId)
        return [summary, ...withoutThis].sort((left, right) => right.lastAt - left.lastAt)
      })
      if (selectedRef.current === null) setSelectedUserId(summary.userId)
      else if (selectedRef.current === summary.userId) setMessages((list) => [...list, message])
    })
    const unsubscribeCleared = window.api.onAgentHubConversationsCleared(() => {
      if (!mounted) return
      setSummaries([])
      setMessages([])
      setSelectedUserId(null)
    })
    return () => {
      mounted = false
      unsubscribe()
      unsubscribeCleared()
    }
  }, [])

  React.useEffect(() => {
    selectedRef.current = selectedUserId
    if (!selectedUserId) {
      setMessages([])
      return
    }
    let mounted = true
    void window.api.getAgentHubConversation(selectedUserId).then((conversation) => {
      if (mounted) setMessages(conversation?.messages ?? [])
    })
    return () => {
      mounted = false
    }
  }, [selectedUserId])

  React.useEffect(() => {
    const body = bodyRef.current
    if (body) body.scrollTop = body.scrollHeight
  }, [messages.length, selectedUserId])

  const totalCount = summaries.reduce((sum, item) => sum + item.messageCount, 0)
  const selectedIdentity = selectedUserId
    ? resolveIdentity(selectedUserId, selfInfo, selfUserId)
    : null

  const clearConversations = async (): Promise<void> => {
    await window.api.clearAgentHubConversations()
    setSummaries([])
    setMessages([])
    setSelectedUserId(null)
  }

  return (
    <section className="agent-hub-card agent-hub-conversation-card">
      <div className="agent-hub-conversation-heading">
        <div>
          <span className="agent-hub-card-kicker">收发记录</span>
          <h2>对话记录</h2>
        </div>
        <div className="agent-hub-conversation-actions">
          <span className="agent-hub-conversation-count">
            {summaries.length} 个会话 · {totalCount} 条
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={totalCount === 0}
            onClick={() => setConfirmingClear(true)}
          >
            清空记录
          </Button>
        </div>
      </div>

      <div className="agent-hub-conversation-body">
        <div className="agent-hub-conversation-list">
          {summaries.length === 0 ? (
            <div className="agent-hub-conversation-list-empty">
              还没有收发记录。机器人收到或发出消息后，这里会显示完整内容。
            </div>
          ) : (
            summaries.map((summary) => {
              const identity = resolveIdentity(summary.userId, selfInfo, selfUserId)
              return (
                <button
                  type="button"
                  key={summary.userId}
                  className={`agent-hub-conversation-item ${
                    summary.userId === selectedUserId ? 'is-active' : ''
                  }`}
                  onClick={() => setSelectedUserId(summary.userId)}
                >
                  <ConversationAvatar identity={identity} />
                  <span className="agent-hub-conversation-item-copy">
                    <span className="agent-hub-conversation-item-name">{identity.name}</span>
                    <span className="agent-hub-conversation-item-preview">
                      {summary.lastDirection === 'out' ? '机器人：' : ''}
                      {summary.lastPreview || '（空消息）'}
                    </span>
                  </span>
                  <span className="agent-hub-conversation-item-time">
                    {formatConversationTime(summary.lastAt)}
                  </span>
                </button>
              )
            })
          )}
        </div>

        <div className="agent-hub-conversation-thread" ref={bodyRef}>
          {!selectedIdentity || messages.length === 0 ? (
            <div className="agent-hub-conversation-thread-empty">
              {summaries.length === 0
                ? '左侧出现会话后，这里会显示完整对话。'
                : '这个会话还没有消息。'}
            </div>
          ) : (
            messages.map((message) => (
              <div
                className={`agent-hub-message ${message.direction === 'out' ? 'is-out' : 'is-in'}`}
                key={message.id}
              >
                {message.direction === 'out' ? (
                  <AgentHubBotAvatar />
                ) : (
                  <ConversationAvatar identity={selectedIdentity} size={32} />
                )}
                <div className="agent-hub-message-main">
                  <div className="agent-hub-message-bubble">{messageBody(message)}</div>
                  <div className="agent-hub-message-meta">
                    <span>{formatConversationTime(message.createdAt)}</span>
                    {message.direction === 'out' && (
                      <span className={message.status === 'failed' ? 'is-failed' : ''}>
                        {message.status === 'failed'
                          ? `发送失败${message.errorCode ? `（${message.errorCode}）` : ''}`
                          : '已发送'}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <AlertDialog open={confirmingClear} onOpenChange={setConfirmingClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清空对话记录？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除本机保存的全部机器人收发记录。这不影响微信里的原始消息，也不影响运行日志。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void clearConversations()}
            >
              确认清空
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
