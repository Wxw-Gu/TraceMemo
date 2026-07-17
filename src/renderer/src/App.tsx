import React, { useState } from 'react'
import { Sidebar } from './components/Sidebar'
import ChatWindow from './components/ChatWindow'
import { AppShell } from './components/layout/AppShell'
import { ApiWorkspace } from './features/api-center/ApiWorkspace'
import { SettingsWorkspace } from './features/settings/SettingsWorkspace'
import { AgentHubWorkspace } from './features/agent-hub/AgentHubWorkspace'
import type { SettingsCategoryId } from './features/settings/model/types'
import type { AIRuntimeModelConfig } from '../../shared/ai-provider'
import { AppPage } from './components/layout/navigation'
import { AiReportWorkspace } from './components/reports/AiReportWorkspace'
import { ReportHistorySidebar } from './components/reports/ReportHistorySidebar'
import { ReportInfoPanel } from './components/reports/ReportInfoPanel'
import { ReportSourceSidebar } from './components/reports/ReportSourceSidebar'
import { ReportTaskStatusPanel } from './components/reports/ReportTaskStatusPanel'
import { ReportViewer } from './components/reports/ReportViewer'
import { contactDisplayName } from './components/reports/types'
import type { GeneratedReportRecord, ReportWorkspaceView } from './components/reports/types'
import { AiModelConfig, useGroupReportGeneration } from './hooks/useGroupReportGeneration'
import { SummaryDateRange, SummaryMessageType } from './utils/group-report'
import { Contact, Message } from '../../shared/types'
import { DatabaseConnectionMode, DatabaseConnectionPage } from './components/DatabaseConnectionPage'

const SIDEBAR_MIN_WIDTH = 260
const SIDEBAR_MAX_WIDTH = 380

function getDevelopmentDatabaseKey(): string {
  if (!import.meta.env.DEV) return ''
  return String(import.meta.env.VITE_DB_KEY || '').trim()
}

interface SelfInfo {
  wxid: string
  nickname: string
  avatar?: string
  accountRoot: string
}

const MAC_KEY_FAQ_URL = 'https://github.com/hicccc77/WeFlow/blob/main/docs/MAC-KEY-FAQ.md'
const MESSAGE_MONITOR_DEBOUNCE_MS = 8000
const VIEW_MESSAGE_LIMIT = 600
const getMessageIdentity = (message: Message): string => {
  if (message.localId) return `local:${message.localId}`
  if (message.id) return `id:${message.id}`
  return `${message.createTime || 0}:${message.from}:${message.type}:${message.content}`
}

const areMessagesEquivalent = (left: Message[], right: Message[]): boolean => {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (getMessageIdentity(left[index]) !== getMessageIdentity(right[index])) return false
  }
  return true
}

type GroupSnapshot = {
  roomId: string
  memberCount: number
  members: {
    wxid: string
    nickname: string
    groupNickname: string
    wechatNickname: string
    remark: string
    avatar: string
  }[]
}

type GroupMemberMeta = { nickname: string; avatar: string }
type StartupProgress = {
  title: string
  subtitle: string
  detail?: string
  percent?: number
}

const formatGroupMemberName = (member: GroupSnapshot['members'][number]): string =>
  member.nickname || member.wxid

const buildSyntheticGroupMessages = (
  previous: GroupSnapshot | null,
  next: GroupSnapshot | null,
  referenceMessages: Message[]
): Message[] => {
  if (!previous || !next || previous.roomId !== next.roomId) return []

  const previousMap = new Map(previous.members.map((member) => [member.wxid, member]))
  const nextMap = new Map(next.members.map((member) => [member.wxid, member]))
  const latestMessageTime = referenceMessages.reduce(
    (max, message) => Math.max(max, message.createTime || 0),
    0
  )
  const fallbackNow = Math.floor(Date.now() / 1000)
  const events: Message[] = []

  let offset = 1
  for (const [wxid, member] of previousMap.entries()) {
    if (nextMap.has(wxid)) continue
    const name = formatGroupMemberName(member)
    const eventTime = Math.max(latestMessageTime + offset, fallbackNow)
    const eventDate = new Date(eventTime * 1000)
    offset += 1
    events.push({
      id: `synthetic-leave:${next.roomId}:${wxid}:${eventTime}`,
      from: 'system',
      type: '系统消息',
      datetime: eventDate.toLocaleString('zh-CN', { hour12: false }),
      content: `${name} 退出了群聊`,
      isSender: false,
      createTime: eventTime
    })
  }

  if (events.length) {
    console.log(
      `[GroupMonitor] synthetic leave detected roomId=${next.roomId} events=${events
        .map((event) => event.content)
        .join(' | ')}`
    )
  }

  return events
}

void buildSyntheticGroupMessages

const sortMessagesChronologically = (items: Message[]): Message[] =>
  [...items].sort((left, right) => {
    const timeDelta = (left.createTime || 0) - (right.createTime || 0)
    if (timeDelta !== 0) return timeDelta
    return getMessageIdentity(left).localeCompare(getMessageIdentity(right))
  })

