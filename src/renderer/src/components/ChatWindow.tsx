import React, { useEffect, useRef, useState } from 'react'
import { Message, Contact } from '../../../shared/types'
import { VoicePlayer } from './VoicePlayer'
import { RichMessageBubble } from './RichMessageBubble'
import { ImageBubble } from './ImageBubble'
import {
  buildGroupReportInput,
  GROUP_REPORT_SYSTEM_PROMPT,
  parseGroupDailyReport
} from '../utils/group-report'
import type { ReportMode } from '../../../shared/group-report'

interface ChatWindowProps {
  contact: Contact | null
  messages: Message[]
  contentFilter?: string
  onRefresh?: () => void
  onRefreshData?: () => void
}

type SummaryDateRange = 'today' | 'yesterday' | '7days'
type SummaryMessageType = 'text' | 'image' | 'sticker' | 'video' | 'voice' | 'share' | 'system'

const SUMMARY_DATE_OPTIONS: { value: SummaryDateRange; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: 'yesterday', label: '昨日' },
  { value: '7days', label: '最近 7 天' }
]

const SUMMARY_TYPE_OPTIONS: {
  value: SummaryMessageType
  label: string
  messageTypes: string[]
}[] = [
  { value: 'text', label: '文本', messageTypes: ['普通文本'] },
  { value: 'image', label: '图片', messageTypes: ['图片'] },
  { value: 'sticker', label: '表情包', messageTypes: ['表情包'] },
  { value: 'video', label: '视频', messageTypes: ['视频'] },
  { value: 'voice', label: '语音', messageTypes: ['语音'] },
  { value: 'share', label: '分享/引用', messageTypes: ['分享消息', '名片', '位置', '通话'] },
  { value: 'system', label: '系统消息', messageTypes: ['系统消息'] }
]

const getSummaryDateRange = (range: SummaryDateRange): { startTime: number; endTime: number } => {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000
  const endTime = Math.floor(Date.now() / 1000)
  if (range === 'yesterday') {
    return { startTime: startOfToday - 86400, endTime: startOfToday - 1 }
  }
  if (range === '7days') {
    return { startTime: startOfToday - 6 * 86400, endTime }
  }
  return { startTime: startOfToday, endTime }
}

