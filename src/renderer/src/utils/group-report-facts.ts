import { Contact, Message } from '../../../shared/types'
import {
  GroupDailyReport,
  GroupReportMetadata,
  ReportFunBadge,
  ReportMediaGalleryItem,
  ReportMode,
  ReportSpeakerRank,
  ReportVoiceHighlight,
  ReportVoiceLeaderboardItem
} from '../../../shared/group-report'

export interface GroupReportTranscriptRow {
  id: string
  datetime: string
  timestamp: number
  sender: string
  content: string
  avatar?: string
}

export interface GroupReportFactsSnapshot {
  metadata: GroupReportMetadata
  transcriptRows: GroupReportTranscriptRow[]
  topSpeakers: ReportSpeakerRank[]
  activeTimeline: string
  media: GroupDailyReport['media']
  voiceLeaderboard: ReportVoiceLeaderboardItem[]
  factsPrompt: string
}

export const isInternalIdentifier = (value: string): boolean =>
  /@chatroom$/i.test(value) || /^wxid_/i.test(value) || /^[a-z0-9_-]{18,}$/i.test(value)

export const summarySender = (message: Message, contact: Contact | null, isGroup: boolean): string => {
  if (message.from === 'assistant') {
    const ownGroupNickname = message.name?.trim()
    if (isGroup && ownGroupNickname && !isInternalIdentifier(ownGroupNickname)) {
      return ownGroupNickname
    }
    return '我'
  }
  const candidate = isGroup ? message.name : contact?.m_nsNickName
  if (!candidate || isInternalIdentifier(candidate)) return isGroup ? '未命名群成员' : '对方'
  return candidate
}

export const summaryContent = (message: Message): string => {
  const data = message.contentData
  if (!data) return message.content?.trim() || `[${message.type || '消息'}]`

  switch (data.type) {
    case 'image':
      return '[图片]'
    case 'sticker':
      return '[表情]'
    case 'voice':
      return `[语音${data.duration ? ` ${data.duration}秒` : ''}]`
    case 'share':
      return `[分享] ${data.title}${data.des ? `：${data.des}` : ''}`
    case 'quote': {
      const reply = data.title || data.content || message.content || '[回复]'
      const quotedSender =
        data.quotedSender && !isInternalIdentifier(data.quotedSender) ? data.quotedSender : '群成员'
      return `${reply}（引用 ${quotedSender}：${data.quotedContent || `[引用${data.quotedType || '消息'}]`}）`
    }
    case 'location':
      return `[位置] ${data.poiname || data.label || '位置消息'}`
    case 'card':
      return `[名片] ${data.nickname || '微信名片'}`
    case 'voip':
      return `[通话] ${data.status}${data.duration ? `，${data.duration}秒` : ''}`
    case 'system':
    case 'text':
      return data.content
    case 'unknown':
      return `[${message.type || '未知消息'}]`
  }

  return `[${message.type || '消息'}]`
}

export const parseTimestamp = (message: Message): number => {
  const value = new Date(message.datetime).getTime()
  return Number.isFinite(value) ? value : 0
}

export const localDate = (timestamp: number): string => {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const localTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  })

export const resolveVoiceDuration = (message: Message): number => {
  const fromData = message.contentData?.type === 'voice' ? message.contentData.duration : undefined
  return Math.max(0, Number(fromData ?? message.voiceDuration ?? 0) || 0)
}

const truncate = (value: string, max = 48): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value

