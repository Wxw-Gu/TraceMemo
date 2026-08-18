import type { Contact, Message } from '../../../../shared/types'
import type { AISearchCacheRecord, EvidenceItem, GroupMemberName, SearchIntent, SearchQueryPlan, SearchRange, SearchScope } from './searchTypes'

export const RANGE_LABELS: Record<SearchRange, string> = {
  today: '今天',
  '7d': '近 7 天',
  '30d': '近 30 天',
  all: '全部历史'
}

// Search intent/coverage semantics are program-owned; never replay results
// created before the current Evidence Collection contract.
export const SEARCH_CACHE_KEY = 'wxe_ai_search_cache_v12'
export const SEARCH_ACTIVE_RESULT_KEY = 'wxe_ai_search_active_result_v1'
export const SEARCH_HISTORY_KEY = 'wxe_ai_search_history_v1'
export const SEARCH_CACHE_LIMIT = 20
export const currentTimestamp = (): number => Date.now()

const SEARCH_INTENT_PHRASES = [
  '全局搜一下',
  '全局搜索',
  '搜索一下',
  '搜一下',
  '查询一下',
  '查一下',
  '找一下',
  '我和谁聊过',
  '谁和我聊过',
  '哪些人和我聊过',
  '最近讨论了什么',
  '最近聊了什么',
  '最近说了什么',
  '讨论了什么',
  '讨论什么',
  '聊了什么',
  '聊些什么',
  '说了什么',
  '说些什么',
  '最近讨论',
  '最近聊天',
  '这个话题',
  '相关话题',
  '的聊天',
  '的内容',
  '的记录',
  '关于',
  '聊天',
  '记录',
  '聊天记录',
  '帮我',
  '请问'
].sort((left, right) => right.length - left.length)

const SEARCH_STOP_WORDS = new Set([
  '我',
  '谁',
  '什么',
  '哪些',
  '哪个',
  '人',
  '和',
  '聊过',
  '说过',
  '提到',
  '讨论',
  '聊天',
  '记录',
  '说',
  '聊',
  '话题',
  '内容',
  '相关',
  '最近',
  '一下'
])

export const messageText = (message: Message): string =>
  String(message.content || '').trim() || `[${message.type || '消息'}]`

export const normalizeSearchText = (value: string): string => value.toLowerCase().replace(/\s+/g, '')

export const includesSearchAlias = (query: string, alias: string): boolean => {
  const normalizedAlias = normalizeSearchText(alias.trim())
  return Boolean(normalizedAlias) && normalizeSearchText(query).includes(normalizedAlias)
}

