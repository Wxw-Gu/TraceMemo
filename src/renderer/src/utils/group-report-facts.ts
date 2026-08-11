import { Contact, Message } from '../../../shared/types'
import {
  GroupDailyReport,
  GroupReportMetadata,
  ReportFunBadge,
  ReportMediaGalleryItem,
  ReportMode,
  ReportSpeakerRank,
  ReportVisionGalleryItem,
  ReportVoiceHighlight,
  ReportVoiceLeaderboardItem
} from '../../../shared/group-report'
import type {
  ImageAnalysisRequest,
  ImageAnalysisResponse,
  ImageCandidate,
  ImageCandidateQuery
} from '../../../shared/image-insight'

interface ReportImageReadResult {
  success: boolean
  data?: string
  error?: string
}

declare const window: {
  api: {
    imageListCandidates: (query: ImageCandidateQuery) => Promise<{
      success: boolean
      candidates: ImageCandidate[]
      error?: string
    }>
    imageAnalyze: (request: ImageAnalysisRequest) => Promise<ImageAnalysisResponse>
    getImage: (
      imageMd5?: string,
      imageDatNameOrThumb?: string | boolean,
      sessionId?: string,
      options?: { includeData?: boolean }
    ) => Promise<ReportImageReadResult>
  }
}

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

function friendlyImageNotice(warnings: string[]): string {
  const detail = warnings.join(' ')
  if (/模型.*不支持|vision|multimodal|image.*support/i.test(detail)) {
    return '当前 AI 模型暂未通过图片理解验证，已跳过图片精选；文字日报不受影响。'
  }
  if (/解密|密钥|未找到|读取失败/.test(detail)) {
    return '部分图片在本机暂不可用，已跳过图片精选；文字日报不受影响。'
  }
  if (/格式.*不支持|图片格式/.test(detail)) {
    return '部分图片暂不适合 AI 分析，已跳过图片精选；文字日报不受影响。'
  }
  return '图片精选暂未生成，文字消息、统计和关键词仍已正常处理。'
}

export const isInternalIdentifier = (value: string): boolean =>
  /@chatroom$/i.test(value) || /^wxid_/i.test(value) || /^[a-z0-9_-]{18,}$/i.test(value)

const isSystemMessage = (message: Message): boolean =>
  message.from === 'system' || message.type === '系统消息' || message.contentData?.type === 'system'

