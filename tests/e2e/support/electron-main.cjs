/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '../../..')
const fixture = require(path.join(root, 'tests/fixtures/chat-data.json'))
const userData = process.env.WXE_E2E_USER_DATA
if (!userData) throw new Error('WXE_E2E_USER_DATA is required')
app.setPath('userData', userData)
app.setPath('logs', path.join(userData, 'logs'))
app.commandLine.appendSwitch('disable-gpu')

const VALID_KEY = 'a'.repeat(64)
const imageData =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII='
const voiceData = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='
const reportJson = JSON.stringify({
  overview: '固定脱敏日报',
  hero: {
    headline: '产品测试群日报',
    summary: '测试消息已完成自动整理。',
    keyTakeaway: '核心流程可用',
    pendingNote: '',
    statusLine: '今日形成 1 个结论'
  },
  topics: [
    {
      title: '自动化测试',
      timeRange: '10:00-10:02',
      heat: '中',
      participants: ['测试成员'],
      summary: '讨论了脱敏自动化测试。',
      conclusions: [{ text: '核心流程可用', sourceMessageIds: ['msg-text'] }],
      keywords: ['测试'],
      sourceMessageIds: ['msg-text']
    }
  ],
  resources: [],
  importantMessages: [],
  quotes: [],
  qa: [],
  todos: [],
  unresolved: [],
  storylines: [],
  reversals: [],
  participantChains: [],
  keywords: ['测试']
})

let connected = process.env.WXE_E2E_MODE !== 'disconnected'
let savedKey = connected ? VALID_KEY : ''
let settings = {
  dbRoot: 'fixture-account',
  apiEnabled: false,
  apiHost: '127.0.0.1',
  apiPort: 5031,
  imageKeyRoot: 'fixture-account',
  ffmpegPath: '',
  recallProtectionEnabled: false,
  debugEnabled: false,
  autoLogin: connected,
  autoLoginPreferenceSet: true,
  appearanceTheme: 'light',
  compactMode: false,
  showStartupProgress: false,
  imageXorKey: '0x40',
  imageAesKey: '0123456789abcdef'
}

const extraContacts = Number(process.env.WXE_E2E_LARGE_CONTACTS || 0)
const contacts = [...fixture.contacts]
for (let index = 0; index < extraContacts; index += 1) {
  contacts.push({
    m_nsUsrName: `fixture_${index}`,
    m_nsNickName: `性能样本 ${index}`,
    md5: `fixture-contact-${index}`,
    type: index % 5 === 0 ? 'group' : 'user'
  })
}

const handlers = new Map()
const handle = (channel, fn) => {
  handlers.set(channel, fn)
  ipcMain.handle(channel, async (event, ...args) => fn(...args))
}

const startupCache = () => ({
  self: fixture.self,
  contacts,
  updatedAt: 1785553200000
})

handle('settings:get', () => ({ settings, settingsPath: path.join(userData, 'settings.json') }))
handle('settings:set', (patch) => {
  settings = { ...settings, ...patch }
  return { settings, settingsPath: path.join(userData, 'settings.json') }
})
handle('key:getSavedDbKey', () => ({
  success: true,
  key: savedKey || undefined,
  saved: Boolean(savedKey),
  encryptionAvailable: true
}))
handle('key:saveDbKey', (_accountRoot, key) => {
  savedKey = String(key || '')
  return { success: true, key: savedKey, saved: true, encryptionAvailable: true }
})
handle('key:clearSavedDbKey', () => {
  savedKey = ''
  return { success: true }
})
handle('key:getEnvironment', () => ({
  platform: process.platform,
  osVersion: process.platform === 'win32' ? 'Windows fixture' : 'macOS fixture',
  appVersion: 'v2.1.6',
  wechatVersion: '4.1.9.57',
  dataStructureVersion: settings.dbRoot === 'fixture-account' ? '微信 4.x（WCDB）' : '未检测到',
  dataDirectoryDetected: settings.dbRoot === 'fixture-account',
  diagnosticSummary: 'WechatExplorer: v2.1.6\n数据目录: 已检测到',
  autoDetectSupported: true,
  wechatRunning: true,
  accountIdentified: connected,
  dbConnected: connected,
  encryptionAvailable: true
}))
handle('key:readClipboardDbKey', () => ({ success: true, value: VALID_KEY }))
handle('key:pasteAndSaveDbKey', () => ({ success: true, key: VALID_KEY }))
handle('key:autoGetDbKey', () => ({ success: true, key: VALID_KEY, saved: false }))
handle('key:autoGetImageKey', () => ({
  success: true,
  xorKey: 64,
  aesKey: '0123456789abcdef',
  verified: true
}))

