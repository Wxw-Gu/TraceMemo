import React from 'react'
import { Button, Switch } from '../ui'
import { RefreshIcon } from './icons'

interface ChatStatusBarProps {
  count: number
  showAvatar: boolean
  isAtLatest: boolean
  isReloadingAvatars: boolean
  onShowAvatarChange: (show: boolean) => void
  onReloadAvatars: () => void
  onJumpToLatest: () => void
}

export function ChatStatusBar({
  count,
  showAvatar,
  isAtLatest,
  isReloadingAvatars,
  onShowAvatarChange,
  onReloadAvatars,
  onJumpToLatest
}: ChatStatusBarProps): React.ReactElement {
  const jumpDisabled = isAtLatest || count === 0

  return (
    <div className="chat-status-bar">
      <div>已显示当前范围 {count} 条消息</div>
      <div className="chat-status-actions">
        <label className="chat-avatar-toggle">
          <Switch checked={showAvatar} onCheckedChange={onShowAvatarChange} aria-label="显示头像" />
          <span>显示头像</span>
        </label>
        <span
          className="chat-avatar-note"
          title="头像或名称缺失时，请先在微信中进入该聊天，再尝试重新加载"
        >
          头像或名称缺失时，请先在微信中进入该聊天
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="chat-avatar-reload"
          onClick={onReloadAvatars}
          disabled={isReloadingAvatars}
          title="尝试重新加载当前聊天的头像和名称"
          aria-busy={isReloadingAvatars}
        >
          <RefreshIcon className={isReloadingAvatars ? 'is-spinning' : ''} />
          <span>{isReloadingAvatars ? '加载中' : '重新加载头像'}</span>
        </Button>
        <span className="chat-status-separator" aria-hidden />
        <Button variant="ghost" size="sm" onClick={onJumpToLatest} disabled={jumpDisabled}>
          {jumpDisabled ? '已是最新消息' : '跳转到最新消息'}
        </Button>
      </div>
    </div>
  )
}
