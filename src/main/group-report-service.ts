import { app, BrowserWindow } from 'electron'
import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import {
  GroupReportExportRequest,
  GroupReportExportResult,
  GroupReportMetadata,
  GroupReportRenderSnapshot,
  GroupReportRenderSnapshotExportRequest,
  ReportHeat,
  ReportSectionMeta,
  selectHeroParticipantNames
} from '../shared/group-report'
import { resolveMd5, getGroupSnapshot } from './services/chat-service'
import { imageInsightService } from './services/image-insight-service'
import { getReportTemplate } from '../shared/report-templates'

const LEGACY_TEMPLATE_FILES: Record<string, string> = {
  v1: 'mobile_daily_report_v1.html',
  v2: 'mobile_daily_report_v2.html'
}

const templatePath = (templateId?: string): string => {
  const name = LEGACY_TEMPLATE_FILES[templateId || ''] || getReportTemplate(templateId).resourceFile
  const candidates = [
    path.join(process.resourcesPath, 'resources', name),
    path.join(app.getAppPath(), 'resources', name),
    path.join(process.cwd(), 'resources', name)
  ]
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) throw new Error(`日报模板不存在: ${candidates.join(' | ')}`)
  return found
}

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')

const sanitizeFileName = (value: string): string =>
  value
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || '未命名群聊'

const hashName = (name: string): number => {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash
}