handle('db:init', (key, accountRoot) => {
  if (settings.dbRoot === 'Z:\\missing-wechat-data') {
    connected = false
    return {
      success: false,
      code: 'ROOT_UNAVAILABLE',
      error: '微信数据目录不存在，请重新选择目录',
      monitoring: false
    }
  }
  if (key !== VALID_KEY) {
    connected = false
    return { success: false, error: '数据库密钥无效', monitoring: false }
  }
  connected = true
  settings.dbRoot = accountRoot || settings.dbRoot
  return { success: true, monitoring: true }
})
handle('db:testConnection', (key) =>
  key === VALID_KEY
    ? { success: true, wxid: fixture.self.wxid, accountRoot: fixture.self.accountRoot }
    : { success: false, code: 'DATABASE_OPEN_FAILED', error: '数据库密钥无效' }
)
handle('db:disconnect', () => {
  connected = false
  return { success: true }
})
handle('db:getStartupCache', () =>
  process.env.WXE_E2E_CORRUPT_CACHE === '1' ? null : startupCache()
)
handle('db:getBootstrapCache', () =>
  process.env.WXE_E2E_CORRUPT_CACHE === '1' ? null : startupCache()
)
handle('db:getContacts', (filter) => {
  const query = String(filter || '').toLowerCase()
  return query
    ? contacts.filter((contact) => contact.m_nsNickName.toLowerCase().includes(query))
    : contacts
})
handle('db:getContactAvatars', (usernames) =>
  Object.fromEntries(
    contacts
      .filter((contact) => usernames.includes(contact.m_nsUsrName) && contact.avatar)
      .map((contact) => [contact.m_nsUsrName, contact.avatar])
  )
)
handle('settings:getSelf', () => ({ ready: true, info: fixture.self }))
handle('db:getCachedMessages', (md5) => fixture.messages[md5] || [])
handle('db:getCachedMessagePage', (md5) => ({
  hit: true,
  messages: fixture.messages[md5] || [],
  groupSnapshot: null
}))
handle('db:getMessages', (md5, startTime, endTime, options) => {
  let messages = fixture.messages[md5] || []
  if (startTime) messages = messages.filter((message) => (message.createTime || 0) >= startTime)
  if (endTime) messages = messages.filter((message) => (message.createTime || 0) <= endTime)
  if (options && options.limit) messages = messages.slice(-options.limit)
  return messages
})
handle('db:getGroupSnapshot', (md5) =>
  md5.startsWith('group-')
    ? {
        roomId: md5,
        memberCount: 1,
        members: [
          {
            wxid: 'wxid_fixture_member',
            nickname: '测试成员',
            groupNickname: '测试成员',
            wechatNickname: '测试成员',
            remark: '',
            avatar: ''
          }
        ]
      }
    : null
)
handle('db:getImage', (md5, datName, sessionId, options) =>
  md5 === 'unsupported'
    ? { success: false, error: '不支持的 DAT 版本' }
    : {
        success: true,
        data: imageData,
        isThumb: !options?.force,
        filePath: path.join(userData, options?.force ? 'original.png' : 'thumbnail.png')
      }
)
handle('db:getVoiceData', () => ({ success: true, data: voiceData }))
handle('db:getSticker', (url) =>
  String(url || '').includes('403')
    ? {
        success: false,
        error: '表情链接已失效或需要微信授权',
        failureCode: 'access_denied',
        httpStatus: 403
      }
    : { success: true, data: imageData }
)
handle('db:parseMessage', (content, messageType) =>
  messageType === 1
    ? { type: 'text', content: String(content) }
    : { type: 'unknown', raw: String(content), messageType }
)

handle('ai:getRuntimeConfig', () => ({
  providerId: 'fixture-provider',
  providerName: '本地假服务',
  model: 'fixture-model',
  modelName: '固定响应模型',
  configured: true,
  status: 'connected',
  timeoutMs: 5000
}))
handle('ai:listProviders', () => ({
  success: true,
  providers: [],
  defaultProviderId: 'fixture-provider'
}))
handle('ai:migrateLegacy', () => ({ success: true, providers: [] }))
handle('ai:chat', (messages) => {
  const failure = process.env.WXE_E2E_AI_FAILURE
  if (failure) return { success: false, error: `本地假服务错误 ${failure}` }
  const system = String(messages?.[0]?.content || '')
  if (system.includes('本地聊天检索规划器')) {
    return {
      success: true,
      data: '{"intent":"general","keywords":["测试"],"variants":[]}'
    }
  }
  if (system.includes('微信群聊日报编辑') || system.includes('JSON 格式修复器')) {
    return { success: true, data: reportJson, usage: { input: 10, output: 20, total: 30 } }
  }
  return { success: true, data: '固定假回答：测试数据中的核心流程正常。' }
})

