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
  const wxid = contact.m_nsUsrName
  const displayName = nickname || wxid || '未命名会话'
  const initial = (displayName || wxid || '?').charAt(0)
  const [repairedAvatar, setRepairedAvatar] = useState<{ username: string; source: string }>()
  const [failedAvatar, setFailedAvatar] = useState<{ username: string; source: string }>()
  const repairedSource = repairedAvatar?.username === wxid ? repairedAvatar.source : undefined
  const avatar = repairedSource || contact.avatar
  const avatarFailed = failedAvatar?.username === wxid && failedAvatar.source === avatar

  const handleAvatarError = (): void => {
    if (!avatar || avatarFailed) return
    setFailedAvatar({ username: wxid, source: avatar })
    if (contact.type !== 'group' || avatar.startsWith('data:')) return
    void window.api
      .getContactAvatars([wxid])
      .then((avatars) => {
        const fallback = avatars[wxid]
        if (!fallback || fallback === avatar) return
        setRepairedAvatar({ username: wxid, source: fallback })
        setFailedAvatar(undefined)
      })
      .catch(() => undefined)
  }

  return (
    <button
      type="button"
      className={`conversation-item ${active ? 'active' : ''}`}
      onClick={() => onSelect(contact)}
      title={wxid && wxid !== displayName ? wxid : displayName}
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
      </span>
    </button>
  )
}