const extractSearchKeywords = (query: string): string[] => {
  const cleanedQuery = SEARCH_INTENT_PHRASES.reduce(
    (value, phrase) => value.split(phrase).join(' '),
    query.toLowerCase()
  )
  const tokens = cleanedQuery
    .split(/[\s,，。！？!?、:：;；"“”‘’()（）[\]【】]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !SEARCH_STOP_WORDS.has(token))
  return Array.from(new Set(tokens))
}

const getFuzzySearchKeywords = (keywords: string[]): string[] =>
  Array.from(
    new Set(
      keywords.flatMap((keyword) => {
        const variants = [keyword]
        if (/^[\u4e00-\u9fff]+$/.test(keyword) && keyword.length > 2) {
          variants.push(keyword.slice(-2))
        }
        return variants
      })
    )
  )

const normalizeSearchTerms = (terms: unknown): string[] => {
  if (!Array.isArray(terms)) return []
  return Array.from(
    new Set(
      terms
        .filter((term): term is string => typeof term === 'string')
        .map((term) => term.trim())
        .filter((term) => term.length >= 2 && term.length <= 32)
    )
  ).slice(0, 16)
}

export const buildLocalSearchPlan = (query: string): SearchQueryPlan => {
  const keywords = extractSearchKeywords(query)
  const asksParticipants = /我和谁|谁和我|哪些人|哪个人|哪些联系人/.test(query)
  const intent: SearchIntent = asksParticipants
    ? keywords.length
      ? 'mixed'
      : 'participants'
    : keywords.length
      ? 'topic'
      : 'general'
  return {
    intent,
    keywords,
    variants: getFuzzySearchKeywords(keywords),
    source: 'local'
  }
}

export const parseSearchPlanResponse = (value: string): Partial<SearchQueryPlan> | null => {
  const jsonMatch = value.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
    const intent = ['general', 'topic', 'participants', 'mixed'].includes(String(parsed.intent))
      ? (parsed.intent as SearchIntent)
      : undefined
    return {
      intent,
      keywords: normalizeSearchTerms(parsed.keywords),
      variants: normalizeSearchTerms(parsed.variants)
    }
  } catch {
    return null
  }
}

export const mergeSearchPlans = (
  localPlan: SearchQueryPlan,
  aiPlan: Partial<SearchQueryPlan> | null
): SearchQueryPlan => {
  if (!aiPlan) return localPlan
  const keywords = normalizeSearchTerms([...(localPlan.keywords || []), ...(aiPlan.keywords || [])])
  const variants = normalizeSearchTerms([
    ...getFuzzySearchKeywords(keywords),
    ...(localPlan.variants || []),
    ...(aiPlan.variants || [])
  ])
  return {
    intent: aiPlan.intent || localPlan.intent,
    keywords,
    variants,
    source: 'hybrid'
  }
}

export const messageIdentity = (message: Message): string =>
  message.localId
    ? `local:${message.localId}`
    : message.id || `${message.createTime}:${message.content}`

export const evidenceIdentity = ({ contact, message }: EvidenceItem): string =>
  `${contact.md5}:${messageIdentity(message)}`

export const formatMessageTime = (message: Message): string => {
  if (message.datetime) return message.datetime
  if (message.createTime) return new Date(message.createTime * 1000).toLocaleString('zh-CN')
  return '未知时间'
}

export const getRangeStart = (range: SearchRange): number | undefined => {
  if (range === 'all') return undefined
  if (range === 'today') {
    const now = new Date()
    return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
  }
  const days = range === '7d' ? 7 : 30
  return Math.floor(Date.now() / 1000) - days * 86400
}

export const messageDateKey = (message: Message): string => {
  if (!message.createTime) return 'unknown'
  const date = new Date(message.createTime * 1000)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const formatMessageDate = (dateKey: string): string => {
  if (dateKey === 'unknown') return '--/--'
  const [, month, day] = dateKey.split('-')
  return `${month}/${day}`
}

export const selectEvenly = <T,>(items: T[], count: number): T[] => {
  if (count >= items.length) return items
  if (count <= 0) return []
  if (count === 1) return [items[items.length - 1]]
  return Array.from({ length: count }, (_item, index) => {
    const itemIndex = Math.round((index * (items.length - 1)) / (count - 1))
    return items[itemIndex]
  })
}

export const selectEvidenceByDate = (items: EvidenceItem[], maxItems: number): EvidenceItem[] => {
  const buckets = new Map<string, EvidenceItem[]>()
  items.forEach((item) => {
    const key = messageDateKey(item.message)
    const bucket = buckets.get(key) || []
    bucket.push(item)
    buckets.set(key, bucket)
  })
  const entries = Array.from(buckets.entries()).sort(([left], [right]) => left.localeCompare(right))
  const targetCount = Math.min(maxItems, items.length)
  const counts = entries.map(() => 0)
  let remaining = targetCount
  while (remaining > 0) {
    let bestIndex = -1
    let bestRemaining = 0
    entries.forEach(([, bucket], index) => {
      const available = bucket.length - counts[index]
      if (available > bestRemaining) {
        bestIndex = index
        bestRemaining = available
      }
    })
    if (bestIndex < 0) break
    counts[bestIndex] += 1
    remaining -= 1
  }
  return entries
    .flatMap((entry, index) => selectEvenly(entry[1], counts[index]))
    .sort((left, right) => (left.message.createTime || 0) - (right.message.createTime || 0))
}

const looksLikeUserId = (value: string): boolean =>
  value.startsWith('wxid_') || value.includes('@chatroom') || /^\d{6,}$/.test(value)

export const formatMemberName = (member: GroupMemberName): string =>
  member.groupNickname || member.wechatNickname || member.nickname || member.remark || member.wxid

export const senderName = (message: Message, contact: Contact, names: Record<string, string>): string => {
  const identifiers = [message.senderId, message.from, message.name].filter(
    (value): value is string => Boolean(value?.trim())
  )
  const mappedName = identifiers.map((value) => names[value]).find(Boolean)
  if (mappedName) return mappedName
  if (message.name && !looksLikeUserId(message.name)) return message.name
  if (message.isSender) return '我'
  return contact.type === 'user' ? contact.m_nsNickName || '联系人' : '群成员'
}

export const compactCacheItem = ({ evidenceId, contact, message }: EvidenceItem): EvidenceItem => ({
  evidenceId,
  contact: {
    md5: contact.md5,
    m_nsUsrName: contact.m_nsUsrName,
    m_nsNickName: contact.m_nsNickName,
    type: contact.type,
    avatar: contact.avatar
  },
  message: {
    id: message.id,
    from: message.from,
    type: message.type,
    datetime: message.datetime,
    content: message.content,
    isSender: message.isSender,
    name: message.name,
    senderId: message.senderId,
    localId: message.localId,
    serverId: message.serverId,
    createTime: message.createTime
  }
})

export const buildSearchCacheKey = (
  scope: SearchScope,
  contactMd5: string,
  range: SearchRange,
  query: string
): string => JSON.stringify([scope, contactMd5, range, query.trim().toLowerCase()])

export const parseSearchCacheKey = (
  key: string
): { scope: SearchScope; contactMd5: string; range: SearchRange; query: string } | null => {
  try {
    const parts = JSON.parse(key) as unknown
    if (
      !Array.isArray(parts) ||
      !['global', 'conversation'].includes(String(parts[0])) ||
      !['today', '7d', '30d', 'all'].includes(String(parts[2])) ||
      typeof parts[3] !== 'string'
    ) {
      return null
    }
    return {
      scope: parts[0] as SearchScope,
      contactMd5: typeof parts[1] === 'string' ? parts[1] : '',
      range: parts[2] as SearchRange,
      query: parts[3]
    }
  } catch {
    return null
  }
}

export const readSearchCache = (key: string): AISearchCacheRecord | null => {
  try {
    const records = JSON.parse(
      localStorage.getItem(SEARCH_CACHE_KEY) || '[]'
    ) as AISearchCacheRecord[]
    const record = records.find((item) => item.version === 3 && item.key === key)
    return record || null
  } catch {
    return null
  }
}

export const readSearchCacheByQuery = (
  query: string
): { record: AISearchCacheRecord; location: ReturnType<typeof parseSearchCacheKey> } | null => {
  try {
    const records = JSON.parse(
      localStorage.getItem(SEARCH_CACHE_KEY) || '[]'
    ) as AISearchCacheRecord[]
    const normalizedQuery = query.trim().toLowerCase()
    for (const record of records) {
      const location = parseSearchCacheKey(record.key)
      if (record.version === 3 && location?.query === normalizedQuery) {
        return { record, location }
      }
    }
    return null
  } catch {
    return null
  }
}

export const writeSearchCache = (record: AISearchCacheRecord): void => {
  try {
    const records = JSON.parse(
      localStorage.getItem(SEARCH_CACHE_KEY) || '[]'
    ) as AISearchCacheRecord[]
    const nextRecords = [record, ...records.filter((item) => item.key !== record.key)].slice(
      0,
      SEARCH_CACHE_LIMIT
    )
    localStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify(nextRecords))
  } catch {
    // A large message result must not break the search itself.
  }
}