export const summarySender = (
  message: Message,
  contact: Contact | null,
  isGroup: boolean
): string => {
  if (isSystemMessage(message)) return '微信系统消息'
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
  if (message.type === '语音' || data?.type === 'voice') {
    return message.voiceTranscript?.trim()
      ? `[语音${data?.type === 'voice' && data.duration ? ` ${data.duration}秒` : ''}] ${message.voiceTranscript.trim()}`
      : `[语音${data?.type === 'voice' && data.duration ? ` ${data.duration}秒` : ''}]`
  }
  if (!data) return message.content?.trim() || `[${message.type || '消息'}]`

  switch (data.type) {
    case 'image':
      return '[图片]'
    case 'sticker':
      return '[表情]'
    case 'share':
      return data.articles?.length
        ? `[分享] ${data.articles
            .map(
              (article) =>
                `${article.title}${article.description ? `：${article.description}` : ''}`
            )
            .join('；')}`
        : `[分享] ${data.title}${data.des ? `：${data.des}` : ''}`
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
  warnings: string[]
}> => {
  const warnings: string[] = []
  const rendererApi = typeof window === 'undefined' ? null : window.api
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
        participantCount: context.participantCount,
        score: context.responseCount * 3 + context.participantCount * 2 + 1
      }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)

  // ============================================================
  // AI 图片理解(ImageInsightService 接入)
  // 通过 main 进程拿 Top 3 热点图 + 已缓存的 Insight;未缓存的并发调 AI
  // 失败不阻塞:任何错误只记日志,降级到原 gallery
  // ============================================================
  let visionGallery: ReportVisionGalleryItem[] = []
  try {
    if (!rendererApi) throw new Error('后台模式不读取 Renderer 图片')
    const sessionId = messages.find((m) => m.sessionId)?.sessionId || (contact?.md5 ?? '')
    const startTime = messages.length ? parseTimestamp(messages[0]) : 0
    const endTime = messages.length ? parseTimestamp(messages[messages.length - 1]) : 0

    // 从 renderer 已加载的消息中提取图片候选(复用 buildImageContext 已算的 replyCount)
    const imageInputs = rawImageCandidates.map((c) => {
      const srcMsg = messages.find((m) => m.id === c.sourceMessageIds[0]) || messages[0]
      return {
        messageId: c.sourceMessageIds[0] || '',
        md5: c.md5,
        datName: c.datName,
        sessionId: c.sessionId || sessionId,
        sender: c.sender,
        sentAt: parseTimestamp(srcMsg),
        responseCount: c.replyCount || 0,
        interactionCount: c.participantCount || 0
      }
    })

    const candidatesResp = await rendererApi.imageListCandidates({
      sessionId,
      startTime,
      endTime,
      limit: 3,
      inputs: imageInputs
    })
    const candidates = candidatesResp.success ? candidatesResp.candidates : []
    console.log('[buildMediaSection] imageListCandidates returned', candidates.length, 'candidates')

    // 对每个候选:缓存命中直接用,未命中并发调 imageAnalyze
    const analyzed = await Promise.all(
      candidates.map(async (candidate) => {
        if (candidate.insight) return candidate.insight
        // 未命中:解密图片拿 base64 → 调 AI
        try {
          const img = await rendererApi.getImage(
            candidate.md5,
            candidate.datName,
            candidate.sessionId,
            { includeData: true }
          )
          if (!img.success || !img.data) {
            warnings.push(
              `${candidate.sender} ${localTime(candidate.sentAt)} 的图片读取失败：${img.error || '未知错误'}`
            )
            return null
          }
          const analyzeResp = await rendererApi.imageAnalyze({
            imageHash: candidate.imageHash,
            imageDataUrl: img.data,
            messageId: candidate.messageId,
            sender: candidate.sender,
            sentAt: candidate.sentAt,
            sessionId: candidate.sessionId,
            force: false
          })
          if (!analyzeResp.success || !analyzeResp.insight) {
            warnings.push(
              `${candidate.sender} ${localTime(candidate.sentAt)} 的图片识别失败：${analyzeResp.error || '模型未返回识别结果'}`
            )
            return null
          }
          return analyzeResp.insight
        } catch (error) {
          console.warn('[buildMediaSection] image analyze failed:', error)
          warnings.push(
            `${candidate.sender} ${localTime(candidate.sentAt)} 的图片识别异常：${error instanceof Error ? error.message : String(error)}`
          )
          return null
        }
      })
    )
    visionGallery = analyzed
      .filter((it): it is NonNullable<typeof it> => Boolean(it))
      .map((it) => ({
        messageId: it.messageId,
        imageHash: it.imageHash,
        sender: it.sender,
        time: localTime(it.sentAt),
        description: it.description,
        ocrText: it.ocrText,
        tags: it.tags,
        category: it.category,
        importance: it.importance,
        sourceMessageIds: [it.messageId]
      }))
    // 为 visionGallery 加载原图 dataUrl(给 main 渲染用,不暴露给 LLM)
    if (visionGallery.length) {
      visionGallery = await Promise.all(
        visionGallery.map(async (item) => {
          const orig = rawImageCandidates.find((c) => c.sourceMessageIds[0] === item.messageId)
          if (!orig) return item
          try {
            const img = await rendererApi.getImage(orig.md5, orig.datName, orig.sessionId, {
              includeData: true
            })
            if (img.success && img.data?.startsWith('data:image/')) {
              return { ...item, imageUrl: img.data }
            }
          } catch (error) {
            console.warn('[buildMediaSection] preload image failed for', item.messageId, error)
          }
          return item
        })
      )
    }
  } catch (error) {
    console.warn('[buildMediaSection] vision flow failed, fallback to empty:', error)
    warnings.push(`图片识别流程失败：${error instanceof Error ? error.message : String(error)}`)
    visionGallery = []
  }

  const imageCandidates = rendererApi
    ? await Promise.all(
        rawImageCandidates.map(async (item) => {
          const result = await rendererApi.getImage(item.md5, item.datName, item.sessionId, {
            includeData: true
          })
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
    : []

  const gallery: ReportMediaGalleryItem[] = imageCandidates
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map((item) => ({
      sender: item.sender,
      time: item.time,
      imageUrl: item.imageUrl,
      note: item.note,
      stats: item.stats,
      inferenceLabel: item.inferenceLabel,
      sourceMessageIds: item.sourceMessageIds,
      replyCount: item.replyCount
    }))

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
  const topSpeaker = Array.from(topSpeakersMap.entries()).sort(
    (left, right) => right[1] - left[1]
  )[0]
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
      visionGallery,
      voiceHighlights: voiceHighlights.slice(0, 2),
      funBadges: funBadges.slice(0, 3)
    },
    voiceLeaderboard,
    warnings
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
    .filter(
      (item) =>
        /[?？]$/.test(item.content) || item.content.includes('吗') || item.content.includes('怎么')
    )
    .slice(-6)
    .map((item) => `${item.sender}（${item.id}）：${truncate(item.content, 32)}`)

const collectReplyFacts = (
  messages: Message[],
  contact: Contact | null,
  isGroup: boolean
): string[] =>
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
    if (!isSystemMessage(message)) {
      speakerCounts.set(sender, (speakerCounts.get(sender) || 0) + 1)
      if (message.img && !avatars[sender]) avatars[sender] = message.img
    }
    if (Number.isFinite(timestamp)) {
      const hour = new Date(timestamp).getHours()
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1)
    }
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
    recordNote: `基于 TraceMemo 已加载的 ${transcriptRows.length} 条记录`,
    footerNote: '基于已读取聊天记录生成；图片、表情等未解析内容默认只按类型与上下文参与日报。',
    heroParticipants: topSpeakers.slice(0, 4).map((speaker) => speaker.name),
    avatars,
    reportMode
  }

  const { media, voiceLeaderboard, warnings } = await buildMediaSection(
    messages,
    contact,
    isGroup,
    speakerCounts
  )
  if (warnings.length) metadata.warnings = [...(metadata.warnings || []), ...warnings]
  if (imageCount > 0 && !media.visionGallery?.length) {
    metadata.footerNote = friendlyImageNotice(warnings)
  } else if (media.visionGallery?.length) {
    metadata.footerNote = `基于已读取聊天记录生成；其中 ${media.visionGallery.length} 张图片已由当前视觉模型识别。`
  }

  if (
    transcriptRows.length > 0 &&
    transcriptRows.every((row) => row.content === '[图片]') &&
    !media.visionGallery?.length
  ) {
    throw new Error(
      '当前范围只有图片，但这些图片暂时无法分析。请改选文字消息，或在设置中验证图片理解能力。'
    )
  }

  const factsPrompt = [
    `报告模式：${reportMode === 'compact' ? '精简版（30秒可读完）' : '完整版（保留更多上下文）'}`,
    `消息统计：共 ${transcriptRows.length} 条，活跃成员 ${speakerCounts.size} 人，图片 ${imageCount} 张，表情 ${stickerCount} 条，语音 ${voiceCount} 条（累计 ${voiceDurationSec} 秒）。`,
    activeTimeline ? `活跃时段：${activeTimeline}` : '',
    media.gallery.length
      ? `图片观察：${media.gallery.map((item) => `${item.time} ${item.sender} 发图（${item.stats}）`).join('；')}`
      : '',
    // AI 图片理解结果(由 ImageInsightService 提供,缓存命中或已调用 Vision)
    (media.visionGallery?.length ?? 0) > 0
      ? `AI 图片识别摘要：${(media.visionGallery || [])
          .map(
            (it) =>
              `[${it.time} ${it.sender}] ${it.description}${it.ocrText ? `（OCR: ${it.ocrText}）` : ''}${it.tags.length ? ` [${it.tags.join('/')}]` : ''}`
          )
          .join('；')}`
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
