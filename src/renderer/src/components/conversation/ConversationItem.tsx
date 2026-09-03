import React, { useState } from 'react'
import { Contact } from '../../../../shared/types'

interface ConversationItemProps {
  contact: Contact
  active: boolean
  onSelect: (contact: Contact) => void
}

export function ConversationItem({
  contact,
  active,
  onSelect
}: ConversationItemProps): React.ReactElement {
  const nickname = contact.m_nsNickName?.trim()
  const avatarUsername = contact.m_nsUsrName
  const internalWxid = contact.wxid || avatarUsername
  const displayName = nickname || internalWxid || '未命名会话'
  const initial = (displayName || internalWxid || '?').charAt(0)
  const [repairedAvatar, setRepairedAvatar] = useState<{
    username: string
    source: string
    replaces: string
  }>()
  const [failedAvatar, setFailedAvatar] = useState<{ username: string; source: string }>()
  const repairedSource =
    repairedAvatar?.username === avatarUsername && repairedAvatar.replaces === contact.avatar
      ? repairedAvatar.source
      : undefined
  const avatar = repairedSource || contact.avatar
  const avatarFailed = failedAvatar?.username === avatarUsername && failedAvatar.source === avatar

  const handleAvatarError = (): void => {
    if (!avatar || avatarFailed) return
    setFailedAvatar({ username: avatarUsername, source: avatar })
    if (avatar.startsWith('data:')) return
    void window.api
      .getContactAvatars([avatarUsername], { refresh: true })
      .then((avatars) => {
        const fallback = avatars[avatarUsername]
        if (!fallback || fallback === avatar) return
        setRepairedAvatar({ username: avatarUsername, source: fallback, replaces: avatar })
        setFailedAvatar(undefined)
      })
      .catch(() => undefined)
  }

  return (
    <button
      type="button"
      className={`conversation-item ${active ? 'active' : ''}`}
      onClick={() => onSelect(contact)}
      title={
        contact.wechatId ||
        contact.alias ||
        (internalWxid !== displayName ? internalWxid : displayName)
      }
    >
      <span className="conversation-item-active-mark" aria-hidden />
      <span className="conversation-item-avatar">
        {avatar && !avatarFailed ? (
          <img
            src={avatar}
            alt={displayName}
            referrerPolicy="no-referrer"
            loading="lazy"
            decoding="async"
            onError={handleAvatarError}
          />
        ) : (
          initial
        )}
      </span>
      <span className="conversation-item-body">
        <span className="conversation-item-name">{displayName}</span>
        {contact.wechatId && (
          <span className="conversation-item-meta">微信号: {contact.wechatId}</span>
        )}
      </span>
    </button>
  )
}
