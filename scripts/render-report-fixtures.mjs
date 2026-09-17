import { app, BrowserWindow } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const templatePath = path.join(root, 'resources', 'mobile_daily_report.html')
const outputDir = path.join(os.tmpdir(), 'tracememo-report-fixtures')

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')

const replacePlaceholder = (html, key, value) => html.replaceAll(`{{${key}}}`, value)

const avatarSvg = (label, color) =>
  `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="18" fill="${color}"/><text x="48" y="58" text-anchor="middle" font-family="PingFang SC, sans-serif" font-size="36" fill="#0f172a">${label}</text></svg>`
  ).toString('base64')}`

/**
 * 可选的本地样例图（用于人工核对图片区块的排版）。
 *
 * 走环境变量传入，**不要在源码里写本机路径** —— 微信数据目录会连带暴露
 * 系统用户名与账号目录名。不传就退回内置的 SVG 头像占位。
 */
const localImagePath = process.env.REPORT_FIXTURE_IMAGE || ''
const sampleImage =
  localImagePath && fs.existsSync(localImagePath)
    ? `data:image/png;base64,${fs.readFileSync(localImagePath).toString('base64')}`
    : avatarSvg('图', '#dbeafe')

const avatars = {
  阿宇: avatarSvg('宇', '#dcfce7'),
  老周: avatarSvg('周', '#e0f2fe'),
  小李: avatarSvg('李', '#fef3c7'),
  'we water': avatarSvg('W', '#ede9fe'),
  佩佩: avatarSvg('佩', '#fee2e2')
}

const heroNames = ['阿宇', '老周', '小李', 'we water']
const heroAvatars = heroNames
  .map((name) => `<img src="${avatars[name]}" alt="${name}">`)
  .join('')

const compactRequest = {
  metadata: {
    groupName: '技术交流',
    reportDate: '2026-07-10',
    dateRange: '2026-07-10 09:12-19:48',
    messageCount: 382,
    activeUsers: 47,
    imageCount: 9,
    voiceCount: 5,
    stickerCount: 14,
    mediaMessageCount: 28,
    timeSpan: '11 h',
    generatedAt: '2026-07-10 22:18',
    recordNote: '基于示例数据生成的精简版日报',
    footerNote: '精简版默认面向长图转发；无内容模块自动隐藏。',
    heroParticipants: heroNames,
    avatars,
    reportMode: 'compact'
  },
  report: {
    hero: {
      headline: '接口排查和版本升级是今天主线',
      summary: '白天主要围绕接口异常、升级节奏和上线安排展开，结论比争论更多，待跟进事项也比较集中。',
      keyTakeaway: '大家确认本次异常更像缓存与配置问题，而不是服务端挂掉。',
      pendingNote: '测试环境接口文档和回滚方案仍需补齐。',
      statusLine: '今日形成 3 个结论 · 2 个待办 · 1 个问题尚未解决'
    },
    summaryStats: {
      messageCount: 382,
      activeUsers: 47,
      topicCount: 4,
      mediaCount: 28,
      imageCount: 9,
      voiceCount: 5,
      stickerCount: 14,
      conclusionCount: 3,
      todoCount: 2,
      unresolvedCount: 1
    },
    sectionMeta: {
      hero: { enabled: true, importance: 1, confidence: 0.95, totalCount: 1, displayedCount: 1 },
      topics: { enabled: true, importance: 0.98, confidence: 0.86, totalCount: 6, displayedCount: 3, hiddenCount: 3 },
      importantMessages: { enabled: true, importance: 0.95, confidence: 0.84, totalCount: 6, displayedCount: 3, hiddenCount: 3 },
      actions: { enabled: true, importance: 0.97, confidence: 0.81, totalCount: 5, displayedCount: 3, hiddenCount: 2 },
      moments: { enabled: true, importance: 0.75, confidence: 0.75, totalCount: 3, displayedCount: 1, hiddenCount: 2 },
      analytics: { enabled: true, importance: 0.8, confidence: 0.95, totalCount: 1, displayedCount: 1 },
      keywords: { enabled: true, importance: 0.68, confidence: 0.92, totalCount: 16, displayedCount: 12, hiddenCount: 4 }
    },
    topics: [
      {
        title: 'GPT 接口异常排查',
        timeRange: '09:20-11:05',
        heat: '高',
        summary: '上午先从接口超时和返回结构异常入手，几轮排查后，大家逐步把问题收敛到缓存与环境配置，而不是后端服务不可用。',
        conclusions: [
          { text: '接口本身可用，异常更像本地缓存与环境变量冲突。' },
          { text: '先清缓存再复测，避免把旧响应误判成线上事故。' }
        ],
        participants: ['阿宇', '老周', '小李'],
        keywords: ['接口', '缓存', '环境变量'],
        image: {
          imageUrl: sampleImage,
          note: '该图片引发 12 条回复。根据图片前后对话推断，这是一张帮助定位问题的截图。'
        }
      },
      {
        title: '版本升级节奏',
        timeRange: '11:40-12:20',
        heat: '中',
        summary: '关于 React 版本是否立刻升级，讨论从“能不能升”转成“这周值不值得升”，最终倾向先补兼容性清单再动。',
        conclusions: [{ text: '先列旧组件兼容清单，再决定升级窗口。' }],
        participants: ['阿宇', 'we water', '佩佩'],
        keywords: ['React', '升级', '兼容性']
      },
      {
        title: '上线节奏与回滚准备',
        timeRange: '15:10-16:05',
        heat: '中',
        summary: '下午讨论上线方案时，大家更关注回滚准备是否充分，最后把重点放在文档、监控和回滚路径补齐上。',
        conclusions: [{ text: '上线前需要补一版简短回滚说明。' }],
        participants: ['老周', '小李'],
        keywords: ['上线', '回滚', '监控']
      },
    ],
    importantMessages: [
      { sender: '阿宇', time: '10:41', content: '先别回滚，接口能通。', note: '稳定了排查方向。' },
      { sender: '老周', time: '11:02', content: '像是缓存没清掉。', note: '把问题从服务端收敛到本地环境。' },
      { sender: '小李', time: '15:36', content: '上线前把回滚文档补一下。', note: '明确形成待办。' }
    ],
    todos: [
      { task: '补测试环境接口文档', owner: '小李', topic: 'GPT 接口异常排查', note: '方便明天复测。' },
      { task: '整理回滚说明', owner: '老周', deadline: '今晚', topic: '上线节奏与回滚准备' }
    ],
    unresolved: [
      { question: '缓存问题的根因是不是插件残留？', owner: '阿宇', status: '待跟进', lastDiscussedAt: '18:26', note: '目前只有推断，还没有最终证据。' }
    ],
    quotes: [
      {
        messages: [
          { sender: '阿宇', content: '我以为接口炸了。' },
          { sender: '老周', content: '先别慌，先清缓存。' },
          { sender: '小李', content: '清完它居然真好了。' }
        ],
        note: '从“要不要回滚”迅速切到“先做最小验证”，很像今天的群聊节奏。'
      }
    ],
    analytics: {
      topSpeakers: [
        { name: '阿宇', count: 112 },
        { name: '老周', count: 78 },
        { name: '小李', count: 61 },
        { name: 'we water', count: 49 },
        { name: '佩佩', count: 33 }
      ],
      activeTimeline: '09:00-09:59、10:00-10:59、15:00-15:59',
      voiceLeaderboard: []
    },
    keywords: ['GPT', '接口', '缓存', '升级', '上线', '回滚', '监控', '兼容性', '截图', '文档', '测试环境', '复测'],
    media: {
      gallery: [],
      voiceHighlights: [],
      funBadges: []
    },
    resources: [],
    qa: [],
    storylines: [],
    reversals: [],
    participantChains: []
  }
}

const fullRequest = JSON.parse(JSON.stringify(compactRequest))
fullRequest.metadata.recordNote = '基于示例数据生成的完整版日报'
fullRequest.metadata.reportMode = 'full'
fullRequest.report.sectionMeta = {
  ...fullRequest.report.sectionMeta,
  resources: { enabled: true, importance: 0.58, confidence: 0.76, totalCount: 2, displayedCount: 2 },
  qa: { enabled: true, importance: 0.62, confidence: 0.8, totalCount: 2, displayedCount: 2 },
  storylines: { enabled: true, importance: 0.68, confidence: 0.74, totalCount: 2, displayedCount: 2 },
  reversals: { enabled: true, importance: 0.55, confidence: 0.72, totalCount: 1, displayedCount: 1 },
  voices: { enabled: true, importance: 0.6, confidence: 0.83, totalCount: 2, displayedCount: 2 },
  badges: { enabled: true, importance: 0.45, confidence: 0.68, totalCount: 2, displayedCount: 2 },
  chains: { enabled: true, importance: 0.58, confidence: 0.72, totalCount: 1, displayedCount: 1 }
}
fullRequest.report.resources = [
  { title: '测试环境接口文档', description: '明天复测会直接用到的说明。', sender: '小李' },
  { title: '回滚说明草稿', description: '上线前确认回滚路径与负责人。', sender: '老周' }
]
fullRequest.report.qa = [
  { question: '今晚要不要升级 React？', answer: '先不升级，先补兼容清单。', answerer: 'we water' },
  { question: '接口是不是服务端挂了？', answer: '不是，当前更像缓存与环境问题。', answerer: '老周' }
]
fullRequest.report.storylines = [
  {
    title: '接口异常排查线',
    stages: [
      { time: '09:20', event: '阿宇提出接口异常。' },
      { time: '09:46', event: '老周建议先清缓存。' },
      { time: '10:41', event: '确认接口本身可通。' }
    ],
    result: '初步定位为缓存与配置冲突。'
  },
  {
    title: '版本升级讨论线',
    stages: [
      { time: '11:40', event: '开始讨论是否本周升级。' },
      { time: '12:05', event: '补充兼容性与工期顾虑。' }
    ],
    result: '今晚不升，先补兼容清单。'
  }
]
fullRequest.report.reversals = [
  { topic: '接口异常', initialView: '最初以为后端服务不稳定。', finalView: '最终判断更像缓存与配置问题。', note: '多轮验证后，排查方向明显收敛。' }
]
fullRequest.report.media = {
  gallery: [],
  voiceHighlights: [
    { title: '语音输出王', sender: '老周', note: '共发送 3 条语音，累计 97 秒。' },
    { title: '连续发言时刻', sender: '阿宇', note: '16:32 连发 2 条语音，共 54 秒。' }
  ],
  funBadges: [
    { title: '高能输出王', owner: '阿宇', note: '今天一共发了 112 条消息。' },
    { title: '语音麦霸', owner: '老周', note: '语音总时长位列第一。' }
  ]
}
fullRequest.report.participantChains = [
  { topic: '接口异常排查', chain: ['阿宇 提出', '老周 收敛方向', '小李 验证', 'we water 定结论'], note: '比较典型的一条技术讨论链路。' }
]
fullRequest.report.analytics.voiceLeaderboard = [
  { sender: '老周', count: 3, durationSec: 97 },
  { sender: '阿宇', count: 2, durationSec: 54 }
]

async function renderRequest(request, targetBase) {
  let html = await fs.readFile(templatePath, 'utf8')
  const report = request.report
  const metadata = request.metadata
  const topicCards = report.topics
    .map((topic) => {
      const conclusions = (topic.conclusions || [])
        .slice(0, 2)
        .map((entry) => `<div class="topic-conclusion">${escapeHtml(entry.text)}</div>`)
        .join('')
      const image = topic.image?.imageUrl
        ? `<div class="topic-inline-image"><img src="${topic.image.imageUrl}" alt="热点图片"><div>${escapeHtml(topic.image.note)}</div></div>`
        : ''
      return `<div class="card topic-card"><div class="topic-title-row"><h3>${escapeHtml(topic.title)}</h3><span class="heat ${topic.heat === '高' ? 'hot' : topic.heat === '低' ? 'blue' : ''}">${escapeHtml(topic.heat)}热</span></div><div class="topic-meta">${escapeHtml(topic.timeRange)}</div><p>${escapeHtml(topic.summary)}</p>${conclusions ? `<div class="topic-conclusions">${conclusions}</div>` : ''}${image}<div class="participants">${topic.participants.map((name) => `<span class="person-chip"><img src="${avatars[name] || avatarSvg(name[0], '#e5e7eb')}" alt=""><b>${escapeHtml(name)}</b></span>`).join('')}</div><div class="keywords">${topic.keywords.map((word) => `<span>${escapeHtml(word)}</span>`).join('')}</div></div>`
    })
    .join('')
  const importantMessages = report.importantMessages
    .map((message) => `<div class="important-card"><img class="avatar" src="${avatars[message.sender] || avatarSvg(message.sender[0], '#e5e7eb')}" alt=""><div class="important-body"><div class="important-meta"><b>${escapeHtml(message.sender)}</b><span>${escapeHtml(message.time)}</span></div><div class="important-text">${escapeHtml(message.content)}</div><div class="important-note">${escapeHtml(message.note)}</div></div></div>`)
    .join('')
  const todoCards = (report.todos || []).map((item) => `<div class="action-card todo-card"><b>${escapeHtml(item.task)}</b><div>${[item.owner || '', item.deadline || '', item.topic || ''].filter(Boolean).map(escapeHtml).join(' · ')}</div>${item.note ? `<div class="action-note">${escapeHtml(item.note)}</div>` : ''}</div>`).join('')
  const unresolvedCards = (report.unresolved || []).map((item) => `<div class="action-card unresolved-card"><b>${escapeHtml(item.question)}</b><div>${[item.owner || '', item.lastDiscussedAt || '', item.status].filter(Boolean).map(escapeHtml).join(' · ')}</div><div class="action-note">${escapeHtml(item.note)}</div></div>`).join('')
  const quoteBlocks = report.quotes.map((quote) => `<div class="chat-block">${quote.messages.map((message) => `<div class="chat-msg"><img class="chat-avatar" src="${avatars[message.sender] || avatarSvg(message.sender[0], '#e5e7eb')}" alt=""><div><div class="chat-name">${escapeHtml(message.sender)}</div><div class="chat-bubble">${escapeHtml(message.content)}</div></div></div>`).join('')}<div class="quote-note">${escapeHtml(quote.note)}</div></div>`).join('')
  const rankItems = report.analytics.topSpeakers.map((speaker, index) => `<div class="rank"><img src="${avatars[speaker.name] || avatarSvg(speaker.name[0], '#e5e7eb')}" alt=""><b>${index + 1}. ${escapeHtml(speaker.name)}</b><span>${speaker.count} 条</span></div>`).join('')
  const cloudTags = report.keywords.map((word, index) => `<span class="${index < 2 ? 'xl' : index < 5 ? 'lg' : index < 9 ? 'md' : ''}">${escapeHtml(word)}</span>`).join('')
  const resourceItems = (report.resources || []).map((resource) => `<div class="resource"><b>${escapeHtml(resource.title)}</b>${resource.sender ? ` · ${escapeHtml(resource.sender)}` : ''}<br>${escapeHtml(resource.description)}</div>`).join('')
  const qaCards = (report.qa || []).map((item) => `<div class="qa-card"><b>Q：${escapeHtml(item.question)}</b><div>A：${escapeHtml(item.answer)}${item.answerer ? ` — ${escapeHtml(item.answerer)}` : ''}</div></div>`).join('')
  const storylineCards = (report.storylines || []).map((item) => `<div class="card storyline-card"><div class="topic-title-row"><h3>${escapeHtml(item.title)}</h3></div><div class="storyline-steps">${item.stages.map((stage) => `<div class="storyline-step"><span>${escapeHtml(stage.time)}</span><b>${escapeHtml(stage.event)}</b></div>`).join('')}</div>${item.result ? `<p class="muted">${escapeHtml(item.result)}</p>` : ''}</div>`).join('')
  const reversalCards = (report.reversals || []).map((item) => `<div class="qa-card"><b>${escapeHtml(item.topic)}</b><div>最初：${escapeHtml(item.initialView)}</div><div>后来：${escapeHtml(item.finalView)}</div>${item.note ? `<div>${escapeHtml(item.note)}</div>` : ''}</div>`).join('')
  const voiceCards = (report.media.voiceHighlights || []).map((item) => `<div class="qa-card"><b>${escapeHtml(item.title)} · ${escapeHtml(item.sender)}</b><div>${escapeHtml(item.note)}</div></div>`).join('')
  const voiceRankCards = (report.analytics.voiceLeaderboard || []).map((item, index) => `<div class="rank"><img src="${avatars[item.sender] || avatarSvg(item.sender[0], '#e5e7eb')}" alt=""><b>${index + 1}. ${escapeHtml(item.sender)}</b><span>${item.count} 条 · ${item.durationSec} 秒</span></div>`).join('')
  const badgeCards = (report.media.funBadges || []).map((item) => `<div class="badge-card"><span class="tag">${escapeHtml(item.title)}</span><b>${escapeHtml(item.owner)}</b><p>${escapeHtml(item.note)}</p></div>`).join('')
  const chainCards = (report.participantChains || []).map((item) => `<div class="card chain-card"><div class="topic-title-row"><h3>${escapeHtml(item.topic)}</h3></div><div class="chain-flow">${item.chain.map((node) => `<span>${escapeHtml(node)}</span>`).join('<i>→</i>')}</div>${item.note ? `<p class="muted">${escapeHtml(item.note)}</p>` : ''}</div>`).join('')

  const replaceMap = {
    REPORT_TITLE: `${metadata.groupName}日报`,
    REPORT_MODE_CLASS: metadata.reportMode === 'full' ? 'full' : 'compact',
    GROUP_NAME: metadata.groupName,
    DATE_RANGE: metadata.dateRange,
    RECORD_NOTE: metadata.recordNote,
    REPORT_MODE_LABEL: metadata.reportMode === 'full' ? '完整版' : '精简版',
    HERO_HEADLINE: report.hero.headline,
    HERO_SUMMARY: report.hero.summary,
    HERO_STATUS_LINE: report.hero.statusLine || '',
    HERO_STATUS_EMPTY_CLASS: report.hero.statusLine ? '' : 'empty-section',
    HERO_TAKEAWAY: report.hero.keyTakeaway || '',
    HERO_TAKEAWAY_EMPTY_CLASS: report.hero.keyTakeaway ? '' : 'empty-section',
    HERO_PENDING: report.hero.pendingNote || '',
    HERO_PENDING_EMPTY_CLASS: report.hero.pendingNote ? '' : 'empty-section',
    HERO_AVATARS: heroAvatars,
    MESSAGE_COUNT: String(report.summaryStats.messageCount),
    ACTIVE_USERS: String(report.summaryStats.activeUsers),
    TOPIC_COUNT: String(report.summaryStats.topicCount),
    MEDIA_COUNT: String(report.summaryStats.mediaCount),
    TOPICS_EMPTY_CLASS: report.sectionMeta.topics?.enabled ? '' : 'empty-section',
    TOPIC_CARDS: topicCards,
    TOPICS_MORE_NOTE: report.sectionMeta.topics?.hiddenCount ? `<div class="section-more">另有 ${report.sectionMeta.topics.hiddenCount} 条内容，请在完整版中查看</div>` : '',
    MESSAGES_EMPTY_CLASS: report.sectionMeta.importantMessages?.enabled ? '' : 'empty-section',
    IMPORTANT_MESSAGES: importantMessages,
    MESSAGES_MORE_NOTE: report.sectionMeta.importantMessages?.hiddenCount ? `<div class="section-more">另有 ${report.sectionMeta.importantMessages.hiddenCount} 条内容，请在完整版中查看</div>` : '',
    ACTIONS_EMPTY_CLASS: report.sectionMeta.actions?.enabled ? '' : 'empty-section',
    TODO_EMPTY_CLASS: report.todos.length ? '' : 'empty-section',
    TODO_CARDS: todoCards,
    UNRESOLVED_EMPTY_CLASS: report.unresolved.length ? '' : 'empty-section',
    UNRESOLVED_CARDS: unresolvedCards,
    ACTIONS_MORE_NOTE: report.sectionMeta.actions?.hiddenCount ? `<div class="section-more">另有 ${report.sectionMeta.actions.hiddenCount} 条内容，请在完整版中查看</div>` : '',
    QUOTES_EMPTY_CLASS: report.sectionMeta.moments?.enabled ? '' : 'empty-section',
    QUOTE_BLOCKS: quoteBlocks,
    QUOTES_MORE_NOTE: report.sectionMeta.moments?.hiddenCount ? `<div class="section-more">另有 ${report.sectionMeta.moments.hiddenCount} 条内容，请在完整版中查看</div>` : '',
    ANALYTICS_EMPTY_CLASS: '',
    RANK_ITEMS: rankItems,
    ACTIVITY_TIMELINE: report.analytics.activeTimeline,
    CONCLUSION_COUNT: String(report.summaryStats.conclusionCount),
    TODO_COUNT: String(report.summaryStats.todoCount),
    UNRESOLVED_COUNT: String(report.summaryStats.unresolvedCount),
    KEYWORDS_EMPTY_CLASS: report.sectionMeta.keywords?.enabled ? '' : 'empty-section',
    CLOUD_TAGS: cloudTags,
    KEYWORDS_MORE_NOTE: report.sectionMeta.keywords?.hiddenCount ? `<div class="section-more">另有 ${report.sectionMeta.keywords.hiddenCount} 个关键词，请在完整版中查看</div>` : '',
    RESOURCES_EMPTY_CLASS: report.sectionMeta.resources?.enabled ? '' : 'empty-section',
    RESOURCE_ITEMS: resourceItems,
    RESOURCES_MORE_NOTE: '',
    QA_EMPTY_CLASS: report.sectionMeta.qa?.enabled ? '' : 'empty-section',
    QA_CARDS: qaCards,
    QA_MORE_NOTE: '',
    STORYLINES_EMPTY_CLASS: report.sectionMeta.storylines?.enabled ? '' : 'empty-section',
    STORYLINE_CARDS: storylineCards,
    STORYLINES_MORE_NOTE: '',
    REVERSALS_EMPTY_CLASS: report.sectionMeta.reversals?.enabled ? '' : 'empty-section',
    REVERSAL_CARDS: reversalCards,
    REVERSALS_MORE_NOTE: '',
    VOICE_EMPTY_CLASS: report.sectionMeta.voices?.enabled ? '' : 'empty-section',
    VOICE_CARDS: voiceCards,
    VOICE_MORE_NOTE: '',
    VOICE_RANK_EMPTY_CLASS: report.sectionMeta.voices?.enabled ? '' : 'empty-section',
    VOICE_RANK_CARDS: voiceRankCards,
    BADGES_EMPTY_CLASS: report.sectionMeta.badges?.enabled ? '' : 'empty-section',
    BADGE_CARDS: badgeCards,
    BADGES_MORE_NOTE: '',
    CHAINS_EMPTY_CLASS: report.sectionMeta.chains?.enabled ? '' : 'empty-section',
    CHAIN_CARDS: chainCards,
    CHAINS_MORE_NOTE: '',
    GENERATED_AT: metadata.generatedAt,
    FOOTER_NOTE: metadata.footerNote
  }
  for (const [key, value] of Object.entries(replaceMap)) html = replacePlaceholder(html, key, value)
  const htmlPath = path.join(outputDir, `${targetBase}.html`)
  const pngPath = path.join(outputDir, `${targetBase}.png`)
  await fs.ensureDir(outputDir)
  await fs.writeFile(htmlPath, html, 'utf8')

  const win = new BrowserWindow({
    show: false,
    width: 430,
    height: 800,
    frame: false,
    backgroundColor: '#f3f5f7',
    webPreferences: { sandbox: true }
  })
  await win.loadFile(htmlPath)
  await win.webContents.executeJavaScript(`Promise.all([
    document.fonts.ready,
    ...Array.from(document.images).map((img) => img.complete ? Promise.resolve() : new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    }))
  ])`)
  win.webContents.debugger.attach('1.3')
  const metrics = await win.webContents.debugger.sendCommand('Page.getLayoutMetrics')
  const width = Math.max(430, Math.ceil(metrics.cssContentSize.width))
  const height = Math.ceil(metrics.cssContentSize.height)
  const screenshot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    fromSurface: true,
    clip: { x: 0, y: 0, width, height, scale: 1 }
  })
  await fs.writeFile(pngPath, Buffer.from(screenshot.data, 'base64'))
  if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
  win.destroy()
  return { htmlPath, pngPath, height }
}

app.whenReady().then(async () => {
  const mode = process.argv.includes('--full') ? 'full' : 'compact'
  const result =
    mode === 'full'
      ? await renderRequest(fullRequest, 'full-fixture')
      : await renderRequest(compactRequest, 'compact-fixture')
  console.log(JSON.stringify({ mode, result, outputDir }, null, 2))
  app.quit()
})
