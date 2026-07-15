import {
  GroupDailyReport,
  GroupReportMetadata,
  ReportHeat,
  ReportImportantMessage,
  ReportMode,
  ReportParticipantChain,
  ReportQuestionAnswer,
  ReportQuote,
  ReportResource,
  ReportReversal,
  ReportSectionKey,
  ReportSectionMeta,
  ReportSpeakerRank,
  ReportStoryline,
  ReportTodoItem,
  ReportTopic,
  ReportUnresolvedItem,
  ReportVoiceLeaderboardItem
} from '../../../shared/group-report'
import { Contact, Message } from '../../../shared/types'
import { buildGroupReportFacts } from './group-report-facts'

export const GROUP_REPORT_SYSTEM_PROMPT = `你是微信群聊日报编辑。请仅根据用户提供的聊天记录生成结构化中文日报。

总原则：
1. 不得编造聊天中没有的事实、结论、参与者或链接内容。
2. 仅使用输入中的昵称，不输出 wxid、微信 ID、会话 ID 等内部标识。
3. 图片、表情、语音、视频或链接内容不可见时，只能描述消息类型、互动效果和上下文，不能猜图片具体内容。
4. 先合并同一事件，再按重要性排序，避免一个事件在多个模块大段重复出现。
5. 优先保留结论、待办、未解决问题、明确通知，再保留趣味内容。
6. 负责人、截止日期、图片内容必须有聊天证据；没有证据就返回 null 或省略。
7. 不为了填满模板而生成内容，没有就输出空数组。
8. 所有候选条目尽量返回 sourceMessageIds，便于程序去重和追溯。
9. 精简版面向 30 秒阅读，摘要必须短；完整版可以保留更多候选项。
10. 只输出一个可被 JSON.parse 解析的 JSON 对象，不要输出 Markdown 代码块或其他文字。

JSON 结构必须为：
{
  "overview": "1至2句整体讨论风格与氛围",
  "hero": {
    "headline": "一句抓重点的日报标题",
    "summary": "一句总结今天发生了什么，最多3行",
    "keyTakeaway": "最重要结论，没有可空",
    "pendingNote": "最值得跟进的一项，没有可空",
    "statusLine": "例如：今日形成 3 个结论 · 2 个待办 · 1 个问题尚未解决"
  },
  "topics": [{
    "title": "话题标题",
    "timeRange": "HH:mm-HH:mm",
    "heat": "高|中|低",
    "participants": ["昵称"],
    "summary": "100字以内",
    "conclusion": "可选简短结论",
    "conclusions": [{"text":"关键结论","sourceMessageIds":["消息ID"]}],
    "keywords": ["关键词"],
    "sourceMessageIds": ["消息ID"]
  }],
  "resources": [{"title":"资源名","description":"用途或内容","sender":"昵称","sourceMessageIds":["消息ID"]}],
  "importantMessages": [{"sender":"昵称","time":"HH:mm","content":"消息摘要","note":"为什么重要","sourceMessageIds":["消息ID"],"importance":0.95,"confidence":0.9}],
  "quotes": [{"messages":[{"sender":"昵称","content":"简短原话","sourceMessageId":"消息ID"}],"note":"为什么好笑或值得看","sourceMessageIds":["消息ID"],"importance":0.8,"confidence":0.8}],
  "qa": [{"question":"问题","answer":"答案与结论","answerer":"昵称","sourceMessageIds":["消息ID"]}],
  "todos": [{"task":"待办事项","owner":"负责人或null","deadline":"截止时间或null","topic":"来源话题或null","note":"补充说明","sourceMessageIds":["消息ID"],"importance":0.95,"confidence":0.85}],
  "unresolved": [{"question":"待跟进的问题","owner":"提问者或相关人","status":"待跟进|暂未回答|进行中","note":"为什么还没结束","lastDiscussedAt":"HH:mm 或 null","sourceMessageIds":["消息ID"],"importance":0.9,"confidence":0.8}],
  "storylines": [{"title":"剧情线标题","stages":[{"time":"HH:mm","event":"发生了什么","sourceMessageIds":["消息ID"]}],"result":"结果","sourceMessageIds":["消息ID"]}],
  "reversals": [{"topic":"发生反转的话题","initialView":"最初判断","finalView":"最终判断","note":"为什么反转","sourceMessageIds":["消息ID"]}],
  "participantChains": [{"topic":"话题名","chain":["A 提出","B 补充","C 收尾"],"note":"链路说明","sourceMessageIds":["消息ID"]}],
  "keywords": ["关键词"]
}

额外要求：
- 精简版：热点最多4个、重要消息最多4条、待办最多5条、未解决最多3条、名场面最多2组、每组最多4条、关键词最多12个。
- 完整版：可以保留更多候选项，但仍要去重和排序。
- 如果某个字段不确定，请返回 null 或空数组，不要猜。`