const buildImageContext = (
  messages: Message[],
  index: number,
  contact: Contact | null,
  isGroup: boolean
): {
  note: string
  stats: string
  responseCount: number
  participantCount: number
  snippets: string[]
} => {
  const baseTime = parseTimestamp(messages[index])
  const participants = new Set<string>()
  const snippets: string[] = []
  let responseCount = 0

  for (let offset = index + 1; offset < messages.length && offset <= index + 8; offset++) {
    const candidate = messages[offset]
    const candidateTime = parseTimestamp(candidate)
    if (baseTime && candidateTime && candidateTime - baseTime > 20 * 60 * 1000) break
    if (candidate.type === '系统消息' || candidate.from === 'system') continue

    const sender = summarySender(candidate, contact, isGroup)
    const sameSender = sender === summarySender(messages[index], contact, isGroup)
    const content = summaryContent(candidate)
    if (!sameSender) {
      responseCount += 1
      participants.add(sender)
    }
    if (
      snippets.length < 3 &&
      !content.startsWith('[图片]') &&
      !content.startsWith('[表情]') &&
      !content.startsWith('[语音')
    ) {
      snippets.push(truncate(content, 28))
    }
  }

  const note = snippets.length
    ? `图片发出后，群里接着聊到：${snippets.join(' / ')}`
    : responseCount > 0
      ? '图片发出后引发了一波接续讨论。'
      : '这张图片更多像是一次轻量分享，没有形成长链路讨论。'

  const statsParts: string[] = []
  if (responseCount > 0) statsParts.push(`${responseCount} 条后续消息`)
  if (participants.size > 0) statsParts.push(`${participants.size} 人接话`)
  if (!statsParts.length) statsParts.push('讨论热度较低')

  return {
    note,
    stats: statsParts.join(' · '),
    responseCount,
    participantCount: participants.size,
    snippets
  }
}