function App(): React.ReactElement {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isDatabaseConnected, setIsDatabaseConnected] = useState(false)
  const [dbKey, setDbKey] = useState(getDevelopmentDatabaseKey)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [isMessagesLoading, setIsMessagesLoading] = useState(false)
  const [filteredContacts, setFilteredContacts] = useState<Contact[]>([])
  const [dateRange, setDateRange] = useState('today') // 默认今天
  const [contentFilter, setContentFilter] = useState('')
  const [isFetchingDbKey, setIsFetchingDbKey] = useState(false)
  const [dbKeyStatus, setDbKeyStatus] = useState('')
  const [dbKeyStatusKind, setDbKeyStatusKind] = useState<'normal' | 'success' | 'error'>('normal')
  const [showDbKey, setShowDbKey] = useState(false)
  const [dbRootInput, setDbRootInput] = useState('')
  const [showMacKeyFaq, setShowMacKeyFaq] = useState(false)
  const [databaseConnectionMode, setDatabaseConnectionMode] = useState<DatabaseConnectionMode>(
    getDevelopmentDatabaseKey() ? 'manual' : 'automatic'
  )
  const [activePage, setActivePage] = useState<AppPage>('archive')
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategoryId>('account-database')
  const [reportSourceContact, setReportSourceContact] = useState<Contact | null>(null)
  const [reportWorkspaceView, setReportWorkspaceView] = useState<ReportWorkspaceView>('result')
  const [generatedReports, setGeneratedReports] = useState<GeneratedReportRecord[]>([])
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null)
  const [latestGeneratedReportId, setLatestGeneratedReportId] = useState<string | null>(null)
  const [isSavingGeneratedReport, setIsSavingGeneratedReport] = useState(false)
  const [reportNotice, setReportNotice] = useState('')
  const [summaryDateRange, setSummaryDateRange] = useState<SummaryDateRange>('today')
  const [summaryMessageTypes, setSummaryMessageTypes] = useState<SummaryMessageType[]>(['text'])
  const [aiModelConfig, setAiModelConfig] = useState<AiModelConfig>({
    providerName: '尚未配置',
    model: '',
    modelName: '尚未选择模型',
    configured: false,
    status: 'untested'
  })
  const [selfInfo, setSelfInfo] = useState<SelfInfo | null>(null)
  const [isNativeMonitorActive, setIsNativeMonitorActive] = useState(false)
  const [bootState, setBootState] = useState<'loading' | 'connecting' | 'login'>('loading')
  const [autoConnectSource, setAutoConnectSource] = useState<'env' | 'saved' | null>(null)
  const [startupProgress, setStartupProgress] = useState<StartupProgress | null>(null)
  const currentGroupSnapshotRef = React.useRef<GroupSnapshot | null>(null)
  const syntheticGroupMessagesRef = React.useRef<Record<string, Message[]>>({})
  const groupMemberMetaRef = React.useRef<Record<string, Map<string, GroupMemberMeta>>>({})
  React.useEffect(() => {
    if (!reportNotice) return
    const timer = window.setTimeout(() => setReportNotice(''), 3200)
    return () => window.clearTimeout(timer)
  }, [reportNotice])
  React.useEffect(() => {
    const loadAIConfig = async (): Promise<void> => {
      try {
        const legacy = {
          apiKey: localStorage.getItem('ai_api_key') || undefined,
          baseUrl: localStorage.getItem('ai_base_url') || undefined,
          model: localStorage.getItem('ai_model') || undefined
        }
        if (legacy.apiKey || legacy.baseUrl || legacy.model) {
          const migrated = await window.api.migrateLegacyAIConfig(legacy)
          if (migrated.success) {
            localStorage.removeItem('ai_api_key')
            localStorage.removeItem('ai_base_url')
            localStorage.removeItem('ai_model')
          }
        }
        setAiModelConfig(await window.api.getAIRuntimeConfig())
      } catch (error) {
        console.warn('[AI Provider] 配置加载失败:', error)
      }
    }
    void loadAIConfig()
  }, [])
  const selectedContactMd5Ref = React.useRef<string>('')
  const contactAvatarHydrationRunRef = React.useRef(0)
  const reportGeneration = useGroupReportGeneration({
    sourceContact: reportSourceContact,
    summaryDateRange,
    summaryMessageTypes,
    modelConfig: aiModelConfig
  })
  const lastCapturedReportKeyRef = React.useRef('')

  const loadGeneratedReports = React.useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.listGeneratedReports()
      if (!result.success) {
        setReportNotice(result.error || '日报历史加载失败')
        return
      }
      const reports = result.reports || []
      setGeneratedReports(reports)
      setSelectedReportId((current) =>
        current && reports.some((report) => report.id === current) ? current : null
      )
    } catch (error) {
      setReportNotice(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const waitForPaint = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 80))

  const refreshSelfInfo = async (attempts = 1): Promise<SelfInfo | null> => {
    let lastError: unknown
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
      try {
        const result = await window.api.getSelf()
        if (result.ready && result.info) {
          setSelfInfo(result.info)
          return result.info
        }
      } catch (error) {
        lastError = error
      }
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => window.setTimeout(resolve, 180))
      }
    }
    if (lastError) console.warn('[SelfInfo] 加载失败:', lastError)
    setSelfInfo(null)
    return null
  }

  const loadBootstrapCache = async (): Promise<boolean> => {
    try {
      const cache = await window.api.getBootstrapCache()
      if (!cache) return false
      if (cache.contacts.length) {
        setContacts(cache.contacts)
        setFilteredContacts(cache.contacts)
      }
      if (cache.self) setSelfInfo(cache.self)
      return Boolean(cache.contacts.length || cache.self)
    } catch (error) {
      console.warn('[BootstrapCache] 加载失败:', error)
      return false
    }
  }

  const loadContacts = async (options?: {
    waitForAvatars?: boolean
    onProgress?: (message: string, percent?: number) => void
  }): Promise<void> => {
    options?.onProgress?.('正在加载联系人...', 35)
    const list = await window.api.getContacts()
    setContacts(list)
    setFilteredContacts(list)
    const runId = ++contactAvatarHydrationRunRef.current
    const hydrate = (): Promise<void> => hydrateContactAvatars(list, runId, options?.onProgress)
    if (options?.waitForAvatars) {
      await hydrate()
    } else {
      window.setTimeout(() => {
        void hydrate()
      }, 1500)
    }
  }

  const hydrateContactAvatars = async (
    list: Contact[],
    runId: number,
    onProgress?: (message: string, percent?: number) => void
  ): Promise<void> => {
    const usernames = Array.from(
      new Set(
        list
          .map((contact) => contact.m_nsUsrName)
          .filter((username, index) => {
            const contact = list[index]
            return (
              username &&
              !contact.avatar &&
              !username.startsWith('Group_') &&
              !username.startsWith('Unknown_')
            )
          })
      )
    )
    onProgress?.(
      usernames.length ? `正在加载头像 0/${usernames.length}...` : '头像缓存已就绪',
      usernames.length ? 55 : 90
    )
    let loadedCount = 0
    const chunkSize = 32
    for (let index = 0; index < usernames.length; index += chunkSize) {
      if (runId !== contactAvatarHydrationRunRef.current) return
      const chunk = usernames.slice(index, index + chunkSize)
      if (chunk.length === 0) continue
      try {
        const avatars = await window.api.getContactAvatars(chunk)
        if (runId !== contactAvatarHydrationRunRef.current) return
        loadedCount += chunk.length
        onProgress?.(
          `正在加载头像 ${Math.min(loadedCount, usernames.length)}/${usernames.length}...`,
          55 + Math.round((Math.min(loadedCount, usernames.length) / usernames.length) * 35)
        )
        if (Object.keys(avatars).length === 0) continue
        setContacts((current) =>
          current.map((contact) =>
            avatars[contact.m_nsUsrName]
              ? { ...contact, avatar: avatars[contact.m_nsUsrName] }
              : contact
          )
        )
        setFilteredContacts((current) =>
          current.map((contact) =>
            avatars[contact.m_nsUsrName]
              ? { ...contact, avatar: avatars[contact.m_nsUsrName] }
              : contact
          )
        )
      } catch (error) {
        console.warn('[Contacts] avatar hydrate failed:', error)
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50))
    }
    if (usernames.length) onProgress?.('头像加载完成', 90)
  }

  React.useEffect(() => {
    let active = true
    const attemptAutoConnect = async (): Promise<void> => {
      const settingsResult = await window.api.getSettings()
      // 预填已保存的微信聊天文件路径
      if (active && settingsResult.settings.dbRoot) {
        setDbRootInput(settingsResult.settings.dbRoot)
      }
      const autoLoginEnabled = settingsResult.settings.autoLogin
      // 开发环境允许使用 VITE_DB_KEY；生产安装包只能读取目标电脑自己的 safeStorage。
      const envKey = getDevelopmentDatabaseKey()
      // 生产环境以及未配置开发密钥时，读取上一次保存到 safeStorage 的密钥。
      let savedKey = ''
      if (!envKey) {
        const result = await window.api.getSavedDbKey()
        if (result.success && result.key) savedKey = result.key
      }
      const key = envKey || savedKey
      if (!key) {
        if (active) {
          setDatabaseConnectionMode('automatic')
          setBootState('login')
        }
        return
      }
      if (active) {
        setDbKey(key)
        setDatabaseConnectionMode('manual')
        setAutoConnectSource(envKey ? 'env' : 'saved')
        setDbKeyStatus(
          autoLoginEnabled
            ? envKey
              ? '检测到环境变量中的密钥，正在自动连接...'
              : '已加载安全保存的密钥，正在自动连接...'
            : envKey
              ? '已加载环境变量中的密钥，请手动点击 Connect'
              : '已加载安全保存的密钥，请手动点击 Connect'
        )
        setDbKeyStatusKind('normal')
        setBootState(autoLoginEnabled ? 'connecting' : 'login')
      }
      if (!autoLoginEnabled) return
      try {
        const result = await window.api.initDb(key)
        if (!active) return
        const success = typeof result === 'boolean' ? result : result.success
        if (success) {
          if (!settingsResult.settings.autoLoginPreferenceSet) {
            void window.api.setSettings({ autoLogin: true })
          }
          setIsNativeMonitorActive(typeof result !== 'boolean' && result.monitoring === true)
          setIsDatabaseConnected(true)
          setDbKeyStatus('已自动连接')
          setDbKeyStatusKind('success')
          await loadContacts()
          await refreshSelfInfo(3)
          setIsAuthenticated(true)
        } else {
          const error = typeof result === 'boolean' ? '' : result.error
          setDbKeyStatus(`自动连接失败，请重新输入${error ? `: ${error}` : ''}`)
          setDbKeyStatusKind('error')
          setBootState('login')
        }
      } catch (error: unknown) {
        if (!active) return
        const message = error instanceof Error ? error.message : String(error)
        setDbKeyStatus(`自动连接失败: ${message}`)
        setDbKeyStatusKind('error')
        setBootState('login')
      }
    }
    void attemptAutoConnect()
    const unsubscribe = window.api.onDbKeyStatus(({ message }) => {
      if (!active) return
      setDbKeyStatus(message)
      setDbKeyStatusKind('normal')
    })
    return () => {
      active = false
      unsubscribe()
    }
    // 自动连接只在应用启动时执行一次，避免联系人加载刷新触发重复连接。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    if (!isAuthenticated) return
    void loadGeneratedReports()
  }, [isAuthenticated, loadGeneratedReports])

  const handleLogin = async (keyInput?: string): Promise<void> => {
    const keyToUse = keyInput || dbKey
    if (!keyToUse) return
    setBootState('connecting')
    // 持久化用户手动指定的微信聊天文件路径，供 db:init 读取 settings.dbRoot
    const trimmedRoot = dbRootInput.trim()
    if (trimmedRoot) {
      try {
        await window.api.setSettings({ dbRoot: trimmedRoot })
      } catch {
        // 忽略保存失败，仍尝试用默认路径连接
      }
    }
    setStartupProgress({
      title: '正在连接数据库...',
      subtitle: '正在初始化微信数据',
      detail: '请稍候',
      percent: 8
    })
    try {
      setStartupProgress({
        title: '正在连接数据库...',
        subtitle: '正在初始化微信数据',
        detail: '正在打开 WCDB 数据库',
        percent: 15
      })
      const result = await window.api.initDb(keyToUse)
      const success = typeof result === 'boolean' ? result : result.success
      if (success) {
        setIsNativeMonitorActive(typeof result !== 'boolean' && result.monitoring === true)
        setStartupProgress({
          title: '正在读取缓存...',
          subtitle: '正在恢复上次联系人和头像',
          detail: '正在读取本地缓存',
          percent: 25
        })
        await loadBootstrapCache()
        // 持久化手动输入的密钥，供下次启动继续使用
        void window.api.saveDbKey(keyToUse).catch(() => undefined)
        void window.api.getSettings().then((current) => {
          if (!current.settings.autoLoginPreferenceSet) {
            void window.api.setSettings({ autoLogin: true })
          }
        })
        setStartupProgress({
          title: '正在加载账号信息...',
          subtitle: '即将进入 WechatExplorer',
          detail: '正在读取联系人和当前账号',
          percent: 70
        })
        // 账号识别依赖联系人数据就绪。返回登录后数据已被清空，如果先查账号，
        // 会出现“数据库已连接，但账号未连接”的分离状态。手动连接与启动自动连接保持同一顺序。
        await loadContacts({ waitForAvatars: false })
        await refreshSelfInfo(3)
        setStartupProgress({
          title: '加载完成',
          subtitle: '正在进入主页面',
          detail: '联系人和头像已准备好',
          percent: 100
        })
        setIsAuthenticated(true)
        setIsDatabaseConnected(true)
        setBootState('login')
        window.setTimeout(() => {
          setStartupProgress(null)
        }, 500)
      } else {
        const error = typeof result === 'boolean' ? '' : result.error
        setBootState('login')
        setStartupProgress(null)
        alert(`Failed to open database.${error ? `\n\n${error}` : '\nCheck your key.'}`)
      }
    } catch (error) {
      console.error(error)
      setBootState('login')
      setStartupProgress(null)
      alert('Error connecting to database')
    }
  }

  const logGroupSnapshot = React.useCallback(
    async (contact: Contact | null, reason: string): Promise<GroupSnapshot | null> => {
      if (!contact || contact.type !== 'group') return null
      try {
        const snapshot = (await window.api.getGroupSnapshot(contact.md5)) as GroupSnapshot | null
        if (!snapshot) {
          return null
        }
        return snapshot
      } catch (error) {
        console.warn(`[GroupSnapshot] reason=${reason} name=${contact.m_nsNickName} failed:`, error)
        return null
      }
    },
    []
  )

  const mergeSyntheticMessages = React.useCallback(
    (contact: Contact | null, baseMessages: Message[], roomId?: string): Message[] => {
      if (!contact || contact.type !== 'group') return baseMessages
      const resolvedRoomId = roomId || currentGroupSnapshotRef.current?.roomId
      if (!resolvedRoomId) return baseMessages
      const synthetic = syntheticGroupMessagesRef.current[resolvedRoomId] || []
      return synthetic.length
        ? sortMessagesChronologically([...baseMessages, ...synthetic])
        : baseMessages
    },
    []
  )

  const applyGroupMemberMeta = React.useCallback(
    (contact: Contact | null, baseMessages: Message[]): Message[] => {
      if (!contact || contact.type !== 'group') return baseMessages
      const memberMap = groupMemberMetaRef.current[contact.md5]
      if (!memberMap || memberMap.size === 0) return baseMessages

      return baseMessages.map((message) => {
        const senderId = String(message.senderId || message.name || '').trim()
        if (!senderId) return message
        const member = memberMap.get(senderId)
        if (!member) return message
        const rawNickname = String(member.nickname || '').trim()
        const nickname =
          rawNickname &&
          rawNickname !== senderId &&
          !rawNickname.startsWith('wxid_') &&
          !/^[a-z]{2,}\d{4,}$/i.test(rawNickname)
            ? rawNickname
            : senderId
        return {
          ...message,
          name: nickname,
          img: message.img || member.avatar
        }
      })
    },
    []
  )

  const loadGroupMemberMeta = React.useCallback(
    async (contact: Contact | null): Promise<GroupSnapshot | null> => {
      if (!contact || contact.type !== 'group') return null
      const snapshot = await logGroupSnapshot(contact, 'load-member-meta')
      if (!snapshot) return null
      currentGroupSnapshotRef.current = snapshot
      groupMemberMetaRef.current[contact.md5] = new Map(
        snapshot.members.map((member) => [
          member.wxid,
          { nickname: member.nickname || member.wxid, avatar: member.avatar || '' }
        ])
      )
      return snapshot
    },
    [logGroupSnapshot]
  )

  const handleAutoGetDbKey = async (): Promise<void> => {
    if (isFetchingDbKey) return
    setIsFetchingDbKey(true)
    setDbKeyStatus('正在准备获取密钥...')
    setDbKeyStatusKind('normal')
    setShowMacKeyFaq(false)
    try {
      const result = await window.api.autoGetDbKey()
      if (!result.success || !result.key) {
        setShowMacKeyFaq(result.code === 'SCAN_FAILED')
        throw new Error(result.error || '获取密钥失败')
      }
      setDbKey(result.key)
      setDatabaseConnectionMode('manual')
      setDbKeyStatus(result.saved ? '密钥已获取并安全保存' : result.warning || '密钥已获取')
      setDbKeyStatusKind(result.saved ? 'success' : 'normal')
    } catch (error) {
      setDbKeyStatus(error instanceof Error ? error.message : String(error))
      setDbKeyStatusKind('error')
    } finally {
      setIsFetchingDbKey(false)
    }
  }

  const handlePasteAndSaveDbKey = async (): Promise<void> => {
    setShowMacKeyFaq(false)
    const result = await window.api.pasteAndSaveDbKey()
    if (result.success && result.key) {
      setDbKey(result.key)
      setDatabaseConnectionMode('manual')
      setDbKeyStatus('已从剪贴板粘贴并安全保存')
      setDbKeyStatusKind('success')
    } else {
      setDbKeyStatus(result.error || '粘贴并保存失败')
      setDbKeyStatusKind('error')
    }
  }

  const handleClearSavedDbKey = async (): Promise<void> => {
    setShowMacKeyFaq(false)
    const result = await window.api.clearSavedDbKey()
    if (!result.success) {
      setDbKeyStatus(result.error || '清除密钥失败')
      setDbKeyStatusKind('error')
      return
    }
    setDbKey('')
    setDatabaseConnectionMode('automatic')
    setDbKeyStatus('已清除保存的密钥')
    setDbKeyStatusKind('normal')
  }

  const handleReturnToLogin = (): void => {
    setIsAuthenticated(false)
    setIsDatabaseConnected(false)
    setBootState('login')
    setDatabaseConnectionMode(dbKey ? 'manual' : 'automatic')
    setActivePage('archive')
    setSettingsCategory('database-key')
    setSelectedContact(null)
    setMessages([])
    setContacts([])
    setFilteredContacts([])
    setSelfInfo(null)
    setIsMessagesLoading(false)
    setIsNativeMonitorActive(false)
    setReportNotice('')
    setDbKeyStatus('已断开当前连接，可重新输入或获取数据库密钥')
    setDbKeyStatusKind('normal')
    setStartupProgress(null)
  }

  const getDateRangeParams = (
    range: string
  ): { startTime: number | undefined; endTime: number | undefined } => {
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000

    let startTime: number | undefined
    let endTime: number | undefined

    switch (range) {
      case 'today':
        startTime = startOfToday
        break
      case 'yesterday':
        startTime = startOfToday - 86400
        endTime = startOfToday - 1 // 昨天结束
        break
      case '7':
        startTime = Math.floor(Date.now() / 1000) - 7 * 86400
        break
      case '30':
        startTime = Math.floor(Date.now() / 1000) - 30 * 86400
        break
      case 'all':
        startTime = undefined
        break
      default:
        startTime = startOfToday
    }
    return { startTime, endTime }
  }

  const handleSelectContact = async (contact: Contact): Promise<void> => {
    setSelectedContact(contact)
    selectedContactMd5Ref.current = contact.md5
    currentGroupSnapshotRef.current = null
    setIsMessagesLoading(true)
    const { startTime, endTime } = getDateRangeParams(dateRange)
    const cachedMsgs = await window.api.getCachedMessages(contact.md5, startTime, endTime)
    if (selectedContactMd5Ref.current !== contact.md5) return
    if (cachedMsgs.length) {
      setMessages(
        applyGroupMemberMeta(
          contact,
          mergeSyntheticMessages(contact, cachedMsgs.slice(-VIEW_MESSAGE_LIMIT))
        )
      )
    } else {
      setMessages([])
    }
    await waitForPaint()
    try {
      const msgs = await window.api.getMessages(contact.md5, startTime, endTime, {
        limit: VIEW_MESSAGE_LIMIT
      })
      if (selectedContactMd5Ref.current !== contact.md5) return
      const cachedMessages = applyGroupMemberMeta(contact, mergeSyntheticMessages(contact, msgs))
      setMessages(cachedMessages)
      if (contact.type === 'group') {
        window.setTimeout(() => {
          void loadGroupMemberMeta(contact).then((snapshot) => {
            if (selectedContactMd5Ref.current !== contact.md5) return
            if (!snapshot) return
            setMessages((current) =>
              applyGroupMemberMeta(
                contact,
                mergeSyntheticMessages(contact, current, snapshot.roomId)
              )
            )
          })
        }, 120)
      }
    } finally {
      if (selectedContactMd5Ref.current === contact.md5) setIsMessagesLoading(false)
    }
  }

  const handleDateRangeChange = (range: string): void => {
    setDateRange(range)
    if (selectedContact) {
      const { startTime, endTime } = getDateRangeParams(range)
      window.api
        .getCachedMessages(selectedContact.md5, startTime, endTime)
        .then((cachedMessages) => {
          if (!cachedMessages.length) return
          setMessages(
            applyGroupMemberMeta(
              selectedContact,
              mergeSyntheticMessages(selectedContact, cachedMessages.slice(-VIEW_MESSAGE_LIMIT))
            )
          )
        })
      setIsMessagesLoading(true)
      window.api
        .getMessages(selectedContact.md5, startTime, endTime, { limit: VIEW_MESSAGE_LIMIT })
        .then((nextMessages) => {
          setMessages(
            applyGroupMemberMeta(
              selectedContact,
              mergeSyntheticMessages(selectedContact, nextMessages)
            )
          )
          setIsMessagesLoading(false)
        })
        .catch((error) => {
          console.warn('[Messages] date range load failed:', error)
          setIsMessagesLoading(false)
        })
    }
  }

  React.useEffect(() => {
    if (!isAuthenticated || !selectedContact || !isNativeMonitorActive) return

    let disposed = false
    let refreshTimer: number | null = null
    let refreshInFlight = false
    let refreshQueued = false
    const contactMd5 = selectedContact.md5

    const refreshCurrentConversation = async (): Promise<void> => {
      if (refreshInFlight) {
        refreshQueued = true
        return
      }
      refreshInFlight = true
      try {
        const range = getDateRangeParams(dateRange)
        const latestMessages = await window.api.getMessages(
          contactMd5,
          range.startTime,
          range.endTime,
          { limit: VIEW_MESSAGE_LIMIT }
        )
        const nextMessages = applyGroupMemberMeta(
          selectedContact,
          mergeSyntheticMessages(selectedContact, latestMessages)
        )
        if (!disposed) {
          setMessages((current) =>
            areMessagesEquivalent(current, nextMessages) ? current : nextMessages
          )
        }
      } catch (error) {
        console.warn('[MessageMonitor] 刷新当前会话失败:', error)
      }
      refreshInFlight = false
      if (refreshQueued && !disposed) {
        refreshQueued = false
        if (refreshTimer) window.clearTimeout(refreshTimer)
        refreshTimer = window.setTimeout(() => {
          refreshTimer = null
          void refreshCurrentConversation()
        }, MESSAGE_MONITOR_DEBOUNCE_MS)
      }
    }

    const unsubscribe = window.api.onWcdbChange(() => {
      if (refreshTimer) window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null
        void refreshCurrentConversation()
      }, MESSAGE_MONITOR_DEBOUNCE_MS)
    })

    return () => {
      disposed = true
      if (refreshTimer) window.clearTimeout(refreshTimer)
      unsubscribe()
    }
  }, [
    dateRange,
    isAuthenticated,
    isNativeMonitorActive,
    selectedContact,
    logGroupSnapshot,
    applyGroupMemberMeta,
    mergeSyntheticMessages
  ])

  const handleSearchContacts = (keyword: string): void => {
    if (!keyword) {
      setFilteredContacts(contacts)
    } else {
      const lower = keyword.toLowerCase()
      const filtered = contacts.filter(
        (c) =>
          c.m_nsNickName.toLowerCase().includes(lower) ||
          c.m_nsUsrName.toLowerCase().includes(lower)
      )
      setFilteredContacts(filtered)
    }
  }

  const isGroupContact = (contact: Contact | null): boolean =>
    Boolean(contact?.type === 'group' || contact?.m_nsUsrName?.endsWith('@chatroom'))

  const handlePageChange = (page: AppPage): void => {
    setActivePage(page)
    if (page === 'settings') setSettingsCategory('account-database')
    if (page === 'report' && isGroupContact(selectedContact) && !reportSourceContact) {
      setReportSourceContact(selectedContact)
    }
    if (page === 'report') {
      setReportWorkspaceView('result')
      setSelectedReportId(null)
    }
  }

  const openSettings = (): void => {
    setSettingsCategory('account-database')
    setActivePage('settings')
  }

  const openModelSettings = (): void => {
    setSettingsCategory('ai-model')
    setActivePage('settings')
  }

  const openReport = (reportId: string): void => {
    setSelectedReportId(reportId)
    setReportWorkspaceView('result')
    setActivePage('report')
  }

  const handleOpenReportWorkspace = (): void => {
    if (!selectedContact) {
      setReportNotice('请先选择一个群聊')
      return
    }
    if (!isGroupContact(selectedContact)) {
      setReportNotice('AI 群聊日报仅支持群聊')
      return
    }
    setReportNotice('')
    setReportSourceContact(selectedContact)
    setReportWorkspaceView('configure')
    setActivePage('report')
  }

  const handleSelectReportSource = (contact: Contact): void => {
    setReportSourceContact(contact)
    if (selectedContact?.md5 !== contact.md5) {
      void handleSelectContact(contact)
    }
  }

  React.useEffect(() => {
    if (
      reportGeneration.phase !== 'success' ||
      !reportSourceContact ||
      !reportGeneration.generatedImage ||
      !reportGeneration.reportPaths
    ) {
      return
    }

    const recordKey = `${reportGeneration.reportPaths.pngPath}:${reportGeneration.reportPaths.htmlPath}`
    if (lastCapturedReportKeyRef.current === recordKey) return
    lastCapturedReportKeyRef.current = recordKey
    setLatestGeneratedReportId(null)
    setIsSavingGeneratedReport(true)

    const saveReport = async (): Promise<void> => {
      const result = await window.api.saveGeneratedReport({
        contactId: reportSourceContact.md5,
        contactName: contactDisplayName(reportSourceContact),
        contactAvatar: reportSourceContact.avatar || undefined,
        dateRange:
          summaryDateRange === 'yesterday'
            ? '昨日'
            : summaryDateRange === '7days'
              ? '近 7 天'
              : '今天',
        messageCount: reportGeneration.reportMessages.length,
        generatedAt: new Date().toISOString(),
        generatedImage: reportGeneration.generatedImage || undefined,
        htmlPath: reportGeneration.reportPaths?.htmlPath,
        pngPath: reportGeneration.reportPaths?.pngPath,
        duration: reportGeneration.generationMetadata.durationMs,
        modelName: reportGeneration.generationMetadata.modelName || aiModelConfig.model,
        tokenUsage: reportGeneration.generationMetadata.tokenUsage,
        generationLogs: reportGeneration.generationMetadata.generationLogs
      })

      if (!result.success || !result.record) {
        setIsSavingGeneratedReport(false)
        setReportNotice(result.error || '日报保存失败')
        return
      }

      setGeneratedReports((current) => [
        result.record as GeneratedReportRecord,
        ...current.filter((report) => report.id !== result.record?.id)
      ])
      setLatestGeneratedReportId(result.record.id)
      setIsSavingGeneratedReport(false)
      openReport(result.record.id)
    }

    void saveReport()
  }, [
    aiModelConfig.model,
    reportGeneration.generatedImage,
    reportGeneration.generationMetadata,
    reportGeneration.phase,
    reportGeneration.reportMessages.length,
    reportGeneration.reportPaths,
    reportSourceContact,
    summaryDateRange
  ])

  const selectedReport = generatedReports.find((report) => report.id === selectedReportId) || null

  const openReportResult = (): void => {
    if (isSavingGeneratedReport) {
      setReportNotice('日报正在保存，请稍候')
      return
    }
    const targetReportId = latestGeneratedReportId || selectedReportId
    if (targetReportId) {
      openReport(targetReportId)
      return
    }
    setReportWorkspaceView('result')
  }

  const openReportConfigure = (): void => {
    setReportWorkspaceView('configure')
  }

  const handleRegenerateReport = (): void => {
    if (selectedReport) {
      const source = contacts.find((contact) => contact.md5 === selectedReport.contactId)
      if (source) setReportSourceContact(source)
    }
    setReportWorkspaceView('configure')
  }

  const handleCopyReportImage = async (
    report: GeneratedReportRecord
  ): Promise<{ success: boolean; error?: string }> => {
    if (!report.generatedImage) return { success: false, error: '没有可复制的日报图片' }
    return window.api.copyImage(report.generatedImage)
  }

  const handleRevealReport = async (
    report: GeneratedReportRecord
  ): Promise<{ success: boolean; error?: string }> => {
    const filePath = report.pngPath || report.htmlPath
    if (!filePath) return { success: false, error: '当前报告缺少文件路径' }
    return window.api.revealGroupReport(filePath)
  }

  const handleDeleteReport = async (
    reportId: string
  ): Promise<{ success: boolean; error?: string }> => {
    const result = await window.api.deleteGeneratedReport(reportId)
    if (!result.success) return { success: false, error: result.error || '删除日报失败' }

    setGeneratedReports((current) => current.filter((report) => report.id !== reportId))
    if (selectedReportId === reportId) {
      setSelectedReportId(null)
    }
    if (latestGeneratedReportId === reportId) setLatestGeneratedReportId(null)
    return { success: true }
  }

  const renderPlaceholderPage = (
    page: Exclude<AppPage, 'archive' | 'report' | 'agent-hub'>
  ): React.ReactElement => {
    const labels: Record<Exclude<AppPage, 'archive' | 'report' | 'agent-hub'>, string> = {
      search: '检索',
      export: '导出',
      api: 'API',
      settings: '设置'
    }
    return (
      <div className="app-page-placeholder">
        <div className="app-page-placeholder-eyebrow">WechatExplorer</div>
        <h2>{labels[page]}</h2>
        <p>这个工作区会在后续 UI 重构阶段接入真实功能。</p>
      </div>
    )
  }

  const renderArchiveWorkspace = (): React.ReactElement => (
    <div className="app-container">
      <Sidebar
        contacts={filteredContacts}
        selectedContact={selectedContact}
        onSelectContact={handleSelectContact}
        onSearch={handleSearchContacts}
        onContentFilter={setContentFilter}
        width={sidebarWidth}
        dateRange={dateRange}
        onDateRangeChange={handleDateRangeChange}
        selfInfo={selfInfo}
        dbReady={isDatabaseConnected}
        onOpenSettings={openSettings}
      />
      <div className="resizer" onMouseDown={startResizing} />
      <ChatWindow
        key={selectedContact?.md5}
        contact={selectedContact}
        messages={messages}
        isLoadingMessages={isMessagesLoading}
        contentFilter={contentFilter}
        dateRange={dateRange}
        onContentFilterChange={setContentFilter}
        onRefresh={() => selectedContact && handleSelectContact(selectedContact)}
        onRefreshData={loadContacts}
        onCreateGroupReport={handleOpenReportWorkspace}
        isAiLoading={reportGeneration.isGenerating}
      />
    </div>
  )

  const renderReportWorkspace = (): React.ReactElement =>
    reportWorkspaceView === 'result' ? (
      <div className="report-center-page">
        <ReportHistorySidebar
          reports={generatedReports}
          selectedReportId={selectedReportId}
          selfInfo={selfInfo}
          dbReady={isDatabaseConnected}
          onSelectReport={openReport}
          onCreateReport={openReportConfigure}
          onDeleteReport={handleDeleteReport}
          onOpenSettings={openSettings}
        />
        <ReportViewer
          report={selectedReport}
          hasReports={generatedReports.length > 0}
          onBackToConfigure={openReportConfigure}
          onRegenerate={handleRegenerateReport}
          onCopyImage={handleCopyReportImage}
          onReveal={handleRevealReport}
        />
        <ReportInfoPanel report={selectedReport} onReveal={handleRevealReport} />
      </div>
    ) : (
      <div className="report-page">
        <ReportSourceSidebar
          contacts={contacts}
          selectedContact={reportSourceContact}
          selfInfo={selfInfo}
          dbReady={isDatabaseConnected}
          onSelectContact={handleSelectReportSource}
          onOpenSettings={openSettings}
        />
        <AiReportWorkspace
          sourceContact={reportSourceContact}
          summaryDateRange={summaryDateRange}
          summaryMessageTypes={summaryMessageTypes}
          modelConfig={aiModelConfig}
          rangeMessageCount={reportGeneration.rangeMessages.length}
          reportMessageCount={reportGeneration.reportMessages.length}
          messageTypeCounts={reportGeneration.messageTypeCounts}
          rangeState={reportGeneration.rangeState}
          phase={reportGeneration.phase}
          error={reportGeneration.error}
          generatedImage={reportGeneration.generatedImage}
          reportPaths={reportGeneration.reportPaths}
          isGenerating={reportGeneration.isGenerating}
          onSummaryDateRangeChange={setSummaryDateRange}
          onSummaryMessageTypesChange={setSummaryMessageTypes}
          onOpenModelSettings={openModelSettings}
          onGenerate={() => {
            reportGeneration.resetGenerationStatus()
            void reportGeneration.generate()
          }}
          onCloseResult={reportGeneration.closeResult}
          onCopyImage={reportGeneration.copyImage}
          onRevealReport={reportGeneration.revealReport}
          onViewResult={openReportResult}
          hasReportResult={generatedReports.length > 0}
          templateId={reportGeneration.templateId}
          onTemplateIdChange={reportGeneration.setTemplateId}
          memberNamePreference={reportGeneration.memberNamePreference}
          onMemberNamePreferenceChange={reportGeneration.setMemberNamePreference}
          reportTimeoutSeconds={reportGeneration.reportTimeoutSeconds}
          onReportTimeoutSecondsChange={reportGeneration.setReportTimeoutSeconds}
        />
        <ReportTaskStatusPanel
          phase={reportGeneration.phase}
          error={reportGeneration.error}
          onRetry={() => {
            reportGeneration.resetGenerationStatus()
            void reportGeneration.retry()
          }}
        />
      </div>
    )

  const renderCurrentWorkspace = (): React.ReactElement => {
    switch (activePage) {
      case 'archive':
        return renderArchiveWorkspace()
      case 'report':
        return renderReportWorkspace()
      case 'agent-hub':
        return <AgentHubWorkspace />
      case 'api':
        return (
          <ApiWorkspace
            selectedContact={selectedContact}
            dbReady={isDatabaseConnected}
            onOpenSettings={openSettings}
          />
        )
      case 'settings':
        return (
          <SettingsWorkspace
            selectedCategory={settingsCategory}
            onCategoryChange={setSettingsCategory}
            selfInfo={selfInfo}
            dbReady={isDatabaseConnected}
            dbKey={dbKey}
            onDbKeyChange={setDbKey}
            onDatabaseConnectionChange={setIsDatabaseConnected}
            onSelfInfoChange={setSelfInfo}
            onContactsChange={setContacts}
            onFilteredContactsChange={setFilteredContacts}
            onReturnToLogin={handleReturnToLogin}
            onAIRuntimeChange={(config: AIRuntimeModelConfig) => setAiModelConfig(config)}
            onNotice={setReportNotice}
            onOpenSettings={openSettings}
          />
        )
      case 'search':
      case 'export':
        return renderPlaceholderPage(activePage)
    }
  }

  const [sidebarWidth, setSidebarWidth] = useState(300)
  const [isResizing, setIsResizing] = useState(false)
  const sidebarResizeStartRef = React.useRef({ x: 0, width: 300 })

  const startResizing = React.useCallback(
    (mouseDownEvent: React.MouseEvent<HTMLDivElement>) => {
      sidebarResizeStartRef.current = {
        x: mouseDownEvent.clientX,
        width: sidebarWidth
      }
      setIsResizing(true)
    },
    [sidebarWidth]
  )

  const stopResizing = React.useCallback(() => {
    setIsResizing(false)
  }, [])

  const resize = React.useCallback(
    (mouseMoveEvent: MouseEvent) => {
      if (isResizing) {
        const { x, width } = sidebarResizeStartRef.current
        const nextWidth = width + mouseMoveEvent.clientX - x
        setSidebarWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, nextWidth)))
      }
    },
    [isResizing]
  )

  React.useEffect(() => {
    window.addEventListener('mousemove', resize)
    window.addEventListener('mouseup', stopResizing)
    return () => {
      window.removeEventListener('mousemove', resize)
      window.removeEventListener('mouseup', stopResizing)
    }
  }, [resize, stopResizing])

  if (!isAuthenticated && bootState !== 'login') {
    const title =
      startupProgress?.title ||
      (bootState === 'connecting' ? '正在自动连接数据库...' : '正在准备...')
    const subtitle =
      startupProgress?.subtitle ||
      (bootState === 'connecting'
        ? autoConnectSource === 'env'
          ? '检测到环境变量中的密钥'
          : '使用上次安全保存的密钥'
        : 'WechatExplorer')
    return (
      <div className="boot-splash">
        <div className="boot-splash-spinner" aria-hidden />
        <div className="boot-splash-title">{title}</div>
        <div className="boot-splash-subtitle">{subtitle}</div>
        {startupProgress?.detail && (
          <div className="boot-splash-detail">{startupProgress.detail}</div>
        )}
        {typeof startupProgress?.percent === 'number' && (
          <div className="boot-splash-progress" aria-label="加载进度">
            <div
              className="boot-splash-progress-bar"
              style={{ width: `${Math.max(0, Math.min(100, startupProgress.percent))}%` }}
            />
          </div>
        )}
      </div>
    )
  }

  if (!isAuthenticated) {
    return (
      <DatabaseConnectionPage
        platform={window.electron.process.platform}
        mode={databaseConnectionMode}
        dbKey={dbKey}
        dbRoot={dbRootInput}
        showDbKey={showDbKey}
        isFetching={isFetchingDbKey}
        status={dbKeyStatus}
        statusKind={dbKeyStatusKind}
        showMacKeyFaq={showMacKeyFaq}
        macKeyFaqUrl={MAC_KEY_FAQ_URL}
        onModeChange={setDatabaseConnectionMode}
        onDbKeyChange={setDbKey}
        onDbRootChange={setDbRootInput}
        onToggleDbKey={() => setShowDbKey((visible) => !visible)}
        onAutoGetKey={handleAutoGetDbKey}
        onManualConnect={() => handleLogin()}
        onPasteKey={handlePasteAndSaveDbKey}
        onClearKey={handleClearSavedDbKey}
      />
    )
  }

  return (
    <AppShell
      activePage={activePage}
      selfInfo={selfInfo}
      dbReady={isDatabaseConnected}
      onPageChange={handlePageChange}
      onOpenSettings={openSettings}
    >
      {reportNotice && <div className="app-toast">{reportNotice}</div>}
      {renderCurrentWorkspace()}
    </AppShell>
  )
}

export default App