handle('report:export', () => {
  const htmlPath = path.join(userData, 'fixture-report.html')
  const pngPath = path.join(userData, 'fixture-report.png')
  fs.writeFileSync(htmlPath, '<!doctype html><h1>固定脱敏日报</h1>', 'utf8')
  fs.writeFileSync(pngPath, Buffer.from(imageData.split(',')[1], 'base64'))
  return { success: true, imageDataUrl: imageData, htmlPath, pngPath }
})
handle('report:listGenerated', () => ({ success: true, reports: [] }))
handle('report:saveGenerated', (request) => ({
  success: true,
  record: { id: 'fixture-report-record', ...request }
}))
handle('report:deleteGenerated', () => ({ success: true }))
handle('report:reveal', () => ({ success: true }))
handle('copy-image', () => ({ success: true }))
handle('api:copyText', () => ({ success: true }))
handle('app-log:write', (entry) => {
  const safe = JSON.stringify(entry)
    .replace(/\b(?:0x)?[a-f0-9]{64}\b/gi, '***')
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, '***')
  fs.mkdirSync(path.join(userData, 'logs'), { recursive: true })
  fs.appendFileSync(path.join(userData, 'logs', 'e2e.log'), `${safe}\n`, 'utf8')
})
handle('app-log:getPath', () => path.join(userData, 'logs', 'e2e.log'))
handle('app-log:reveal', () => undefined)
handle('cache:getSummary', () => ({ bootstrapBytes: 0, electronBytes: 0, totalBytes: 0 }))
handle('cache:clear', () => ({ bootstrapBytes: 0, electronBytes: 0, totalBytes: 0 }))
handle('api:getStatus', () => ({ running: false, host: settings.apiHost, port: settings.apiPort }))
handle('api:start', () => ({ running: true, host: settings.apiHost, port: settings.apiPort }))
handle('api:stop', () => ({ running: false, host: settings.apiHost, port: settings.apiPort }))
handle('api:toggle', (enabled) => ({
  running: enabled,
  host: settings.apiHost,
  port: settings.apiPort
}))
handle('image:getConfig', () => ({
  success: true,
  configured: true,
  saved: true,
  encryptionAvailable: true,
  source: 'secure-storage',
  resourceRoot: settings.imageKeyRoot,
  xorKey: settings.imageXorKey,
  aesKey: settings.imageAesKey
}))
handle('image:saveConfig', (request) => ({
  success: true,
  configured: true,
  saved: true,
  encryptionAvailable: true,
  source: 'secure-storage',
  ...request
}))
handle('image:testConfig', () => ({
  success: true,
  fileFound: true,
  decrypted: true,
  readable: true,
  diagnosticLog: 'WechatExplorer 图片解析测试日志（已脱敏）\n测试结果：成功（SUCCESS）'
}))
handle('image:clearConfig', () => ({ success: true }))
handle('image:getDecoderStatus', () => ({
  installed: true,
  available: true,
  source: 'system',
  selected: false
}))
handle('image:getStatus', () => ({
  configured: true,
  saved: true,
  encryptionAvailable: true,
  source: 'secure-storage',
  resourceRoot: settings.imageKeyRoot,
  platform: process.platform,
  autoDetectSupported: true,
  wechatRunning: true,
  accountIdentified: true,
  cacheState: 'normal',
  decoder: { installed: true, available: true, source: 'system', selected: false },
  resources: Object.fromEntries(
    ['imageIndex', 'imageDirectory', 'thumbnail', 'original', 'sticker', 'video'].map((name) => [
      name,
      { state: 'available', detail: 'fixture' }
    ])
  )
}))
handle('settings:selectDbRoot', () => ({ canceled: false, path: 'fixture-account' }))
handle('accounts:discover', (inputPath) =>
  inputPath === 'Z:\\missing-wechat-data'
    ? { success: false, accounts: [], error: '微信数据目录不存在，请重新选择目录' }
    : {
        success: true,
        inputKind: 'account',
        preselectedAccountId: 'fixture-account-id',
        accounts: [
          {
            id: 'fixture-account-id',
            accountRoot: inputPath || 'fixture-account',
            directoryName: 'fixture-account',
            wxid: fixture.self.wxid,
            nickname: fixture.self.nickname,
            avatar: fixture.self.avatar,
            hasSavedDbKey: Boolean(savedKey),
            loginStatus: connected ? 'current' : 'unknown',
            selectedByInput: true
          }
        ]
      }
)
handle('agent-hub:getStatus', () => ({ state: 'disconnected', connected: false }))
handle('agent-hub:getLogs', () => [])
handle('app-update:getState', () => ({ status: 'idle', currentVersion: '2.1.6' }))

for (const channel of [
  'export:start',
  'export:cancel',
  'export:reveal',
  'settings:openAccountRoot',
  'db:reopenWithRoot',
  'api:skillStatus',
  'api:readSkill',
  'api:revealSkill',
  'api:openSkillGithub',
  'api:testLocalRequest',
  'image:selectDecoder',
  'image:openDecoderDownload',
  'app-update:check',
  'app-update:download',
  'app-update:install',
  'agent-hub:clearLogs',
  'agent-hub:startLogin',
  'agent-hub:cancelLogin',
  'agent-hub:reconnect',
  'agent-hub:disconnect',
  'agent-hub:selectTestImage',
  'image:listCandidates',
  'image:analyze',
  'image:getInsight',
  'image:listInsights',
  'db:search',
  'db:getVideo'
]) {
  if (!handlers.has(channel))
    handle(channel, () => ({ success: true, candidates: [], insights: [] }))
}

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(root, 'out/preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  window.once('ready-to-show', () => window.show())
  window.loadFile(path.join(root, 'out/renderer/index.html'))
})

app.on('window-all-closed', () => app.quit())