export interface GroupReportInput {
  prompt: string
  metadata: GroupReportMetadata
  topSpeakers: ReportSpeakerRank[]
  activeTimeline: string
  voiceLeaderboard: ReportVoiceLeaderboardItem[]
  media: GroupDailyReport['media']
}

const REPORT_MODE_LABEL: Record<ReportMode, string> = {
  compact: '精简版（推荐）',
  full: '完整版'
}

interface ReportModeConfig {
  maxTopics: number
  maxImportantMessages: number
  maxTodos: number
  maxUnresolved: number
  maxQuotes: number
  maxQuoteMessages: number
  maxKeywords: number
  maxStorylines: number
  maxReversals: number
  maxChains: number
  maxGallery: number
  maxVoiceHighlights: number
  maxBadges: number
  maxResources: number
  maxQa: number
  topicSummaryLength: number
  noteLength: number
  enabledSections: ReportSectionKey[]
}

const REPORT_MODE_CONFIG: Record<ReportMode, ReportModeConfig> = {
  compact: {
    maxTopics: 3,
    maxImportantMessages: 3,
    maxTodos: 4,
    maxUnresolved: 3,
    maxQuotes: 1,
    maxQuoteMessages: 4,
    maxKeywords: 12,
    maxStorylines: 0,
    maxReversals: 0,
    maxChains: 0,
    maxGallery: 0,
    maxVoiceHighlights: 0,
    maxBadges: 0,
    maxResources: 0,
    maxQa: 0,
    topicSummaryLength: 100,
    noteLength: 72,
    enabledSections: [
      'hero',
      'topics',
      'importantMessages',
      'actions',
      'moments',
      'analytics',
      'keywords'
    ]
  },
  full: {
    maxTopics: 6,
    maxImportantMessages: 6,
    maxTodos: 8,
    maxUnresolved: 5,
    maxQuotes: 3,
    maxQuoteMessages: 5,
    maxKeywords: 15,
    maxStorylines: 2,
    maxReversals: 2,
    maxChains: 3,
    maxGallery: 4,
    maxVoiceHighlights: 2,
    maxBadges: 3,
    maxResources: 4,
    maxQa: 4,
    topicSummaryLength: 140,
    noteLength: 96,
    enabledSections: [
      'hero',
      'topics',
      'importantMessages',
      'actions',
      'moments',
      'analytics',
      'keywords',
      'resources',
      'qa',
      'storylines',
      'reversals',
      'vision',
      'gallery',
      'voices',
      'badges',
      'chains'
    ]
  }
}