const fallbackAvatar = (name: string): string => {
  const hue = hashName(name) % 360
  const initial = escapeHtml(Array.from(name.trim())[0] || '?')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="18" fill="hsl(${hue} 45% 82%)"/><text x="48" y="58" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,PingFang SC,sans-serif" font-size="38" fill="hsl(${hue} 35% 28%)">${initial}</text></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

const imageMimeType = (contentType: string | null, source: string): string => {
  if (contentType?.startsWith('image/')) return contentType.split(';')[0]
  const extension = path.extname(source).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  return 'image/jpeg'
}

const embedAvatar = async (source: string | undefined, name: string): Promise<string> => {
  if (!source) return fallbackAvatar(name)
  if (/^data:image\/[a-z0-9.+/-]+;base64,[a-z0-9+/=]+$/i.test(source)) return source

  try {
    if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source, {
        headers: {
          'User-Agent': 'Mozilla/5.0 TraceMemo',
          Referer: 'https://weixin.qq.com/'
        },
        signal: AbortSignal.timeout(8000)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const mime = imageMimeType(response.headers.get('content-type'), source)
      return `data:${mime};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`
    }

    const localPath = source.startsWith('file://') ? new URL(source) : source
    const buffer = await fs.readFile(localPath)
    return `data:${imageMimeType(null, source)};base64,${buffer.toString('base64')}`
  } catch (error) {
    console.warn(`[GroupReport] avatar fallback for ${name}:`, error)
    return fallbackAvatar(name)
  }
}

/**
 * 从群成员快照反推真头像,填进 metadata.avatars。
 * - 没传 talker → 跳过(向后兼容)
 * - talker 解析失败 / snapshot 拿不到 → 200 + warn,继续走 fallback
 * - 客户端传的 avatars[name](非空)优先;否则从 snapshot 的 m_nsHeadImgUrl 补
 * - 同名取首条(P2 风险:群里两人同名)
 */
const enrichAvatarsFromGroup = async (metadata: GroupReportMetadata): Promise<void> => {
  if (!metadata.talker) return

  const resolved = resolveMd5(metadata.talker)
  if (!resolved) {
    metadata.warnings = metadata.warnings ?? []
    metadata.warnings.push(`enrich skipped: talker "${metadata.talker}" not found`)
    return
  }

  const snapshot = getGroupSnapshot(resolved.md5)
  if (!snapshot) {
    metadata.warnings = metadata.warnings ?? []
    metadata.warnings.push(`enrich skipped: group snapshot not available for "${metadata.talker}"`)
    return
  }

  const index = new Map<string, string>()
  for (const member of snapshot.members) {
    if (member.nickname && member.avatar && !index.has(member.nickname)) {
      index.set(member.nickname, member.avatar)
    }
  }

  metadata.avatars = metadata.avatars ?? {}
  for (const [name, url] of index) {
    if (metadata.avatars[name]) continue
    metadata.avatars[name] = url
  }

  metadata.warnings = metadata.warnings ?? []
  metadata.warnings.push(
    `enriched ${index.size} member avatars from snapshot (${snapshot.memberCount} members)`
  )
}

const heatClass = (heat: ReportHeat): string => {
  if (heat === '高') return 'hot'
  if (heat === '低') return 'blue'
  return ''
}

const replacePlaceholder = (html: string, key: string, value: string): string =>
  html.replaceAll(`{{${key}}}`, value)

const sectionMeta = (
  request: GroupReportExportRequest,
  key: keyof NonNullable<typeof request.report.sectionMeta>
): ReportSectionMeta | undefined => request.report.sectionMeta?.[key]

const sectionClass = (
  request: GroupReportExportRequest,
  key: keyof NonNullable<typeof request.report.sectionMeta>,
  hasContent: boolean
): string => (sectionMeta(request, key)?.enabled && hasContent ? '' : 'empty-section')

const overflowNote = (
  request: GroupReportExportRequest,
  key: keyof NonNullable<typeof request.report.sectionMeta>
): string => {
  const meta = sectionMeta(request, key)
  if (request.metadata.reportMode !== 'compact' || !meta?.hiddenCount) return ''
  return `<div class="section-more">另有 ${meta.hiddenCount} 条内容，请在完整版中查看</div>`
}

const renderReportHtml = async (request: GroupReportExportRequest): Promise<string> => {
  const { report, metadata } = request
  const template = getReportTemplate(request.templateId)
  const avatarNames = new Set<string>(metadata.heroParticipants)
  report.topics.forEach((topic) => topic.participants.forEach((name) => avatarNames.add(name)))
  report.importantMessages.forEach((message) => avatarNames.add(message.sender))
  report.quotes.forEach((quote) =>
    quote.messages.forEach((message) => avatarNames.add(message.sender))
  )
  report.analytics.topSpeakers.forEach((speaker) => avatarNames.add(speaker.name))
  report.media?.voiceHighlights?.forEach((item) => avatarNames.add(item.sender))
  report.media?.funBadges?.forEach((item) => avatarNames.add(item.owner))

  const avatars = new Map<string, string>()
  await Promise.all(
    Array.from(avatarNames).map(async (name) => {
      avatars.set(name, await embedAvatar(metadata.avatars[name], name))
    })
  )
  const avatar = (name: string): string => avatars.get(name) || fallbackAvatar(name)

  const heroNames = selectHeroParticipantNames(metadata.heroParticipants)
  const heroAvatars = heroNames
    .map((name) => `<img src="${avatar(name)}" alt="${escapeHtml(name)}">`)
    .join('')
  const heroAvatarClass = heroNames.length ? `avatar-count-${heroNames.length}` : 'empty-section'

  const topicCards = report.topics
    .map(
      (topic) => `<div class="card topic-card">
        <div class="topic-title-row"><h3>${escapeHtml(topic.title)}</h3><span class="heat ${heatClass(topic.heat)}">${escapeHtml(topic.heat)}热</span></div>
        <div class="topic-meta">${escapeHtml(topic.timeRange)}</div>
        <p>${escapeHtml(topic.summary)}</p>
        ${
          topic.conclusions?.length
            ? `<div class="topic-conclusions">${topic.conclusions
                .slice(0, 2)
                .map((entry) => `<div class="topic-conclusion">${escapeHtml(entry.text)}</div>`)
                .join('')}</div>`
            : topic.conclusion
              ? `<div class="topic-conclusions"><div class="topic-conclusion">${escapeHtml(topic.conclusion)}</div></div>`
              : ''
        }
        ${
          topic.image
            ? (() => {
                // 优先用已有 imageUrl;若有 imageHash(来自 visionGallery),按 hash 取原图
                let imageUrl = topic.image.imageUrl
                if (!imageUrl && topic.image.imageHash) {
                  const insight = imageInsightService.getInsight(topic.image.imageHash)
                  if (insight) {
                    // insight 不含 imageUrl,需要按 md5/datName 重新拿;这里通过 ImageDecryptService 间接获取
                    // 走 ImageDecryptService.findImageFile + decryptImageToBase64
                    const decryptService = (
                      globalThis as {
                        __imageDecrypt?: {
                          findImageFile: (md5?: string, dat?: string) => string | null
                          decryptImageToBase64: (p: string) => string | null
                        }
                      }
                    ).__imageDecrypt
                    if (decryptService) {
                      const filePath = decryptService.findImageFile(insight.md5, insight.datName)
                      if (filePath)
                        imageUrl = decryptService.decryptImageToBase64(filePath) || undefined
                    }
                  }
                }
                if (!imageUrl) return ''
                return `<div class="topic-inline-image"><img src="${imageUrl}" alt="热点图片"><div>${escapeHtml(topic.image.note)}</div></div>`
              })()
            : ''
        }
        <div class="participants">${topic.participants
          .slice(0, 5)
          .map(
            (name) =>
              `<span class="person-chip"><img src="${avatar(name)}" alt=""><b>${escapeHtml(name)}</b></span>`
          )
          .join('')}</div>
        <div class="keywords">${topic.keywords.map((word) => `<span>${escapeHtml(word)}</span>`).join('')}</div>
      </div>`
    )
    .join('')

  const resourceItems = report.resources
    .map(
      (resource) =>
        `<div class="resource"><b>${escapeHtml(resource.title)}</b>${resource.sender ? ` · ${escapeHtml(resource.sender)}` : ''}<br>${escapeHtml(resource.description)}</div>`
    )
    .join('')

  const importantMessages = report.importantMessages
    .map(
      (message) => `<div class="important-card">
        <img class="avatar" src="${avatar(message.sender)}" alt="">
        <div class="important-body"><div class="important-meta"><b>${escapeHtml(message.sender)}</b><span>${escapeHtml(message.time)}</span></div>
        <div class="important-text">${escapeHtml(message.content)}</div><div class="important-note">${escapeHtml(message.note)}</div></div>
      </div>`
    )
    .join('')

  const quoteBlocks = report.quotes
    .map(
      (quote) =>
        `<div class="chat-block">${quote.messages
          .map(
            (
              message
            ) => `<div class="chat-msg"><img class="chat-avatar" src="${avatar(message.sender)}" alt=""><div>
            <div class="chat-name">${escapeHtml(message.sender)}</div><div class="chat-bubble">${escapeHtml(message.content)}</div>
          </div></div>`
          )
          .join('')}<div class="quote-note">${escapeHtml(quote.note)}</div></div>`
    )
    .join('')

  const todoCards = (report.todos || [])
    .map(
      (item) => `<div class="action-card todo-card">
        <b>${escapeHtml(item.task)}</b>
        <div>${[item.owner || '', item.deadline || '', item.topic || ''].filter(Boolean).map(escapeHtml).join(' · ')}</div>
        ${item.note ? `<div class="action-note">${escapeHtml(item.note)}</div>` : ''}
      </div>`
    )
    .join('')

  const unresolvedCards = (report.unresolved || [])
    .map(
      (item) => `<div class="action-card unresolved-card">
        <b>${escapeHtml(item.question)}</b>
        <div>${[item.owner || '', item.lastDiscussedAt || '', item.status].filter(Boolean).map(escapeHtml).join(' · ')}</div>
        <div class="action-note">${escapeHtml(item.note)}</div>
      </div>`
    )
    .join('')

  const storylineCards = (report.storylines || [])
    .map(
      (item) => `<div class="card storyline-card">
        <div class="topic-title-row"><h3>${escapeHtml(item.title)}</h3></div>
        <div class="storyline-steps">${item.stages
          .map(
            (stage) => `<div class="storyline-step">
              <span>${escapeHtml(stage.time || '--:--')}</span>
              <b>${escapeHtml(stage.event)}</b>
            </div>`
          )
          .join('')}</div>
        ${item.result ? `<p class="muted">${escapeHtml(item.result)}</p>` : ''}
      </div>`
    )
    .join('')

  const reversalCards = (report.reversals || [])
    .map(
      (item) => `<div class="qa-card">
        <b>${escapeHtml(item.topic)}</b>
        <div>最初：${escapeHtml(item.initialView)}</div>
        <div>后来：${escapeHtml(item.finalView)}</div>
        ${item.note ? `<div>${escapeHtml(item.note)}</div>` : ''}
      </div>`
    )
    .join('')

  const chainCards = (report.participantChains || [])
    .map(
      (item) => `<div class="card chain-card">
        <div class="topic-title-row"><h3>${escapeHtml(item.topic)}</h3></div>
        <div class="chain-flow">${item.chain.map((node) => `<span>${escapeHtml(node)}</span>`).join('<i>→</i>')}</div>
        ${item.note ? `<p class="muted">${escapeHtml(item.note)}</p>` : ''}
      </div>`
    )
    .join('')

  // AI 图片理解结果板块(ImageInsight)
  // 内容由 ImageInsightService.analyze 生成,真实看图 + 看上下文
  const visionCards = (report.media?.visionGallery || [])
    .filter((item) => item.imageUrl) // 只显示加载成功的图
    .map(
      (item) => `<div class="vision-card">
        <img class="vision-image" src="${item.imageUrl}" alt="AI 识别的图片">
        <div class="vision-body">
          <div class="important-meta"><b>${escapeHtml(item.sender)}</b><span>${escapeHtml(item.time)}</span></div>
          <div class="vision-description">${escapeHtml(item.description)}</div>
          ${item.ocrText ? `<div class="vision-ocr">📝 ${escapeHtml(item.ocrText)}</div>` : ''}
          ${item.tags.length ? `<div class="vision-tags">${item.tags.map((t) => `<span class="vision-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
          <div class="vision-label">AI 图片识别</div>
        </div>
      </div>`
    )
    .join('')

  const voiceCards = (report.media?.voiceHighlights || [])
    .map(
      (item) => `<div class="qa-card">
        <b>${escapeHtml(item.title)} · ${escapeHtml(item.sender)}</b>
        <div>${escapeHtml(item.note)}</div>
      </div>`
    )
    .join('')

  const voiceRankCards = (report.analytics.voiceLeaderboard || [])
    .map(
      (item, index) => `<div class="rank">
        <img src="${avatar(item.sender)}" alt="">
        <b>${index + 1}. ${escapeHtml(item.sender)}</b>
        <span>${item.count} 条 · ${item.durationSec} 秒</span>
      </div>`
    )
    .join('')

  const badgeCards = (report.media?.funBadges || [])
    .map(
      (item) => `<div class="badge-card">
        <span class="tag">${escapeHtml(item.title)}</span>
        <b>${escapeHtml(item.owner)}</b>
        <p>${escapeHtml(item.note)}</p>
      </div>`
    )
    .join('')

  const rankItems = report.analytics.topSpeakers
    .slice(0, 5)
    .map(
      (speaker, index) =>
        `<div class="rank"><img src="${avatar(speaker.name)}" alt=""><b>${index + 1}. ${escapeHtml(speaker.name)}</b><span>${Math.max(0, speaker.count)} 条</span></div>`
    )
    .join('')

  // v1 模板使用的水平条形热度图,渲染 top speakers 排行
  const heatSpeakers = report.analytics.topSpeakers.slice(0, 8)
  const maxSpeakerCount = Math.max(1, ...heatSpeakers.map((speaker) => Math.max(0, speaker.count)))
  const heatBarsHtml = heatSpeakers
    .map((speaker) => {
      const count = Math.max(0, speaker.count)
      const width = Math.max(4, Math.round((count / maxSpeakerCount) * 100))
      return `<div class="heat-row">
        <span class="heat-name">${escapeHtml(speaker.name)}</span>
        <span class="heat-bar"><i style="width:${width}%"></i></span>
        <span class="heat-val">${count}</span>
      </div>`
    })
    .join('')

  const cloudTags = report.keywords
    .slice(0, 15)
    .map(
      (word, index) =>
        `<span class="${index < 2 ? 'xl' : index < 5 ? 'lg' : index < 9 ? 'md' : ''}">${escapeHtml(word)}</span>`
    )
    .join('')

  const qaCards = report.qa
    .map(
      (item) =>
        `<div class="qa-card"><b>Q：${escapeHtml(item.question)}</b><div>A：${escapeHtml(item.answer)}${item.answerer ? ` — ${escapeHtml(item.answerer)}` : ''}</div></div>`
    )
    .join('')

  const summaryStats = report.summaryStats || {
    messageCount: metadata.messageCount,
    activeUsers: metadata.activeUsers,
    topicCount: report.topics.length,
    mediaCount: metadata.mediaMessageCount || 0,
    imageCount: metadata.imageCount || 0,
    voiceCount: metadata.voiceCount || 0,
    stickerCount: metadata.stickerCount || 0,
    conclusionCount: 0,
    todoCount: report.todos.length,
    unresolvedCount: report.unresolved.length
  }

  let html = await fs.readFile(templatePath(request.templateId), 'utf8')
  const values: Record<string, string> = {
    TEMPLATE_CLASS: template.cssClass,
    TEMPLATE_LABEL: escapeHtml(template.label),
    TEMPLATE_NAME: escapeHtml(template.name),
    REPORT_TITLE: escapeHtml(`${metadata.groupName}日报`),
    REPORT_DATE: escapeHtml(metadata.reportDate),
    REPORT_MODE_CLASS: metadata.reportMode === 'full' ? 'full' : 'compact',
    GROUP_NAME: escapeHtml(metadata.groupName),
    DATE_RANGE: escapeHtml(metadata.dateRange),
    RECORD_NOTE: escapeHtml(metadata.recordNote),
    // v1 模板使用的 OVERVIEW(经典版以概览段落呈现)
    OVERVIEW: escapeHtml(
      report.overview || report.hero?.summary || '基于已读取聊天记录生成的群聊日报'
    ),
    // v2 模板使用的 hero-*
    HERO_HEADLINE: escapeHtml(report.hero?.headline || '今日群聊速览'),
    HERO_SUMMARY: escapeHtml(report.hero?.summary || report.overview),
    HERO_TAKEAWAY: escapeHtml(report.hero?.keyTakeaway || ''),
    HERO_PENDING: escapeHtml(report.hero?.pendingNote || ''),
    HERO_STATUS_LINE: escapeHtml(report.hero?.statusLine || ''),
    HERO_STATUS_EMPTY_CLASS: report.hero?.statusLine ? '' : 'empty-section',
    HERO_TAKEAWAY_EMPTY_CLASS: report.hero?.keyTakeaway ? '' : 'empty-section',
    HERO_PENDING_EMPTY_CLASS: report.hero?.pendingNote ? '' : 'empty-section',
    HERO_AVATARS: heroAvatars,
    HERO_AVATAR_CLASS: heroAvatarClass,
    MESSAGE_COUNT: String(summaryStats.messageCount),
    ACTIVE_USERS: String(summaryStats.activeUsers),
    TIME_SPAN: escapeHtml(metadata.timeSpan || ''),
    TOPIC_COUNT: String(summaryStats.topicCount),
    MEDIA_COUNT: String(summaryStats.mediaCount),
    TOPIC_CARDS: topicCards,
    TOPICS_EMPTY_CLASS: sectionClass(request, 'topics', report.topics.length > 0),
    TOPICS_MORE_NOTE: overflowNote(request, 'topics'),
    RESOURCES_EMPTY_CLASS: sectionClass(request, 'resources', report.resources.length > 0),
    RESOURCE_ITEMS: resourceItems,
    RESOURCES_MORE_NOTE: overflowNote(request, 'resources'),
    MESSAGES_EMPTY_CLASS: sectionClass(
      request,
      'importantMessages',
      report.importantMessages.length > 0
    ),
    IMPORTANT_MESSAGES: importantMessages,
    MESSAGES_MORE_NOTE: overflowNote(request, 'importantMessages'),
    QUOTES_EMPTY_CLASS: sectionClass(request, 'moments', report.quotes.length > 0),
    QUOTE_BLOCKS: quoteBlocks,
    QUOTES_MORE_NOTE: overflowNote(request, 'moments'),
    ACTIONS_EMPTY_CLASS: sectionClass(
      request,
      'actions',
      report.todos.length + report.unresolved.length > 0
    ),
    TODO_EMPTY_CLASS: report.todos.length ? '' : 'empty-section',
    TODO_CARDS: todoCards,
    UNRESOLVED_EMPTY_CLASS: report.unresolved?.length ? '' : 'empty-section',
    UNRESOLVED_CARDS: unresolvedCards,
    ACTIONS_MORE_NOTE: overflowNote(request, 'actions'),
    QA_EMPTY_CLASS: sectionClass(request, 'qa', report.qa.length > 0),
    QA_CARDS: qaCards,
    QA_MORE_NOTE: overflowNote(request, 'qa'),
    STORYLINES_EMPTY_CLASS: sectionClass(request, 'storylines', report.storylines?.length > 0),
    STORYLINE_CARDS: storylineCards,
    STORYLINES_MORE_NOTE: overflowNote(request, 'storylines'),
    REVERSALS_EMPTY_CLASS: sectionClass(request, 'reversals', report.reversals?.length > 0),
    REVERSAL_CARDS: reversalCards,
    REVERSALS_MORE_NOTE: overflowNote(request, 'reversals'),
    CHAINS_EMPTY_CLASS: sectionClass(request, 'chains', report.participantChains?.length > 0),
    CHAIN_CARDS: chainCards,
    CHAINS_MORE_NOTE: overflowNote(request, 'chains'),
    // AI 图片识别板块
    VISION_EMPTY_CLASS: sectionClass(
      request,
      'vision',
      (report.media?.visionGallery?.length ?? 0) > 0
    ),
    VISION_CARDS: visionCards,
    VISION_TITLE: '📸 AI 识别的图片精选',
    VOICE_EMPTY_CLASS: sectionClass(request, 'voices', report.media?.voiceHighlights?.length > 0),
    VOICE_CARDS: voiceCards,
    VOICE_MORE_NOTE: overflowNote(request, 'voices'),
    VOICE_RANK_EMPTY_CLASS: sectionClass(
      request,
      'voices',
      report.analytics.voiceLeaderboard?.length > 0
    ),
    VOICE_RANK_CARDS: voiceRankCards,
    BADGES_EMPTY_CLASS: sectionClass(request, 'badges', report.media?.funBadges?.length > 0),
    BADGE_CARDS: badgeCards,
    BADGES_MORE_NOTE: overflowNote(request, 'badges'),
    RANK_ITEMS: rankItems,
    ACTIVITY_TIMELINE: escapeHtml(report.analytics.activeTimeline),
    CONCLUSION_COUNT: String(summaryStats.conclusionCount),
    TODO_COUNT: String(summaryStats.todoCount),
    UNRESOLVED_COUNT: String(summaryStats.unresolvedCount),
    CLOUD_TAGS: cloudTags,
    KEYWORDS_EMPTY_CLASS: sectionClass(request, 'keywords', report.keywords.length > 0),
    KEYWORDS_MORE_NOTE: overflowNote(request, 'keywords'),
    ANALYTICS_EMPTY_CLASS: sectionClass(request, 'analytics', true),
    GENERATED_AT: escapeHtml(metadata.generatedAt),
    FOOTER_NOTE: escapeHtml(metadata.footerNote),
    // v1 模板独有:从 analytics.topSpeakers 渲染水平条形热度图
    HEAT_BARS: heatBarsHtml
  }
  for (const [key, value] of Object.entries(values)) html = replacePlaceholder(html, key, value)
  // 清空模板中残留的未使用占位符(模板独有但 values 没提供的键)
  html = html.replace(/\{\{[A-Z_]+\}\}/g, '')
  return html
}

const renderReportSnapshotHtml = async (
  request: GroupReportRenderSnapshotExportRequest
): Promise<string> => {
  const template = getReportTemplate(request.templateId)
  let html = await fs.readFile(templatePath(request.templateId), 'utf8')
  const values = {
    ...request.snapshot.values,
    TEMPLATE_CLASS: template.cssClass,
    TEMPLATE_LABEL: escapeHtml(template.label),
    TEMPLATE_NAME: escapeHtml(template.name),
    REPORT_TITLE:
      request.snapshot.values.REPORT_TITLE || escapeHtml(`${request.snapshot.groupName}日报`),
    REPORT_DATE: request.snapshot.values.REPORT_DATE || escapeHtml(request.snapshot.reportDate)
  }
  for (const [key, value] of Object.entries(values)) html = replacePlaceholder(html, key, value)
  return html.replace(/\{\{[A-Z0-9_]+\}\}/g, '')
}

export const extractGroupReportRenderSnapshot = async (
  htmlPath: string,
  fallback: {
    groupName: string
    reportDate: string
    dateRange: string
    messageCount: number
    generatedAt: string
  }
): Promise<GroupReportRenderSnapshot> => {
  let reportWindow: BrowserWindow | null = null
  try {
    reportWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    await reportWindow.loadFile(htmlPath)
    const extracted = (await reportWindow.webContents.executeJavaScript(`(() => {
      const one = (selector) => document.querySelector(selector)
      const text = (...selectors) => {
        for (const selector of selectors) {
          const value = one(selector)?.textContent?.trim()
          if (value) return value
        }
        return ''
      }
      const html = (...selectors) => {
        for (const selector of selectors) {
          const value = one(selector)?.innerHTML
          if (value?.trim()) return value
        }
        return ''
      }
      const sectionChildren = (selector) => {
        const section = one(selector)
        if (!section) return ''
        return Array.from(section.children)
          .filter((child) => !child.classList.contains('section-title'))
          .map((child) => child.outerHTML)
          .join('')
      }
      const sectionClass = (...selectors) => {
        for (const selector of selectors) {
          const section = one(selector)
          if (!section) continue
          return section.classList.contains('empty-section') || !sectionChildren(selector).trim()
            ? 'empty-section'
            : ''
        }
        return 'empty-section'
      }
      const statValues = Array.from(document.querySelectorAll('.hero .stat b, .report-stats .stat-block strong'))
        .map((node) => node.textContent?.trim() || '')
      const activity = Array.from(document.querySelectorAll('.analytics > .card, .section-analytics-heat .card'))
        .find((node) => node.textContent?.includes('活跃时间线'))
        ?.textContent?.replace(/^.*?活跃时间线[：:]?/, '')
        .trim() || ''
      const legacyRanks = Array.from(document.querySelectorAll('.analytics .rank'))
        .map((node) => node.outerHTML)
        .join('')
      const legacyHeat = Array.from(document.querySelectorAll('.analytics > .heat-row'))
        .map((node) => node.outerHTML)
        .join('')
      const footerText = text('.footer', '.report-footer')
        .replaceAll('\\n', ' ')
        .replaceAll('\\r', ' ')
        .replaceAll('\\t', ' ')
      return {
        reportTitle: text('.hero h1', '.report-masthead h1', 'title'),
        reportDate: text('.report-date strong'),
        overview: text('.overview', '.report-lede'),
        recordNote: text('.record-note'),
        heroAvatars: html('.avatar-grid', '.report-hero-avatars'),
        messageCount: statValues[0] || '',
        activeUsers: statValues[1] || '',
        timeSpan: statValues[2] || '',
        topicCount: statValues[3] || '',
        topicCards: sectionChildren('.topics') || html('.section-topics .topics-grid'),
        importantMessages: sectionChildren('.messages') || html('.section-messages .section-body'),
        quoteBlocks: sectionChildren('.quotes') || html('.section-quotes .section-body'),
        qaCards: sectionChildren('.qa') || html('.section-qa .section-body'),
        resourceItems: sectionChildren('.resources') || html('.section-resources .section-body'),
        visionCards: sectionChildren('.vision') || html('.section-vision .vision-grid'),
        rankItems: legacyRanks || html('.section-analytics-rank .rank-list'),
        heatBars: legacyHeat || html('.section-analytics-heat .section-body'),
        activityTimeline: activity,
        cloudTags: html('.cloud-tags', '.section-keywords .cloud-tags'),
        footerText,
        classes: {
          topics: sectionClass('.topics', '.section-topics'),
          messages: sectionClass('.messages', '.section-messages'),
          quotes: sectionClass('.quotes', '.section-quotes'),
          qa: sectionClass('.qa', '.section-qa'),
          resources: sectionClass('.resources', '.section-resources'),
          vision: sectionClass('.vision', '.section-vision'),
          keywords: sectionClass('.cloud', '.section-keywords')
        }
      }
    })()`)) as {
      reportTitle: string
      reportDate: string
      overview: string
      recordNote: string
      heroAvatars: string
      messageCount: string
      activeUsers: string
      timeSpan: string
      topicCount: string
      topicCards: string
      importantMessages: string
      quoteBlocks: string
      qaCards: string
      resourceItems: string
      visionCards: string
      rankItems: string
      heatBars: string
      activityTimeline: string
      cloudTags: string
      footerText: string
      classes: Record<string, string>
    }
    if (!extracted.reportTitle || !extracted.topicCards) {
      throw new Error('旧日报 HTML 缺少可迁移的标题或主题内容')
    }

    const values: Record<string, string> = {
      REPORT_TITLE: escapeHtml(extracted.reportTitle),
      REPORT_DATE: escapeHtml(extracted.reportDate || fallback.reportDate),
      DATE_RANGE: escapeHtml(fallback.dateRange),
      TIME_SPAN: escapeHtml(extracted.timeSpan),
      HERO_SUMMARY: escapeHtml(extracted.overview),
      HERO_TAKEAWAY: '',
      HERO_PENDING: '',
      HERO_STATUS_LINE: '',
      HERO_TAKEAWAY_EMPTY_CLASS: 'empty-section',
      HERO_PENDING_EMPTY_CLASS: 'empty-section',
      HERO_STATUS_EMPTY_CLASS: 'empty-section',
      HERO_AVATARS: extracted.heroAvatars,
      HERO_AVATAR_CLASS: extracted.heroAvatars ? '' : 'empty-section',
      MESSAGE_COUNT: escapeHtml(extracted.messageCount || String(fallback.messageCount)),
      ACTIVE_USERS: escapeHtml(extracted.activeUsers),
      TOPIC_COUNT: escapeHtml(extracted.topicCount),
      RECORD_NOTE: escapeHtml(extracted.recordNote),
      GENERATED_AT: escapeHtml(fallback.generatedAt),
      FOOTER_NOTE: escapeHtml(extracted.footerText),
      TOPIC_CARDS: extracted.topicCards,
      IMPORTANT_MESSAGES: extracted.importantMessages,
      QUOTE_BLOCKS: extracted.quoteBlocks,
      QA_CARDS: extracted.qaCards,
      RESOURCE_ITEMS: extracted.resourceItems,
      VISION_TITLE: '📸 AI 识别的图片精选',
      VISION_CARDS: extracted.visionCards,
      RANK_ITEMS: extracted.rankItems,
      HEAT_BARS: extracted.heatBars,
      ACTIVITY_TIMELINE: escapeHtml(extracted.activityTimeline),
      CLOUD_TAGS: extracted.cloudTags,
      TOPICS_EMPTY_CLASS: extracted.classes.topics,
      MESSAGES_EMPTY_CLASS: extracted.classes.messages,
      QUOTES_EMPTY_CLASS: extracted.classes.quotes,
      QA_EMPTY_CLASS: extracted.classes.qa,
      RESOURCES_EMPTY_CLASS: extracted.classes.resources,
      VISION_EMPTY_CLASS: extracted.classes.vision,
      KEYWORDS_EMPTY_CLASS: extracted.classes.keywords,
      ANALYTICS_EMPTY_CLASS: extracted.heatBars || extracted.rankItems ? '' : 'empty-section',
      ACTIONS_EMPTY_CLASS: 'empty-section',
      STORYLINES_EMPTY_CLASS: 'empty-section',
      REVERSALS_EMPTY_CLASS: 'empty-section',
      CHAINS_EMPTY_CLASS: 'empty-section',
      VOICE_EMPTY_CLASS: 'empty-section',
      VOICE_RANK_EMPTY_CLASS: 'empty-section',
      BADGES_EMPTY_CLASS: 'empty-section',
      TODO_CARDS: '',
      UNRESOLVED_CARDS: '',
      STORYLINE_CARDS: '',
      REVERSAL_CARDS: '',
      CHAIN_CARDS: '',
      VOICE_CARDS: '',
      VOICE_RANK_CARDS: '',
      BADGE_CARDS: '',
      TOPICS_MORE_NOTE: '',
      MESSAGES_MORE_NOTE: '',
      QUOTES_MORE_NOTE: '',
      QA_MORE_NOTE: '',
      RESOURCES_MORE_NOTE: '',
      ACTIONS_MORE_NOTE: '',
      STORYLINES_MORE_NOTE: '',
      REVERSALS_MORE_NOTE: '',
      CHAINS_MORE_NOTE: '',
      VOICE_MORE_NOTE: '',
      BADGES_MORE_NOTE: '',
      KEYWORDS_MORE_NOTE: ''
    }
    return {
      groupName: fallback.groupName,
      reportDate: extracted.reportDate || fallback.reportDate,
      values
    }
  } finally {
    if (reportWindow && !reportWindow.isDestroyed()) reportWindow.destroy()
  }
}

const captureFullPage = async (
  htmlPath: string,
  pngPath: string,
  templateId?: string
): Promise<string> => {
  const template = getReportTemplate(templateId)
  const captureWidth = LEGACY_TEMPLATE_FILES[templateId || ''] ? 430 : template.captureWidth
  const maxCaptureWidth = LEGACY_TEMPLATE_FILES[templateId || ''] ? 1200 : template.maxCaptureWidth
  console.log(`[GroupReport] capture begin html=${htmlPath}`)
  const reportWindow = new BrowserWindow({
    show: false,
    width: captureWidth,
    height: 800,
    frame: false,
    backgroundColor: '#f3f5f7',
    webPreferences: { sandbox: true }
  })

  try {
    await reportWindow.loadFile(htmlPath)
    console.log('[GroupReport] capture loaded html')
    await reportWindow.webContents.executeJavaScript(`Promise.all([
      document.fonts.ready,
      ...Array.from(document.images).map((img) => img.complete ? Promise.resolve() : new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      }))
    ])`)
    console.log('[GroupReport] capture assets ready')
    const metrics = (await reportWindow.webContents.executeJavaScript(`({
      width: Math.ceil(Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, ${captureWidth})),
      height: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 800))
    })`)) as { width: number; height: number }
    const width = Math.max(captureWidth, Math.min(maxCaptureWidth, Math.ceil(metrics.width)))
    const height = Math.max(800, Math.min(20000, Math.ceil(metrics.height)))
    reportWindow.setContentSize(width, height)
    await new Promise((resolve) => setTimeout(resolve, 100))
    console.log(`[GroupReport] capture native page width=${width} height=${height}`)
    const image = await reportWindow.webContents.capturePage({ x: 0, y: 0, width, height })
    const png = image.toPNG()
    if (png.length < 1000) throw new Error('生成的日报图片为空')
    await fs.writeFile(pngPath, png)
    console.log(`[GroupReport] capture ok bytes=${png.length} png=${pngPath}`)
    return `data:image/png;base64,${png.toString('base64')}`
  } finally {
    reportWindow.destroy()
  }
}

export const exportGroupReport = async (
  request: GroupReportExportRequest
): Promise<GroupReportExportResult> => {
  try {
    // === enrich 在 render 之前:从群成员快照反推真头像 ===
    await enrichAvatarsFromGroup(request.metadata)

    const outputDir = path.join(os.homedir(), 'Documents', '微信聊天记录')
    await fs.ensureDir(outputDir)
    const templateLabel =
      request.templateId === 'v1'
        ? '经典版'
        : request.templateId === 'v2'
          ? '丰富版'
          : getReportTemplate(request.templateId).fileLabel
    const baseName = `${sanitizeFileName(request.metadata.groupName)}日报_${request.metadata.reportDate}_${templateLabel}`
    const htmlPath = path.join(outputDir, `${baseName}.html`)
    const pngPath = path.join(outputDir, `${baseName}.png`)
    const htmlStartedAt = new Date()
    const html = await renderReportHtml(request)
    await fs.writeFile(htmlPath, html, 'utf8')
    const htmlEndedAt = new Date()
    const pngStartedAt = new Date()
    const imageDataUrl = await captureFullPage(htmlPath, pngPath, request.templateId)
    const pngEndedAt = new Date()
    return {
      success: true,
      htmlPath,
      pngPath,
      imageDataUrl,
      exportTimings: {
        html: {
          startedAt: htmlStartedAt.toISOString(),
          endedAt: htmlEndedAt.toISOString(),
          duration: htmlEndedAt.getTime() - htmlStartedAt.getTime()
        },
        png: {
          startedAt: pngStartedAt.toISOString(),
          endedAt: pngEndedAt.toISOString(),
          duration: pngEndedAt.getTime() - pngStartedAt.getTime()
        }
      },
      warnings: request.metadata.warnings?.length ? request.metadata.warnings : undefined
    }
  } catch (error) {
    console.error('[GroupReport] export failed:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export const exportGroupReportSnapshot = async (
  request: GroupReportRenderSnapshotExportRequest
): Promise<GroupReportExportResult> => {
  try {
    const outputDir = path.join(os.homedir(), 'Documents', '微信聊天记录')
    await fs.ensureDir(outputDir)
    const templateLabel = getReportTemplate(request.templateId).fileLabel
    const baseName = `${sanitizeFileName(request.snapshot.groupName)}日报_${request.snapshot.reportDate}_${templateLabel}`
    const htmlPath = path.join(outputDir, `${baseName}.html`)
    const pngPath = path.join(outputDir, `${baseName}.png`)
    const htmlStartedAt = new Date()
    const html = await renderReportSnapshotHtml(request)
    await fs.writeFile(htmlPath, html, 'utf8')
    const htmlEndedAt = new Date()
    const pngStartedAt = new Date()
    const imageDataUrl = await captureFullPage(htmlPath, pngPath, request.templateId)
    const pngEndedAt = new Date()
    return {
      success: true,
      htmlPath,
      pngPath,
      imageDataUrl,
      exportTimings: {
        html: {
          startedAt: htmlStartedAt.toISOString(),
          endedAt: htmlEndedAt.toISOString(),
          duration: htmlEndedAt.getTime() - htmlStartedAt.getTime()
        },
        png: {
          startedAt: pngStartedAt.toISOString(),
          endedAt: pngEndedAt.toISOString(),
          duration: pngEndedAt.getTime() - pngStartedAt.getTime()
        }
      }
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
