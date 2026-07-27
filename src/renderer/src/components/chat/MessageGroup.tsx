import React from 'react'
import { Contact } from '../../../../shared/types'
import { MessageBubble } from './MessageBubble'
import { MessageGroupModel } from './messageGrouping'

interface MessageGroupProps {
  group: MessageGroupModel
  contact: Contact
  isGroupChat: boolean
  showAvatar: boolean
  onImageClick: (imageUrl: string) => void
}

export function MessageGroup({
  group,
  contact,
  isGroupChat,
  showAvatar,
  onImageClick
}: MessageGroupProps): React.ReactElement {
  const firstMessage = group.messages[0]

  if (group.isSystem) {
    return (
      <>
        {group.timeLabel && <div className="chat-time-separator">{group.timeLabel}</div>}
        {group.messages.map((message) => (
          <div key={message.id} className="wechat-system-message-row">
            <div className="wechat-system-message">{message.content}</div>
          </div>
        ))}
      </>
    )
  }

  const isMine = group.isMine
  const displayName = isMine
    ? '我'
    : isGroupChat
      ? firstMessage.name || firstMessage.from
      : contact.m_nsNickName
  const avatarSrc = isMine ? firstMessage.img : firstMessage.img || contact.avatar
  const shouldShowAvatar = showAvatar

  return (
    <>
      {group.timeLabel && <div className="chat-time-separator">{group.timeLabel}</div>}
      <div className={`wechat-message-row ${isMine ? 'mine' : 'other'} grouped`}>
        {!isMine && shouldShowAvatar && (
          <div className="message-avatar">
            {avatarSrc ? (
              <img src={avatarSrc} alt={displayName} referrerPolicy="no-referrer" />
            ) : (
              (displayName || '?').charAt(0)
            )}
          </div>
        )}
        {!isMine && !shouldShowAvatar && <div className="message-avatar-spacer" aria-hidden />}
        <div className="message-stack">
          {!isMine && isGroupChat && (
            <div className="message-sender-name">{displayName}</div>
          )}
          {group.messages.map((message, index) => (
            <MessageBubble
              key={message.id}
              message={message}
              contact={contact}
              isGroupChat={isGroupChat}
              isMine={isMine}
              showAvatarSpace={index === 0}
              onImageClick={onImageClick}
            />
          ))}
        </div>
        {isMine && shouldShowAvatar && (
          <div className="message-avatar mine-avatar">
            {avatarSrc ? <img src={avatarSrc} alt="我" referrerPolicy="no-referrer" /> : '我'}
          </div>
        )}
        {isMine && !shouldShowAvatar && <div className="message-avatar-spacer" aria-hidden />}
      </div>
    </>
  )
}