export const buildGroupReportInput = async (
  messages: Message[],
  contact: Contact | null,
  isGroup: boolean,
  reportMode: ReportMode
): Promise<GroupReportInput> => {
  const facts = await buildGroupReportFacts(messages, contact, isGroup, reportMode)
  const desiredTopicCount =
    facts.metadata.messageCount >= 1000
      ? '建议提炼 6-8 个互不重复的主要话题'
      : facts.metadata.messageCount >= 500
        ? '建议提炼 5-6 个互不重复的主要话题'
        : facts.metadata.messageCount >= 200
          ? '建议提炼 4-5 个互不重复的主要话题'
          : '按实际内容提炼 1-4 个主要话题，不要为了凑数编造'
  const transcript = facts.transcriptRows
    .map((row) => `[${row.id}] ${row.datetime} ${row.sender}：${row.content}`)
    .join('\n')

  const prompt = `请为以下微信${isGroup ? '群聊' : '对话'}记录生成日报 JSON。

会话名：${facts.metadata.groupName}
时间范围：${facts.metadata.dateRange}
消息数：${facts.metadata.messageCount}
活跃人数：${facts.metadata.activeUsers}
目标模式：${REPORT_MODE_LABEL[reportMode]}
话题覆盖：${desiredTopicCount}
完整性：仅基于当前应用已加载的记录。

媒体与结构化事实（可引用行为，不可猜测图片内容）：
${facts.factsPrompt || '无'}

聊天记录：
${transcript}`

  return {
    prompt,
    metadata: facts.metadata,
    topSpeakers: facts.topSpeakers,
    activeTimeline: facts.activeTimeline,
    voiceLeaderboard: facts.voiceLeaderboard,
    media: facts.media
  }
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const asNullableString = (value: unknown): string | null => {
  const result = asString(value)
  return result || null
}
const asNumber = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asStrings = (value: unknown, limit = 20): string[] =>
  asArray(value).map(asString).filter(Boolean).slice(0, limit)

const normalizeName = (value: unknown): string => asString(value) || '未命名群成员'

const normalizeHeat = (value: unknown): ReportHeat => {
  const heat = asString(value)
  if (heat.includes('高')) return '高'
  if (heat.includes('低')) return '低'
  return '中'
}

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value

const extractJson = (raw: string): unknown => {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('AI 未返回可解析的日报 JSON')
  return JSON.parse(cleaned.slice(start, end + 1))
}

const createSignature = (...parts: Array<string | null | undefined>): string =>
  parts
    .map((part) => (part || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('|')
    .toLowerCase()

const parseTopics = (root: Record<string, unknown>): ReportTopic[] =>
  asArray(root.topics)
    .map((value) => {
      const item = asObject(value)
      return {
        title: asString(item.title),
        timeRange: asString(item.timeRange),
        heat: normalizeHeat(item.heat),
        participants: asArray(item.participants).map(normalizeName).filter(Boolean).slice(0, 5),
        summary: asString(item.summary),
        conclusion: asString(item.conclusion),
        conclusions: asArray(item.conclusions)
          .map((entry) => {
            const conclusion = asObject(entry)
            return {
              text: asString(conclusion.text),
              sourceMessageIds: asStrings(conclusion.sourceMessageIds, 6)
            }
          })
          .filter((entry) => entry.text)
          .slice(0, 4),
        keywords: asStrings(item.keywords, 8),
        sourceMessageIds: asStrings(item.sourceMessageIds, 12)
      }
    })
    .filter((topic) => topic.title && topic.summary)

const parseResources = (root: Record<string, unknown>): ReportResource[] =>
  asArray(root.resources)
    .map((value) => {
      const item = asObject(value)
      return {
        title: asString(item.title),
        description: asString(item.description),
        sender: item.sender ? normalizeName(item.sender) : undefined,
        sourceMessageIds: asStrings(item.sourceMessageIds, 6)
      }
    })
    .filter((item) => item.title && item.description)

const parseImportantMessages = (root: Record<string, unknown>): ReportImportantMessage[] =>
  asArray(root.importantMessages)
    .map((value) => {
      const item = asObject(value)
      return {
        sender: normalizeName(item.sender),
        time: asString(item.time),
        content: asString(item.content),
        note: asString(item.note),
        sourceMessageIds: asStrings(item.sourceMessageIds, 6),
        importance: asNumber(item.importance),
        confidence: asNumber(item.confidence)
      }
    })
    .filter((item) => item.sender && item.content)

const parseQuotes = (root: Record<string, unknown>): ReportQuote[] =>
  asArray(root.quotes)
    .map((value) => {
      const item = asObject(value)
      return {
        messages: asArray(item.messages)
          .map((messageValue) => {
            const message = asObject(messageValue)
            return {
              sender: normalizeName(message.sender),
              content: asString(message.content),
              sourceMessageId: asString(message.sourceMessageId)
            }
          })
          .filter((message) => message.sender && message.content),
        note: asString(item.note),
        sourceMessageIds: asStrings(item.sourceMessageIds, 8),
        importance: asNumber(item.importance),
        confidence: asNumber(item.confidence)
      }
    })
    .filter((quote) => quote.messages.length)

const parseQa = (root: Record<string, unknown>): ReportQuestionAnswer[] =>
  asArray(root.qa)
    .map((value) => {
      const item = asObject(value)
      return {
        question: asString(item.question),
        answer: asString(item.answer),
        answerer: item.answerer ? normalizeName(item.answerer) : undefined,
        sourceMessageIds: asStrings(item.sourceMessageIds, 8)
      }
    })
    .filter((item) => item.question && item.answer)

const parseTodos = (root: Record<string, unknown>): ReportTodoItem[] =>
  asArray(root.todos)
    .map((value) => {
      const item = asObject(value)
      return {
        task: asString(item.task),
        owner: item.owner === null ? null : item.owner ? normalizeName(item.owner) : undefined,
        deadline: item.deadline === null ? null : asNullableString(item.deadline),
        topic: item.topic === null ? null : asNullableString(item.topic),
        note: asString(item.note),
        sourceMessageIds: asStrings(item.sourceMessageIds, 8),
        importance: asNumber(item.importance),
        confidence: asNumber(item.confidence)
      }
    })
    .filter((item) => item.task)

const parseUnresolved = (root: Record<string, unknown>): ReportUnresolvedItem[] =>
  asArray(root.unresolved)
    .map((value) => {
      const item = asObject(value)
      const status = asString(item.status)
      const normalizedStatus: ReportUnresolvedItem['status'] =
        status === '暂未回答' || status === '进行中' || status === '待跟进' ? status : '待跟进'
      return {
        question: asString(item.question),
        owner: item.owner ? normalizeName(item.owner) : undefined,
        status: normalizedStatus,
        note: asString(item.note),
        lastDiscussedAt:
          item.lastDiscussedAt === null ? null : asNullableString(item.lastDiscussedAt),
        sourceMessageIds: asStrings(item.sourceMessageIds, 8),
        importance: asNumber(item.importance),
        confidence: asNumber(item.confidence)
      }
    })
    .filter((item) => item.question && item.note)

const parseStorylines = (root: Record<string, unknown>): ReportStoryline[] =>
  asArray(root.storylines)
    .map((value) => {
      const item = asObject(value)
      return {
        title: asString(item.title),
        stages: asArray(item.stages)
          .map((stageValue) => {
            const stage = asObject(stageValue)
            return {
              time: asString(stage.time),
              event: asString(stage.event),
              sourceMessageIds: asStrings(stage.sourceMessageIds, 6)
            }
          })
          .filter((stage) => stage.event),
        result: asString(item.result),
        sourceMessageIds: asStrings(item.sourceMessageIds, 8)
      }
    })
    .filter((item) => item.title && item.stages.length)

const parseReversals = (root: Record<string, unknown>): ReportReversal[] =>
  asArray(root.reversals)
    .map((value) => {
      const item = asObject(value)
      return {
        topic: asString(item.topic),
        initialView: asString(item.initialView),
        finalView: asString(item.finalView),
        note: asString(item.note),
        sourceMessageIds: asStrings(item.sourceMessageIds, 8)
      }
    })
    .filter((item) => item.topic && item.initialView && item.finalView)

const parseParticipantChains = (root: Record<string, unknown>): ReportParticipantChain[] =>
  asArray(root.participantChains)
    .map((value) => {
      const item = asObject(value)
      return {
        topic: asString(item.topic),
        chain: asStrings(item.chain, 5),
        note: asString(item.note),
        sourceMessageIds: asStrings(item.sourceMessageIds, 8)
      }
    })
    .filter((item) => item.topic && item.chain.length)

const scoreByHeat = (heat: ReportHeat): number =>
  heat === '高' ? 0.95 : heat === '中' ? 0.75 : 0.55

const scoreByCount = (count: number, max = 5): number => Math.min(1, Math.max(0.3, count / max))

const dedupeItems = <T>(
  items: T[],
  getSources: (item: T) => string[],
  getSignature: (item: T) => string
): T[] => {
  const seenSources = new Set<string>()
  const seenSignatures = new Set<string>()
  const result: T[] = []
  for (const item of items) {
    const signature = getSignature(item)
    const sources = getSources(item).filter(Boolean)
    const sourceOverlap = sources.some((source) => seenSources.has(source))
    if (signature && seenSignatures.has(signature)) continue
    if (sourceOverlap && sources.length) continue
    result.push(item)
    if (signature) seenSignatures.add(signature)
    for (const source of sources) seenSources.add(source)
  }
  return result
}

const sortByScore = <T>(items: T[], scorer: (item: T) => number): T[] =>
  [...items].sort((left, right) => scorer(right) - scorer(left))

const buildSectionMeta = (
  enabled: boolean,
  displayedCount: number,
  totalCount: number,
  importance: number,
  confidence: number
): ReportSectionMeta => ({
  enabled: enabled && displayedCount > 0,
  importance,
  confidence,
  totalCount,
  displayedCount,
  hiddenCount: Math.max(0, totalCount - displayedCount)
})

const clampTopics = (topics: ReportTopic[], config: ReportModeConfig): ReportTopic[] =>
  topics.slice(0, config.maxTopics).map((topic) => ({
    ...topic,
    summary: truncate(topic.summary, config.topicSummaryLength),
    conclusions: (topic.conclusions || [])
      .slice(0, 2)
      .map((entry) => ({ ...entry, text: truncate(entry.text, config.noteLength) })),
    conclusion: topic.conclusion ? truncate(topic.conclusion, config.noteLength) : topic.conclusion,
    keywords: topic.keywords.slice(0, 3)
  }))

const topicLimitForMessageVolume = (
  config: ReportModeConfig,
  messageCount: number
): ReportModeConfig => {
  if (messageCount >= 1000) return { ...config, maxTopics: Math.max(config.maxTopics, 8) }
  if (messageCount >= 500) return { ...config, maxTopics: Math.max(config.maxTopics, 6) }
  if (messageCount >= 200) return { ...config, maxTopics: Math.max(config.maxTopics, 5) }
  if (messageCount >= 80) return { ...config, maxTopics: Math.max(config.maxTopics, 4) }
  return config
}

const attachHighImpactImage = (
  topics: ReportTopic[],
  gallery: GroupDailyReport['media']['gallery'],
  visionGallery?: GroupDailyReport['media']['visionGallery']
): ReportTopic[] => {
  if (!gallery.length && !visionGallery?.length) return topics
  // 优先用 visionGallery(AI 真实识别的 description)
  const firstVision = visionGallery?.find((it) => it.importance !== 'low')
  const [firstImage, ...rest] = gallery
  const nextTopics = topics.map((topic, index) => {
    if (index !== 0) return topic
    if (firstVision) {
      // AI 真实识别路径:note 直接用 description,不带"根据推断"前缀
      const noteParts = [firstVision.description]
      if (firstVision.ocrText) noteParts.push(`文字:${firstVision.ocrText}`)
      if (firstVision.tags.length) noteParts.push(`标签:${firstVision.tags.join('/')}`)
      return {
        ...topic,
        image: {
          note: noteParts.join(' · '),
          sourceMessageIds: firstVision.sourceMessageIds
          // 注意:不填 imageUrl,因为 unknown imageHash 等问题可能导致 main 取不到原图,
          // 让 renderer 在 buildGroupReportFacts 阶段就把 dataUrl 预先加载好塞到 gallery 里,
          // 这里走 gallery 路径自然带 imageUrl
        }
      }
    }
    if (firstImage?.replyCount && firstImage.replyCount >= 3) {
      return {
        ...topic,
        image: {
          imageUrl: firstImage.imageUrl,
          note: `该图片引发 ${firstImage.replyCount} 条回复。${firstImage.note.startsWith('根据') ? firstImage.note : `根据图片前后对话推断，${firstImage.note}`}`,
          sourceMessageIds: firstImage.sourceMessageIds
        }
      }
    }
    return topic
  })
  if (firstVision) {
    // visionGallery 用过的不再展示
    return nextTopics
  }
  gallery.splice(0, rest.length >= 0 ? 1 : 0)
  return nextTopics
}

const postProcessReport = (
  report: GroupDailyReport,
  mode: ReportMode,
  metadata: GroupReportMetadata
): GroupDailyReport => {
  const config = topicLimitForMessageVolume(REPORT_MODE_CONFIG[mode], metadata.messageCount)

  const topicsScored = sortByScore(report.topics, (item) => scoreByHeat(item.heat))
  const topicsDeduped = dedupeItems(
    topicsScored,
    (item) => item.sourceMessageIds || [],
    (item) => createSignature(item.title, item.summary)
  )
  const gallery = [...report.media.gallery]
  const topics = attachHighImpactImage(
    clampTopics(topicsDeduped, config),
    gallery,
    report.media.visionGallery
  )

  const importantMessagesRaw = sortByScore(report.importantMessages, (item) =>
    Math.max(item.importance || 0, item.confidence || 0.6)
  ).filter((item) => (mode === 'compact' ? (item.confidence || 0) >= 0.55 : true))
  const importantMessages = dedupeItems(
    importantMessagesRaw,
    (item) => item.sourceMessageIds || [],
    (item) => createSignature(item.content, item.note)
  )
    .slice(0, config.maxImportantMessages)
    .map((item) => ({
      ...item,
      content: truncate(item.content, config.noteLength),
      note: truncate(item.note, config.noteLength)
    }))

  const todosRaw = sortByScore(report.todos, (item) =>
    Math.max(item.importance || 0.6, item.confidence || 0.5)
  ).filter((item) => (mode === 'compact' ? (item.confidence || 0) >= 0.5 : true))
  const todos = dedupeItems(
    todosRaw,
    (item) => item.sourceMessageIds || [],
    (item) => createSignature(item.task, item.owner || '', item.deadline || '')
  )
    .slice(0, config.maxTodos)
    .map((item) => ({
      ...item,
      task: truncate(item.task, config.noteLength),
      note: item.note ? truncate(item.note, config.noteLength) : item.note
    }))

  const unresolvedRaw = sortByScore(report.unresolved, (item) =>
    Math.max(item.importance || 0.6, item.confidence || 0.5)
  ).filter((item) => (mode === 'compact' ? (item.confidence || 0) >= 0.45 : true))
  const unresolved = dedupeItems(
    unresolvedRaw,
    (item) => item.sourceMessageIds || [],
    (item) => createSignature(item.question, item.note)
  )
    .slice(0, config.maxUnresolved)
    .map((item) => ({
      ...item,
      question: truncate(item.question, config.noteLength),
      note: truncate(item.note, config.noteLength)
    }))

  const quotesRaw = sortByScore(report.quotes, (item) =>
    Math.max(
      item.importance || 0.55,
      item.confidence || 0.55,
      scoreByCount(item.messages.length, 4)
    )
  )
  const quotes = dedupeItems(
    quotesRaw,
    (item) =>
      item.sourceMessageIds || item.messages.map((message) => message.sourceMessageId || ''),
    (item) => createSignature(item.note, item.messages.map((message) => message.content).join('|'))
  )
    .slice(0, config.maxQuotes)
    .map((item) => ({
      ...item,
      messages: item.messages.slice(0, config.maxQuoteMessages).map((message) => ({
        ...message,
        content: truncate(message.content, Math.min(config.noteLength, 38))
      })),
      note: truncate(item.note, config.noteLength)
    }))

  const resources = report.resources.slice(0, config.maxResources)
  const qa = report.qa.slice(0, config.maxQa)
  const storylines = report.storylines.slice(0, config.maxStorylines)
  const reversals = report.reversals.slice(0, config.maxReversals)
  const participantChains = report.participantChains.slice(0, config.maxChains)
  const voiceHighlights = report.media.voiceHighlights.slice(0, config.maxVoiceHighlights)
  const funBadges = report.media.funBadges.slice(0, config.maxBadges)
  const keywords = report.keywords.slice(0, config.maxKeywords)

  const conclusionCount =
    topics.reduce((count, topic) => count + (topic.conclusions?.length || 0), 0) +
    importantMessages.length
  const summaryStats = {
    messageCount: metadata.messageCount,
    activeUsers: metadata.activeUsers,
    topicCount: topics.length,
    mediaCount: metadata.mediaMessageCount || 0,
    imageCount: metadata.imageCount || 0,
    voiceCount: metadata.voiceCount || 0,
    stickerCount: metadata.stickerCount || 0,
    conclusionCount,
    todoCount: todos.length,
    unresolvedCount: unresolved.length
  }

  const hero = {
    headline:
      report.hero?.headline ||
      topics[0]?.title ||
      `${metadata.groupName}${mode === 'compact' ? '速览' : '日报'}`,
    summary: truncate(
      report.hero?.summary || report.overview || '今天群里有新的讨论进展。',
      mode === 'compact' ? 84 : 120
    ),
    keyTakeaway: report.hero?.keyTakeaway
      ? truncate(report.hero.keyTakeaway, config.noteLength)
      : undefined,
    pendingNote: report.hero?.pendingNote
      ? truncate(report.hero.pendingNote, config.noteLength)
      : undefined,
    statusLine:
      report.hero?.statusLine ||
      `今日形成 ${summaryStats.conclusionCount} 个结论 · ${summaryStats.todoCount} 个待办 · ${summaryStats.unresolvedCount} 个问题尚未解决`
  }

  const sectionMeta: Partial<Record<ReportSectionKey, ReportSectionMeta>> = {
    hero: buildSectionMeta(true, 1, 1, 1, 0.95),
    topics: buildSectionMeta(
      config.enabledSections.includes('topics'),
      topics.length,
      report.topics.length,
      0.98,
      0.85
    ),
    importantMessages: buildSectionMeta(
      config.enabledSections.includes('importantMessages'),
      importantMessages.length,
      report.importantMessages.length,
      0.95,
      0.82
    ),
    actions: buildSectionMeta(
      config.enabledSections.includes('actions'),
      todos.length + unresolved.length,
      report.todos.length + report.unresolved.length,
      0.97,
      0.8
    ),
    moments: buildSectionMeta(
      config.enabledSections.includes('moments'),
      quotes.length,
      report.quotes.length,
      0.75,
      0.72
    ),
    analytics: buildSectionMeta(config.enabledSections.includes('analytics'), 1, 1, 0.8, 0.95),
    keywords: buildSectionMeta(
      config.enabledSections.includes('keywords'),
      keywords.length,
      report.keywords.length,
      0.68,
      0.9
    ),
    resources: buildSectionMeta(
      config.enabledSections.includes('resources'),
      resources.length,
      report.resources.length,
      0.55,
      0.75
    ),
    qa: buildSectionMeta(
      config.enabledSections.includes('qa'),
      qa.length,
      report.qa.length,
      0.62,
      0.78
    ),
    storylines: buildSectionMeta(
      config.enabledSections.includes('storylines'),
      storylines.length,
      report.storylines.length,
      0.63,
      0.74
    ),
    reversals: buildSectionMeta(
      config.enabledSections.includes('reversals'),
      reversals.length,
      report.reversals.length,
      0.54,
      0.72
    ),
    vision: buildSectionMeta(
      config.enabledSections.includes('vision'),
      report.media.visionGallery?.length || 0,
      report.media.visionGallery?.length || 0,
      0.72,
      0.9
    ),
    gallery: buildSectionMeta(
      config.enabledSections.includes('gallery'),
      gallery.length,
      report.media.gallery.length,
      0.6,
      0.8
    ),
    voices: buildSectionMeta(
      config.enabledSections.includes('voices'),
      voiceHighlights.length,
      report.media.voiceHighlights.length,
      0.56,
      0.84
    ),
    badges: buildSectionMeta(
      config.enabledSections.includes('badges'),
      funBadges.length,
      report.media.funBadges.length,
      0.45,
      0.65
    ),
    chains: buildSectionMeta(
      config.enabledSections.includes('chains'),
      participantChains.length,
      report.participantChains.length,
      0.58,
      0.71
    )
  }

  return {
    ...report,
    mode,
    hero,
    topics,
    resources,
    importantMessages,
    quotes,
    qa,
    todos,
    unresolved,
    storylines,
    reversals,
    participantChains,
    keywords,
    media: {
      gallery,
      visionGallery: report.media.visionGallery,
      voiceHighlights,
      funBadges
    },
    summaryStats,
    sectionMeta
  }
}

export const parseGroupDailyReport = (
  raw: string,
  topSpeakers: ReportSpeakerRank[],
  activeTimeline: string,
  voiceLeaderboard: ReportVoiceLeaderboardItem[],
  metadata: GroupReportMetadata,
  media: GroupDailyReport['media']
): GroupDailyReport => {
  const root = asObject(extractJson(raw))
  const topics = parseTopics(root)
  if (!topics.length) throw new Error('AI 日报中没有有效话题')

  const heroRoot = asObject(root.hero)
  const report: GroupDailyReport = {
    overview: asString(root.overview) || '基于已读取记录生成的群聊日报。',
    mode: metadata.reportMode || 'compact',
    hero:
      heroRoot && Object.keys(heroRoot).length
        ? {
            headline: asString(heroRoot.headline) || topics[0]?.title || '今日群聊速览',
            summary:
              asString(heroRoot.summary) || asString(root.overview) || '今天群里有新的讨论进展。',
            keyTakeaway: asString(heroRoot.keyTakeaway),
            pendingNote: asString(heroRoot.pendingNote),
            statusLine: asString(heroRoot.statusLine)
          }
        : undefined,
    topics,
    resources: parseResources(root),
    importantMessages: parseImportantMessages(root),
    quotes: parseQuotes(root),
    qa: parseQa(root),
    todos: parseTodos(root),
    unresolved: parseUnresolved(root),
    storylines: parseStorylines(root),
    reversals: parseReversals(root),
    participantChains: parseParticipantChains(root),
    analytics: {
      topicHeat: topics.map((topic) => ({
        topic: topic.title,
        score: topic.heat === '高' ? 100 : topic.heat === '中' ? 65 : 35
      })),
      activeTimeline: activeTimeline || '暂无可用时间统计',
      topSpeakers: topSpeakers.map((speaker) => ({
        name: speaker.name,
        count: Math.max(0, asNumber(speaker.count))
      })),
      voiceLeaderboard
    },
    keywords: asStrings(root.keywords, 15),
    media
  }

  return postProcessReport(report, metadata.reportMode || 'compact', metadata)
}

// ============================================================
// main 分支兼容导出(SummaryDateRange / getSummaryDateRange 等)
// 用于让 App.tsx / useGroupReportGeneration.ts 等 main 分支文件能继续编译
// ============================================================
export type SummaryDateRange = 'today' | 'yesterday' | '7days'
export type SummaryMessageType =
  | 'text'
  | 'image'
  | 'sticker'
  | 'video'
  | 'voice'
  | 'share'
  | 'system'

export const SUMMARY_DATE_OPTIONS: { value: SummaryDateRange; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: 'yesterday', label: '昨日' },
  { value: '7days', label: '近 7 天' }
]

export const SUMMARY_TYPE_OPTIONS: {
  value: SummaryMessageType
  label: string
  messageTypes: string[]
  description: string
}[] = [
  {
    value: 'text',
    label: '文本',
    messageTypes: ['普通文本'],
    description: '使用文本内容、发送者和时间。'
  },
  {
    value: 'image',
    label: '图片',
    messageTypes: ['图片'],
    description: '图片 AI 识别结果将作为 ImageInsight 注入日报(由 ImageInsightService 提供)。'
  },
  {
    value: 'sticker',
    label: '表情包',
    messageTypes: ['表情包'],
    description: '不理解表情内容，仅按类型参与统计。'
  },
  {
    value: 'video',
    label: '视频',
    messageTypes: ['视频'],
    description: '不理解视频画面，仅按类型参与统计。'
  },
  {
    value: 'voice',
    label: '语音',
    messageTypes: ['语音'],
    description: '当前不转写语音，仅参与数量和活跃度统计。'
  },
  {
    value: 'share',
    label: '分享/引用',
    messageTypes: ['分享消息', '名片', '位置', '通话'],
    description: '使用解析到的标题、引用文本或类型信息。'
  },
  {
    value: 'system',
    label: '系统消息',
    messageTypes: ['系统消息'],
    description: '使用系统消息文本或类型信息。'
  }
]

export const getSummaryDateRange = (
  range: SummaryDateRange
): { startTime: number; endTime: number } => {
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

export const isInternalName = (value?: string): boolean => {
  const text = String(value || '').trim()
  return (
    !text || /^wxid_/i.test(text) || /@chatroom$/i.test(text) || /^[a-z0-9_-]{18,}$/i.test(text)
  )
}
