import React from 'react'
import { Contact, Message } from '../../../../shared/types'
import { ImageBubble } from '../ImageBubble'
import { RichMessageBubble } from '../RichMessageBubble'
import { VoicePlayer } from '../VoicePlayer'
import { VideoBubble } from '../VideoBubble'
import { renderWechatEmojiText } from '../../utils/wechatEmojiText'
import { formatMessageTime } from './messageGrouping'

interface MessageBubbleProps {
  message: Message
  contact: Contact
  isGroupChat: boolean
  isMine: boolean
  showAvatarSpace: boolean
  onImageClick: (imageUrl: string) => void
  isJumpTarget?: boolean
}

const RICH_MESSAGE_TYPES = [
  '名片',
  '位置',
  '分享消息',
  '小程序',
  '微信红包',
  '公众号链接',
  '文件',
  '文件发送中',
  '视频号',
  '转账',
  '引用消息',
  '通话',
  '表情包',
  '系统消息',
  '合并转发',
  '不支持的消息'
]

export function MessageBubble({
  message,
  contact,
  isGroupChat,
  isMine,
  showAvatarSpace,
  onImageClick,
  isJumpTarget
}: MessageBubbleProps): React.ReactElement {
  const isVoice = message.type === '语音'
  const isImage = message.type === '图片'
  const isVideo = message.type === '视频'
  const isRichMedia =
    RICH_MESSAGE_TYPES.includes(message.type) || message.contentData?.type === 'unknown'
  const hoverTime = formatMessageTime(message)

  return (
    <div
      className={`message-bubble-wrap ${showAvatarSpace ? '' : 'is-followup'} ${isJumpTarget ? 'archive-jump-message' : ''}`}
    >
      <div
        className={`message-bubble ${isVoice ? 'voice-bubble' : ''} ${
          isImage ? 'image-message-bubble' : ''
        } ${isVideo ? 'video-message-bubble' : ''}`}
      >
        {isVoice && message.sessionId ? (
          <VoicePlayer
            sessionId={message.sessionId}
            localId={message.localId || 0}
            createTime={message.createTime || 0}
            svrId={message.serverId}
            duration={message.voiceDuration}
          />
        ) : isImage && message.contentData && message.contentData.type === 'image' ? (
          <ImageBubble
            imageMd5={message.contentData.md5}
            imageDatName={message.contentData.datName}
            sessionId={message.sessionId}
            onImageClick={onImageClick}
          />
        ) : isVideo && message.contentData && message.contentData.type === 'video' ? (
          <VideoBubble
            md5={message.contentData.md5}
            newMd5={message.contentData.newMd5}
            rawMd5={message.contentData.rawMd5}
            createTime={message.createTime}
            duration={message.contentData.duration}
            width={message.contentData.width}
            height={message.contentData.height}
          />
        ) : isRichMedia && message.contentData ? (
          <RichMessageBubble
            contentData={message.contentData}
            sessionId={message.sessionId}
            onImageClick={onImageClick}
          />
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