const buildMediaSection = async (
  messages: Message[],
  contact: Contact | null,
  isGroup: boolean,
  topSpeakersMap: Map<string, number>
): Promise<{
  media: GroupDailyReport['media']
  voiceLeaderboard: ReportVoiceLeaderboardItem[]
}> => {
  const rawImageCandidates = messages
    .map((message, index) => {
      if (message.contentData?.type !== 'image') return null
      const sender = summarySender(message, contact, isGroup)
      const context = buildImageContext(messages, index, contact, isGroup)
      return {
        sourceMessageIds: [message.id],
        md5: message.contentData.md5,
        datName: message.contentData.datName,
        sessionId: message.sessionId,
        sender,
        time: localTime(parseTimestamp(message)),
        note: context.note,
        stats: context.stats,
        replyCount: context.responseCount,
        score: context.responseCount * 3 + context.participantCount * 2 + 1
      }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)

  const imageCandidates = await Promise.all(
    rawImageCandidates.map(async (item) => {
      const result = await window.api.getImage(item.md5, item.datName, item.sessionId)
      if (!result.success || !result.data?.startsWith('data:image/')) return null
      return {
        sender: item.sender,
        time: item.time,
        imageUrl: result.data,
        note: item.note,
        stats: item.stats,
        inferenceLabel: '基于图片后的聊天上下文推断',
        sourceMessageIds: item.sourceMessageIds,
        replyCount: item.replyCount,
        score: item.score
      }
    })
  )

  const gallery: ReportMediaGalleryItem[] = imageCandidates
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map(({ score: _score, ...item }) => item)

  const voiceMessages = messages
    .filter((message) => message.contentData?.type === 'voice')
    .map((message) => ({
      sender: summarySender(message, contact, isGroup),
      duration: resolveVoiceDuration(message),
      time: localTime(parseTimestamp(message))
    }))

  const voiceTotals = new Map<string, { count: number; duration: number }>()
  for (const item of voiceMessages) {
    const current = voiceTotals.get(item.sender) || { count: 0, duration: 0 }
    current.count += 1
    current.duration += item.duration
    voiceTotals.set(item.sender, current)
  }

  const voiceLeaderboard: ReportVoiceLeaderboardItem[] = Array.from(voiceTotals.entries())
    .map(([sender, value]) => ({
      sender,
      count: value.count,
      durationSec: value.duration
    }))
    .sort((left, right) => right.durationSec - left.durationSec || right.count - left.count)
    .slice(0, 5)

  let bestStreak: { sender: string; count: number; duration: number; time: string } | null = null
  let currentStreak: { sender: string; count: number; duration: number; time: string } | null = null
  for (const message of messages) {
    if (message.contentData?.type !== 'voice') {
      currentStreak = null
      continue
    }
    const sender = summarySender(message, contact, isGroup)
    const duration = resolveVoiceDuration(message)
    const time = localTime(parseTimestamp(message))
    if (currentStreak && currentStreak.sender === sender) {
      currentStreak.count += 1
      currentStreak.duration += duration
    } else {
      currentStreak = { sender, count: 1, duration, time }
    }
    if (!bestStreak || currentStreak.count > bestStreak.count) {
      bestStreak = { ...currentStreak }
    }
  }

  const voiceHighlights: ReportVoiceHighlight[] = []
  if (voiceLeaderboard[0]) {
    voiceHighlights.push({
      title: '语音输出王',
      sender: voiceLeaderboard[0].sender,
      note: `共发送 ${voiceLeaderboard[0].count} 条语音，累计 ${voiceLeaderboard[0].durationSec} 秒。`
    })
  }
  if (bestStreak && bestStreak.count >= 2) {
    voiceHighlights.push({
      title: '连续发言时刻',
      sender: bestStreak.sender,
      note: `${bestStreak.time} 连发 ${bestStreak.count} 条语音，共 ${bestStreak.duration} 秒。`
    })
  }

  const funBadges: ReportFunBadge[] = []
  const topSpeaker = Array.from(topSpeakersMap.entries()).sort((left, right) => right[1] - left[1])[0]
  if (topSpeaker) {
    funBadges.push({
      title: '高能输出王',
      owner: topSpeaker[0],
      note: `今天一共发了 ${topSpeaker[1]} 条消息。`
    })
  }
  if (gallery[0]) {
    funBadges.push({
      title: '图片话题王',
      owner: gallery[0].sender,
      note: `${gallery[0].time} 的图片带动了最明显的一轮讨论。`
    })
  }
  if (voiceLeaderboard[0]) {
    funBadges.push({
      title: '语音麦霸',
      owner: voiceLeaderboard[0].sender,
      note: `语音总时长暂居第一，适合放进“今日声音档案”。`
    })
  }

  return {
    media: {
      gallery,
      voiceHighlights: voiceHighlights.slice(0, 2),
      funBadges: funBadges.slice(0, 3)
    },
    voiceLeaderboard
  }
}

const collectQuestionCandidates = (
  messages: Message[],
  contact: Contact | null,
  isGroup: boolean
): string[] =>
  messages
    .map((message) => ({
      id: message.id,
      sender: summarySender(message, contact, isGroup),
      content: summaryContent(message)
    }))
    .filter((item) => /[?？]$/.test(item.content) || item.content.includes('吗') || item.content.includes('怎么'))
    .slice(-6)
    .map((item) => `${item.sender}（${item.id}）：${truncate(item.content, 32)}`)

const collectReplyFacts = (messages: Message[], contact: Contact | null, isGroup: boolean): string[] =>
  messages
    .filter((message) => message.contentData?.type === 'quote' && message.contentData.quotedSender)
    .slice(0, 10)
    .map((message) => {
      const sender = summarySender(message, contact, isGroup)
      const quotedSender =
        message.contentData?.type === 'quote' && message.contentData.quotedSender
          ? message.contentData.quotedSender
          : '群成员'
      return `${sender} 回复了 ${quotedSender}`
    })

export const buildGroupReportFacts = async (
  messages: Message[],
  contact: Contact | null,
  isGroup: boolean,
  reportMode: ReportMode
): Promise<GroupReportFactsSnapshot> => {
  const transcriptRows = messages.map((message) => ({
    id: message.id,
    datetime: message.datetime,
    timestamp: parseTimestamp(message),
    sender: summarySender(message, contact, isGroup),
    content: summaryContent(message),
    avatar: message.img
  }))

  let firstTimestamp = Number.POSITIVE_INFINITY
  let lastTimestamp = Number.NEGATIVE_INFINITY
  for (const row of transcriptRows) {
    if (!Number.isFinite(row.timestamp)) continue
    firstTimestamp = Math.min(firstTimestamp, row.timestamp)
    lastTimestamp = Math.max(lastTimestamp, row.timestamp)
  }
  if (!Number.isFinite(firstTimestamp)) firstTimestamp = Date.now()
  if (!Number.isFinite(lastTimestamp)) lastTimestamp = firstTimestamp

  const speakerCounts = new Map<string, number>()
  const hourCounts = new Map<number, number>()
  const avatars: Record<string, string | undefined> = {}
  let imageCount = 0
  let stickerCount = 0
  let voiceCount = 0
  let voiceDurationSec = 0

  for (const message of messages) {
    const sender = summarySender(message, contact, isGroup)
    const timestamp = parseTimestamp(message)
    speakerCounts.set(sender, (speakerCounts.get(sender) || 0) + 1)
    if (Number.isFinite(timestamp)) {
      const hour = new Date(timestamp).getHours()
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1)
    }
    if (message.img && !avatars[sender]) avatars[sender] = message.img
    if (message.contentData?.type === 'image') imageCount += 1
    if (message.contentData?.type === 'sticker') stickerCount += 1
    if (message.contentData?.type === 'voice') {
      voiceCount += 1
      voiceDurationSec += resolveVoiceDuration(message)
    }
  }

  const topSpeakers = Array.from(speakerCounts, ([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 5)

  const activeTimeline = Array.from(hourCounts, ([hour, count]) => ({ hour, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 4)
    .sort((left, right) => left.hour - right.hour)
    .map(
      ({ hour, count }) =>
        `${String(hour).padStart(2, '0')}:00-${String(hour).padStart(2, '0')}:59（${count}条）`
    )
    .join('、')

  const startDate = localDate(firstTimestamp)
  const endDate = localDate(lastTimestamp)
  const sameDay = startDate === endDate
  const dateRange = sameDay
    ? `${startDate} ${localTime(firstTimestamp)}-${localTime(lastTimestamp)}`
    : `${startDate} ${localTime(firstTimestamp)} 至 ${endDate} ${localTime(lastTimestamp)}`
  const durationMs = Math.max(0, lastTimestamp - firstTimestamp)
  const durationHours = durationMs / 3600000
  const timeSpan = (() => {
    if (sameDay) {
      if (durationHours < 1) {
        const minutes = Math.max(1, Math.round(durationMs / 60000))
        return `${minutes} min`
      }
      const hours = Math.max(1, Math.ceil(durationHours))
      return `${hours} h`
    }
    const days = Math.max(1, Math.ceil(durationMs / 86400000))
    return `${days} d`
  })()

  const contactName = contact?.m_nsNickName || ''
  const groupName = contactName && !isInternalIdentifier(contactName) ? contactName : '未命名会话'
  const metadata: GroupReportMetadata = {
    groupName,
    reportDate: sameDay ? startDate : `${startDate}_to_${endDate}`,
    dateRange,
    messageCount: transcriptRows.length,
    activeUsers: speakerCounts.size,
    imageCount,
    voiceCount,
    stickerCount,
    mediaMessageCount: imageCount + voiceCount + stickerCount,
    timeSpan,
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    recordNote: `基于当前已加载的 ${transcriptRows.length} 条记录`,
    footerNote: '基于已读取聊天记录生成；图片、表情等未解析内容默认只按类型与上下文参与日报。',
    heroParticipants: topSpeakers.slice(0, 4).map((speaker) => speaker.name),
    avatars,
    reportMode
  }

  const { media, voiceLeaderboard } = await buildMediaSection(messages, contact, isGroup, speakerCounts)

  const factsPrompt = [
    `报告模式：${reportMode === 'compact' ? '精简版（30秒可读完）' : '完整版（保留更多上下文）'}`,
    `消息统计：共 ${transcriptRows.length} 条，活跃成员 ${speakerCounts.size} 人，图片 ${imageCount} 张，表情 ${stickerCount} 条，语音 ${voiceCount} 条（累计 ${voiceDurationSec} 秒）。`,
    activeTimeline ? `活跃时段：${activeTimeline}` : '',
    media.gallery.length
      ? `图片观察：${media.gallery.map((item) => `${item.time} ${item.sender} 发图（${item.stats}）`).join('；')}`
      : '',
    voiceLeaderboard.length
      ? `语音榜：${voiceLeaderboard
          .slice(0, 3)
          .map((item) => `${item.sender} ${item.count} 条 / ${item.durationSec} 秒`)
          .join('；')}`
      : '',
    collectQuestionCandidates(messages, contact, isGroup).length
      ? `疑似待跟进问题：${collectQuestionCandidates(messages, contact, isGroup).join('；')}`
      : '',
    collectReplyFacts(messages, contact, isGroup).length
      ? `回复关系样本：${collectReplyFacts(messages, contact, isGroup).join('；')}`
      : ''
  ]
    .filter(Boolean)
    .join('\n')

  return {
    metadata,
    transcriptRows,
    topSpeakers,
    activeTimeline,
    media,
    voiceLeaderboard,
    factsPrompt
  }
}