const ChatWindow: React.FC<ChatWindowProps> = ({
  contact,
  messages,
  contentFilter,
  onRefresh,
  onRefreshData
}) => {
  const isGroupChat = Boolean(
    contact?.type === 'group' || contact?.m_nsUsrName?.endsWith('@chatroom')
  )
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [generatedImage, setGeneratedImage] = useState<string | null>(null)
  const [reportPaths, setReportPaths] = useState<{ htmlPath: string; pngPath: string } | null>(null)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [imageScale, setImageScale] = useState(0.75)
  const [imageRotation, setImageRotation] = useState(0)
  const [imageOffset, setImageOffset] = useState({ x: 0, y: 0 })
  const imageDragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(
    null
  )
  const [showAvatar, setShowAvatar] = useState(true)

  // AI Settings
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('ai_api_key') || '')
  const [baseURL, setBaseURL] = useState(
    () => localStorage.getItem('ai_base_url') || 'https://api.deepseek.com'
  )
  const [model, setModel] = useState(() => localStorage.getItem('ai_model') || 'deepseek-v4-flash')
  const [summaryDateRange, setSummaryDateRange] = useState<SummaryDateRange>('today')
  const [summaryMessageTypes, setSummaryMessageTypes] = useState<SummaryMessageType[]>(['text'])
  const [reportMode, setReportMode] = useState<ReportMode>(
    () => (localStorage.getItem('group_report_mode') as ReportMode) || 'compact'
  )

  const handleSaveSettings = (): void => {
    if (!summaryMessageTypes.length) {
      alert('请至少选择一种消息类型')
      return
    }
    localStorage.setItem('ai_api_key', apiKey)
    localStorage.setItem('ai_base_url', baseURL)
    localStorage.setItem('ai_model', model)
    localStorage.setItem('group_report_mode', reportMode)
    setShowSettingsModal(false)
    AIChat()
  }

  const toggleSummaryMessageType = (type: SummaryMessageType): void => {
    setSummaryMessageTypes((current) =>
      current.includes(type) ? current.filter((item) => item !== type) : [...current, type]
    )
  }

  const scrollToBottom = (): void => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const openImagePreview = (imageUrl: string): void => {
    setPreviewImage(imageUrl)
    setImageScale(0.75)
    setImageRotation(0)
    setImageOffset({ x: 0, y: 0 })
  }

  const closeImagePreview = (): void => {
    setPreviewImage(null)
    imageDragRef.current = null
  }

  const zoomImage = (delta: number): void => {
    setImageScale((prev) => Math.min(3, Math.max(0.25, Number((prev + delta).toFixed(2)))))
  }

  const resetImageTransform = (): void => {
    setImageScale(0.75)
    setImageRotation(0)
    setImageOffset({ x: 0, y: 0 })
  }

  const handleViewerWheel = (event: React.WheelEvent): void => {
    event.preventDefault()
    zoomImage(event.deltaY > 0 ? -0.1 : 0.1)
  }

  const handleViewerMouseDown = (event: React.MouseEvent): void => {
    event.preventDefault()
    imageDragRef.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: imageOffset.x,
      offsetY: imageOffset.y
    }
  }

  const handleViewerMouseMove = (event: React.MouseEvent): void => {
    if (!imageDragRef.current) return
    const drag = imageDragRef.current
    setImageOffset({
      x: drag.offsetX + event.clientX - drag.x,
      y: drag.offsetY + event.clientY - drag.y
    })
  }

  const handleViewerMouseUp = (): void => {
    imageDragRef.current = null
  }

  const handleExport = (days: number | 'all'): void => {
    if (!messages.length) return

    let filtered = messages
    if (days !== 'all') {
      const now = new Date()
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

      filtered = messages.filter((m) => {
        const parsed = new Date(m.datetime).getTime()
        if (isNaN(parsed)) return true

        if (days === 0) {
          // 今天
          return parsed >= startOfDay
        } else if (days === 1) {
          // 昨天
          const startOfYesterday = startOfDay - 86400000
          return parsed >= startOfYesterday && parsed < startOfDay
        } else if (days === 7) {
          // 过去 7 天
          const startOf7DaysAgo = startOfDay - 7 * 86400000
          return parsed >= startOf7DaysAgo
        } else if (days === 30) {
          // 过去 30 天
          const startOf30DaysAgo = startOfDay - 30 * 86400000
          return parsed >= startOf30DaysAgo
        }
        return true
      })
    }

    const headers = ['发送者', '类型', '时间', '内容']
    const csvContent = [
      headers.join(','),
      ...filtered.map((m) => {
        let prefix = ''
        if (isGroupChat) {
          prefix = m.name ? `${m.name}: ` : ''
        } else {
          const name = m.from === 'user' ? contact?.m_nsNickName || '未知' : '我'
          prefix = `${name}: `
        }
        const fullContent = `${prefix}${m.content}`
        const content = fullContent.replace(/"/g, '""').replace(/\n/g, ' ')
        return `"${m.from}","${m.type}","${m.datetime}","${content}"`
      })
    ].join('\n')

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `${contact?.m_nsNickName || 'chat'}_export.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const [isLoading, setIsLoading] = useState(false)

  const AIChat = async (): Promise<void> => {
    if (!contact) return
    if (!summaryMessageTypes.length) {
      alert('请至少选择一种消息类型')
      return
    }
    setIsLoading(true)
    try {
      const { startTime, endTime } = getSummaryDateRange(summaryDateRange)
      const rangeMessages = await window.api.getMessages(contact.md5, startTime, endTime)
      const allowedTypes = new Set(
        SUMMARY_TYPE_OPTIONS.filter((option) => summaryMessageTypes.includes(option.value)).flatMap(
          (option) => option.messageTypes
        )
      )
      const reportMessages = rangeMessages.filter((message) => allowedTypes.has(message.type))
      if (!reportMessages.length) throw new Error('当前条件下没有可总结的消息')

      const input = await buildGroupReportInput(reportMessages, contact, isGroupChat, reportMode)
      console.log('🚀 ~ AIChat ~ input:', input)
      console.log('🚀 ~ AIChat ~ input.prompt:', input.prompt)
      const result = await window.api.aiChat(
        [
          { role: 'system', content: GROUP_REPORT_SYSTEM_PROMPT },
          { role: 'user', content: input.prompt }
        ],
        { apiKey, model, baseURL }
      )

      if (!result.success || !result.data) throw new Error(result.error || 'AI 请求失败')
      const report = parseGroupDailyReport(
        result.data,
        input.topSpeakers,
        input.activeTimeline,
        input.voiceLeaderboard,
        input.metadata,
        input.media
      )
      const exported = await window.api.exportGroupReport({ report, metadata: input.metadata })
      if (!exported.success || !exported.imageDataUrl || !exported.htmlPath || !exported.pngPath) {
        throw new Error(exported.error || '日报文件生成失败')
      }
      setGeneratedImage(exported.imageDataUrl)
      setReportPaths({ htmlPath: exported.htmlPath, pngPath: exported.pngPath })
    } catch (error) {
      console.error('AI Call Failed:', error)
      alert(`AI 日报生成失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsLoading(false)
    }
  }
  const handleCopyImage = async (): Promise<void> => {
    if (!generatedImage) return
    const result = await window.api.copyImage(generatedImage)
    if (result.success) {
      alert('复制成功')
    }
  }

  const filteredMessages = React.useMemo(() => {
    return messages.filter((msg) => {
      const filterTypes = (import.meta.env.VITE_FILTER_MSG_TYPES || '')
        .split(',')
        .map((type) => type.trim())
        .filter(Boolean)
      const typeMatch = !filterTypes.includes(msg.type)
      const contentMatch = !contentFilter || msg.content.includes(contentFilter)
      return typeMatch && contentMatch
    })
  }, [messages, contentFilter])

  if (!contact) {
    return (
      <div className="chat-window">
        <div className="empty-state">选择一条消息</div>
      </div>
    )
  }

  return (
    <div className="chat-window">
      <div className="chat-header">
        <h2>{contact.m_nsNickName}</h2>
        <div className="window-controls"></div>
      </div>

      <div className="message-list wechat-message-list">
        {filteredMessages.map((msg) => {
          const isMine = msg.from === 'assistant'
          const isSystem = msg.from === 'system' || msg.type === '系统消息'
          const displayName = isMine
            ? '我'
            : isGroupChat
              ? msg.name || msg.from
              : contact.m_nsNickName
          const avatarSrc = isMine ? msg.img : msg.img || contact.avatar
          const isVoice = msg.type === '语音'
          const isImage = msg.type === '图片'
          const isRichMedia = ['名片', '位置', '分享消息', '通话', '表情包', '系统消息'].includes(
            msg.type
          )

          if (isSystem) {
            return (
              <div key={msg.id} className="wechat-system-message-row">
                <div className="wechat-system-message">{msg.content}</div>
                <div className="wechat-system-message-meta">{msg.datetime}</div>
              </div>
            )
          }

          return (
            <div key={msg.id} className={`wechat-message-row ${isMine ? 'mine' : 'other'}`}>
              {!isMine && showAvatar && (
                <div className="message-avatar">
                  {avatarSrc ? (
                    <img src={avatarSrc} alt={displayName} referrerPolicy="no-referrer" />
                  ) : (
                    (displayName || '?').charAt(0)
                  )}
                </div>
              )}
              <div className="message-stack">
                {!isMine && isGroupChat && <div className="message-sender-name">{displayName}</div>}
                <div
                  className={`message-bubble ${isVoice ? 'voice-bubble' : ''} ${isImage ? 'image-message-bubble' : ''}`}
                >
                  {isVoice && msg.sessionId ? (
                    <VoicePlayer
                      sessionId={msg.sessionId}
                      localId={msg.localId || 0}
                      createTime={msg.createTime || 0}
                    />
                  ) : isImage && msg.contentData && msg.contentData.type === 'image' ? (
                    <ImageBubble
                      imageMd5={msg.contentData.md5}
                      imageDatName={msg.contentData.datName}
                      sessionId={msg.sessionId}
                      onImageClick={openImagePreview}
                    />
                  ) : isRichMedia && msg.contentData ? (
                    <RichMessageBubble contentData={msg.contentData} />
                  ) : (
                    <div className="message-text">{msg.content}</div>
                  )}
                </div>
                <div className="message-meta">
                  <span>{msg.datetime}</span>
                  <span>{msg.type}</span>
                </div>
              </div>
              {isMine && showAvatar && (
                <div className="message-avatar mine-avatar">
                  {avatarSrc ? <img src={avatarSrc} alt="我" referrerPolicy="no-referrer" /> : '我'}
                </div>
              )}
            </div>
          )
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-toolbar">
        <label
          style={{ marginRight: '10px', display: 'flex', alignItems: 'center', cursor: 'pointer' }}
        >
          <input
            type="checkbox"
            checked={showAvatar}
            onChange={(e) => setShowAvatar(e.target.checked)}
            style={{ marginRight: '5px' }}
          />
          显示头像
        </label>
        <button className="toolbar-btn" onClick={onRefresh}>
          🔄 刷新聊天记录
        </button>
        <button className="toolbar-btn" onClick={onRefreshData}>
          🔄 刷新数据
        </button>
        <button className="toolbar-btn" onClick={() => handleExport('all')}>
          📤 导出全部
        </button>
        <button className="toolbar-btn" onClick={() => handleExport(0)}>
          🕒 导出今日
        </button>
        <button className="toolbar-btn" onClick={() => handleExport(1)}>
          📅 导出昨日
        </button>
        <button className="toolbar-btn" onClick={() => handleExport(7)}>
          📅 导出近7天
        </button>
        <button className="toolbar-btn" onClick={() => handleExport(30)}>
          📅 导出近30天
        </button>
        <button className="toolbar-btn" onClick={() => setShowSettingsModal(true)}>
          🤖 AI总结群聊
        </button>
      </div>

      {/* 加载模态框 */}
      {isLoading && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ textAlign: 'center', minWidth: '200px' }}>
            <div style={{ fontSize: '40px', marginBottom: '20px' }}>🤖</div>
            <div style={{ fontSize: '16px', color: '#333' }}>正在生成群聊日报...</div>
            <div style={{ fontSize: '12px', color: '#999', marginTop: '10px' }}>
              正在分析记录、处理头像并生成 HTML 和长图
            </div>
          </div>
        </div>
      )}

      {/* 图片预览模态框 */}
      {generatedImage && (
        <div className="modal-overlay" onClick={() => setGeneratedImage(null)}>
          <div className="modal-content image-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="report-preview-frame">
              <div className="report-preview-scroller">
                <img
                  src={generatedImage}
                  alt="Generated Summary"
                  className="report-preview-image"
                />
              </div>
            </div>
            <div className="report-preview-actions">
              <button
                onClick={handleCopyImage}
                style={{
                  padding: '8px 15px',
                  cursor: 'pointer',
                  backgroundColor: '#4CAF50',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px'
                }}
              >
                📋 复制图片
              </button>
              {reportPaths && (
                <button
                  onClick={() => window.api.revealGroupReport(reportPaths.pngPath)}
                  style={{ padding: '5px 10px', cursor: 'pointer' }}
                >
                  在文件夹中显示
                </button>
              )}
              <button
                onClick={() => setGeneratedImage(null)}
                style={{ padding: '5px 10px', cursor: 'pointer' }}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {previewImage && (
        <div className="image-viewer-overlay" onClick={closeImagePreview}>
          <div className="image-viewer-window" onClick={(e) => e.stopPropagation()}>
            <div className="image-viewer-titlebar">
              <div className="image-viewer-tools">
                <span className="image-viewer-title">图片查看</span>
                <button onClick={() => zoomImage(-0.1)} title="缩小">
                  −
                </button>
                <span className="image-viewer-zoom">{Math.round(imageScale * 100)}%</span>
                <button onClick={() => zoomImage(0.1)} title="放大">
                  +
                </button>
                <span className="image-viewer-divider" />
                <button onClick={() => setImageRotation((prev) => prev - 90)} title="左旋转">
                  ↶
                </button>
                <button onClick={() => setImageRotation((prev) => prev + 90)} title="右旋转">
                  ↷
                </button>
                <button onClick={resetImageTransform} title="重置">
                  ⟲
                </button>
              </div>
              <button className="image-viewer-close" onClick={closeImagePreview} aria-label="关闭">
                ×
              </button>
            </div>
            <div
              className="image-viewer-stage"
              onWheel={handleViewerWheel}
              onMouseDown={handleViewerMouseDown}
              onMouseMove={handleViewerMouseMove}
              onMouseUp={handleViewerMouseUp}
              onMouseLeave={handleViewerMouseUp}
            >
              <img
                src={previewImage}
                alt="图片预览"
                draggable={false}
                style={{
                  transform: `translate(${imageOffset.x}px, ${imageOffset.y}px) scale(${imageScale}) rotate(${imageRotation}deg)`
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* AI Settings Modal */}
      {showSettingsModal && (
        <div className="modal-overlay" onClick={() => setShowSettingsModal(false)}>
          <div className="modal-content ai-settings-modal" onClick={(e) => e.stopPropagation()}>
            <h3>AI 设置</h3>
            <div className="ai-filter-section">
              <div className="ai-filter-label">时间范围</div>
              <div className="ai-date-options">
                {SUMMARY_DATE_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className={summaryDateRange === option.value ? 'selected' : ''}
                  >
                    <input
                      type="radio"
                      name="summary-date-range"
                      value={option.value}
                      checked={summaryDateRange === option.value}
                      onChange={() => setSummaryDateRange(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="ai-filter-section">
              <div className="ai-filter-label">报告模式</div>
              <div className="ai-date-options">
                <label className={reportMode === 'compact' ? 'selected' : ''}>
                  <input
                    type="radio"
                    name="report-mode"
                    value="compact"
                    checked={reportMode === 'compact'}
                    onChange={() => setReportMode('compact')}
                  />
                  精简版（推荐）
                </label>
                <label className={reportMode === 'full' ? 'selected' : ''}>
                  <input
                    type="radio"
                    name="report-mode"
                    value="full"
                    checked={reportMode === 'full'}
                    onChange={() => setReportMode('full')}
                  />
                  完整版
                </label>
              </div>
            </div>
            <div className="ai-filter-section">
              <div className="ai-filter-label">消息类型</div>
              <div className="ai-type-options">
                {SUMMARY_TYPE_OPTIONS.map((option) => (
                  <label key={option.value}>
                    <input
                      type="checkbox"
                      checked={summaryMessageTypes.includes(option.value)}
                      onChange={() => toggleSummaryMessageType(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="form-group" style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px' }}>模型服务:</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                style={{ width: '100%', padding: '8px' }}
              >
                <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
                <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
                <option value="gpt-4o">GPT-4o</option>
                <option value="gpt-4o-mini">GPT-4o Mini</option>
                <option value="gpt-4-turbo">GPT-4 Turbo</option>
                <option value="claude-3-5-sonnet-20240620">Claude 3.5 Sonnet</option>
                <option value="moonshot-v1-8k">Moonshot V1</option>
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px' }}>Base URL:</label>
              <input
                type="text"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                placeholder="https://api.deepseek.com"
                style={{ width: '95%', padding: '8px' }}
              />
            </div>
            <div className="form-group" style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '5px' }}>API Key:</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Enter your API Key"
                style={{ width: '95%', padding: '8px' }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button onClick={() => setShowSettingsModal(false)}>取消</button>
              <button
                onClick={handleSaveSettings}
                style={{
                  backgroundColor: '#4CAF50',
                  color: 'white',
                  border: 'none',
                  padding: '8px 15px',
                  borderRadius: '4px'
                }}
              >
                生成总结
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
export default ChatWindow
