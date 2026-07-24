import React from 'react'
import { Contact, Message } from '../../../../shared/types'
import { ImageBubble } from '../ImageBubble'
import { RichMessageBubble } from '../RichMessageBubble'
import { VoicePlayer } from '../VoicePlayer'
import { renderWechatEmojiText } from '../../utils/wechatEmojiText'
import { formatMessageTime } from './messageGrouping'

interface MessageBubbleProps {
  message: Message
  contact: Contact
  isGroupChat: boolean
  isMine: boolean
  showAvatarSpace: boolean
  onImageClick: (imageUrl: string) => void
}

const RICH_MESSAGE_TYPES = ['名片', '位置', '分享消息', '通话', '表情包', '系统消息']

export function MessageBubble({
  message,
  contact,
  isGroupChat,
  isMine,
  showAvatarSpace,
  onImageClick
}: MessageBubbleProps): React.ReactElement {
  const isVoice = message.type === '语音'
  const isImage = message.type === '图片'
  const isRichMedia = RICH_MESSAGE_TYPES.includes(message.type)
  const hoverTime = formatMessageTime(message)

  return (
    <div className={`message-bubble-wrap ${showAvatarSpace ? '' : 'is-followup'}`}>
      <div
        className={`message-bubble ${isVoice ? 'voice-bubble' : ''} ${
          isImage ? 'image-message-bubble' : ''
        }`}
      >
        {isVoice && message.sessionId ? (
          <VoicePlayer
            sessionId={message.sessionId}
            localId={message.localId || 0}
            createTime={message.createTime || 0}
          />
        ) : isImage && message.contentData && message.contentData.type === 'image' ? (
          <ImageBubble
            imageMd5={message.contentData.md5}
            imageDatName={message.contentData.datName}
            sessionId={message.sessionId}
            onImageClick={onImageClick}
          />
        ) : isRichMedia && message.contentData ? (
          <RichMessageBubble contentData={message.contentData} />
        ) : (
          <div className="message-text">{renderWechatEmojiText(message.content)}</div>
        )}
      </div>
      {message.recalled && (
        <span className="message-recalled-status" title={message.recalledBy || undefined}>
          消息已撤回
        </span>
      )}
      <span className="message-hover-time">{hoverTime}</span>
      {!isGroupChat && !isMine && contact.m_nsNickName && (
        <span className="message-accessible-sender">{contact.m_nsNickName}</span>
      )}
    </div>
  )
}
