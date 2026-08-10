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
import { FirstUseWelcome } from './components/FirstUseWelcome'
import { ExportWorkspace } from './components/export/ExportWorkspace'
import { AISearchWorkspace } from './components/search/AISearchWorkspace'
import type { ExportJobProgress, ExportRequest, ExportTaskRecord } from '../../shared/export'
import type { DatabaseKeyEnvironment, WechatAccountCandidate } from '../../shared/database-key'
import {
  getMessageIdentity,
  mergeMessagePages,
  sortMessagesChronologically
} from './utils/message-pages'
import { enrichQuotedMessages } from './utils/quoted-messages'

const SIDEBAR_MIN_WIDTH = 260
const SIDEBAR_MAX_WIDTH = 380
const DATABASE_CONNECT_TIMEOUT_MS = 30_000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      }
    )
  })
}

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

const MAC_KEY_FAQ_URL = 'https://github.com/Wxw-Gu/WechatExplorer/blob/main/docs/mac-disable-sip.md'
const FIRST_USE_WELCOME_SEEN_KEY = 'wxe_first_use_welcome_seen'
const MESSAGE_MONITOR_DEBOUNCE_MS = 8000
const INITIAL_MESSAGE_COUNT = 20
const MESSAGE_PAGE_SIZE = 100
const MESSAGE_PREFETCH_COUNT = INITIAL_MESSAGE_COUNT + MESSAGE_PAGE_SIZE
const EXPORT_PREVIEW_LIMIT = 20
const areMessagesEquivalent = (left: Message[], right: Message[]): boolean => {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (getMessageIdentity(left[index]) !== getMessageIdentity(right[index])) return false
  }
  return true
}

const filterContactList = (list: Contact[], keyword: string): Contact[] => {
  const lower = keyword.trim().toLowerCase()
  if (!lower) return list
  return list.filter((contact) =>
    [contact.m_nsNickName, contact.m_nsUsrName, contact.remark, contact.wechatNickname].some(
      (value) => value?.toLowerCase().includes(lower)
    )
  )
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
  member.groupNickname || member.nickname || member.remark || member.wechatNickname || member.wxid

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

function App(): React.ReactElement {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isDatabaseConnected, setIsDatabaseConnected] = useState(false)
  const [isDatabaseConnecting, setIsDatabaseConnecting] = useState(false)
  const [dbKey, setDbKey] = useState(getDevelopmentDatabaseKey)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [isMessagesLoading, setIsMessagesLoading] = useState(false)
  const [messageHistoryStatus, setMessageHistoryStatus] = useState<'idle' | 'end' | 'error'>('idle')
  const [filteredContacts, setFilteredContacts] = useState<Contact[]>([])
  const [contentFilter, setContentFilter] = useState('')
  const [isFetchingDbKey, setIsFetchingDbKey] = useState(false)
  const [dbKeyStatus, setDbKeyStatus] = useState('')
  const [dbKeyStatusKind, setDbKeyStatusKind] = useState<'normal' | 'success' | 'error'>('normal')
  const [showDbKey, setShowDbKey] = useState(false)
  const [dbRootInput, setDbRootInput] = useState('')
  const [discoveredAccounts, setDiscoveredAccounts] = useState<WechatAccountCandidate[]>([])
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const selectedAccount = discoveredAccounts.find((account) => account.id === selectedAccountId)
  const [showMacKeyFaq, setShowMacKeyFaq] = useState(false)
  const [databaseConnectionMode, setDatabaseConnectionMode] = useState<DatabaseConnectionMode>(
    getDevelopmentDatabaseKey() ? 'manual' : 'automatic'
  )
  const [connectionGuideStep, setConnectionGuideStep] = useState<1 | 2 | 3 | 4 | 5 | 6>(1)
  const [databaseEnvironment, setDatabaseEnvironment] = useState<DatabaseKeyEnvironment>()
  const connectionOperationRef = React.useRef(0)
  const [activePage, setActivePage] = useState<AppPage>('archive')
  const [archiveJumpTime, setArchiveJumpTime] = useState<number | null>(null)
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
  const [exportTasks, setExportTasks] = useState<ExportTaskRecord[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('wxe_export_tasks') || '[]')
      if (!Array.isArray(stored)) return []
      return stored.slice(0, 20).map(
        (
          value: Partial<ExportTaskRecord> & {
            contactId?: string
            contactName?: string
          }
        ) => {
          const targetIds = Array.isArray(value.targetIds)
            ? value.targetIds
            : value.contactId
              ? [value.contactId]
              : []
          const targetNames = Array.isArray(value.targetNames)
            ? value.targetNames
            : value.contactName
              ? [value.contactName]
              : []
          return {
            ...value,
            targetIds,
            targetNames,
            targetLabel: value.targetLabel || targetNames.join('、') || '聊天导出'
          } as ExportTaskRecord
        }
      )
    } catch {
      return []
    }
  })
  const [bootState, setBootState] = useState<'loading' | 'connecting' | 'login'>('loading')
  const [autoConnectSource, setAutoConnectSource] = useState<'env' | 'saved' | null>(null)
  const [startupProgress, setStartupProgress] = useState<StartupProgress | null>(null)
  const [showFirstUseWelcome, setShowFirstUseWelcome] = useState(false)
  const [appearanceSettings, setAppearanceSettings] = React.useState<{
    theme: 'system' | 'light' | 'dark'
    compactMode: boolean
    showStartupProgress: boolean
  }>({ theme: 'system', compactMode: false, showStartupProgress: true })
  const handleAppearanceChange = React.useCallback(
    (settings: { theme: 'system' | 'light' | 'dark'; compactMode: boolean }) => {
      setAppearanceSettings((current) => ({ ...current, ...settings }))
    },
    []
  )
  const currentGroupSnapshotRef = React.useRef<GroupSnapshot | null>(null)
  const syntheticGroupMessagesRef = React.useRef<Record<string, Message[]>>({})
  const groupMemberMetaRef = React.useRef<Record<string, Map<string, GroupMemberMeta>>>({})
  const messageHistoryRef = React.useRef<Message[]>([])
  const messagesRef = React.useRef<Message[]>([])
  const messagePrefetchRef = React.useRef<Promise<void> | null>(null)
  messagesRef.current = messages
  React.useEffect(() => {
    if (!reportNotice) return
    const timer = window.setTimeout(() => setReportNotice(''), 3200)
    return () => window.clearTimeout(timer)
  }, [reportNotice])
  React.useEffect(() => {
    const openVoiceRecognitionSettings = (): void => {
      setSettingsCategory('voice-recognition')
      setActivePage('settings')
    }
    window.addEventListener('wxe:open-voice-recognition-settings', openVoiceRecognitionSettings)
    return () =>
      window.removeEventListener(
        'wxe:open-voice-recognition-settings',
        openVoiceRecognitionSettings
      )
  }, [])
  React.useEffect(() => {
    void window.api.getSettings().then((result) => {
      setAppearanceSettings({
        theme: result.settings.appearanceTheme,
        compactMode: result.settings.compactMode,
        showStartupProgress: result.settings.showStartupProgress
      })
    })
  }, [])

  const refreshConnectionEnvironment = React.useCallback(async (): Promise<void> => {
    const root = dbRootInput.trim()
    try {
      if (root) {
        const discovery = await window.api.discoverAccounts(root)
        if (!discovery.success) throw new Error(discovery.error || '账号目录识别失败')
        setDiscoveredAccounts(discovery.accounts)
        setSelectedAccountId(discovery.preselectedAccountId || '')
      }
      const environment = await window.api.getDatabaseKeyEnvironment()
      setDatabaseEnvironment(environment)
      setDbKeyStatus('环境检查已更新')
      setDbKeyStatusKind('normal')
    } catch (error) {
      setDbKeyStatus(
        error instanceof Error ? `环境检查失败：${error.message}` : '环境检查失败，请重试'
      )
      setDbKeyStatusKind('error')
    }
  }, [dbRootInput])

  React.useEffect(() => {
    void window.api
      .getDatabaseKeyEnvironment()
      .then(setDatabaseEnvironment)
      .catch(() => undefined)
  }, [])
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

  React.useEffect(() => {
    const unsubscribe = window.api.onExportProgress((progress: ExportJobProgress) => {
      setExportTasks((current) =>
        current.map((task) => {
          if (task.jobId !== progress.jobId) return task
          const status =
            progress.phase === 'completed'
              ? 'completed'
              : progress.phase === 'cancelled'
                ? 'cancelled'
                : progress.phase === 'failed'
                  ? 'failed'
                  : 'running'
          return { ...task, status, progress }
        })
      )
    })
    return unsubscribe
  }, [])

  React.useEffect(() => {
    localStorage.setItem('wxe_export_tasks', JSON.stringify(exportTasks.slice(0, 20)))
  }, [exportTasks])

  const handleStartExport = async (
    request: ExportRequest
  ): Promise<import('../../shared/export').ExportResult> => {
    const exportAll = request.scope === 'all'
    const targetCount = request.targets.length
    const targetNames = exportAll ? [] : request.targets.map((target) => target.name)
    const targetLabel = exportAll
      ? `全部 ${targetCount} 个聊天`
      : targetNames.length > 1
        ? `${targetNames[0]} 等 ${targetNames.length} 个聊天`
        : targetNames[0]
    const task: ExportTaskRecord = {
      jobId: request.jobId,
      scope: request.scope,
      allContactTypes: request.allContactTypes,
      targetIds: exportAll ? [] : request.targets.map((target) => target.userMd5),
      targetNames,
      targetLabel,
      format: request.format,
      includeVoiceTranscripts: request.includeVoiceTranscripts,
      zip: request.zip,
      status: 'running',
      progress: { jobId: request.jobId, phase: 'reading', processed: 0, percent: 0 },
      createdAt: Date.now()
    }
    setExportTasks((current) =>
      [task, ...current.filter((item) => item.jobId !== task.jobId)].slice(0, 20)
    )
    const result = await window.api.startExport(request)
    setExportTasks((current) =>
      current.map((item) =>
        item.jobId === request.jobId
          ? result.success
            ? {
                ...item,
                status: 'completed',
                progress: {
                  ...item.progress,
                  phase: 'completed',
                  processed: result.messageCount ?? item.progress.processed,
                  total: result.messageCount ?? item.progress.total,
                  percent: 100,
                  outputPath: result.outputPath
                }
              }
            : {
                ...item,
                status: 'failed',
                progress: { ...item.progress, phase: 'failed', error: result.error }
              }
          : item
      )
    )
    return result
  }

  const handleCancelExport = async (jobId: string): Promise<void> => {
    await window.api.cancelExport(jobId)
    setExportTasks((current) =>
      current.map((task) =>
        task.jobId === jobId
          ? { ...task, status: 'cancelled', progress: { ...task.progress, phase: 'cancelled' } }
          : task
      )
    )
  }

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
    filterKeyword?: string
  }): Promise<void> => {
    options?.onProgress?.('正在加载联系人...', 35)
    const list = await window.api.getContacts()
    setContacts(list)
    setFilteredContacts(filterContactList(list, options?.filterKeyword || ''))
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
    const chunkSize = 128
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
      await new Promise((resolve) => window.setTimeout(resolve, 20))
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
      const discovery = settingsResult.settings.dbRoot
        ? await window.api.discoverAccounts(settingsResult.settings.dbRoot)
        : { success: false, accounts: [] }
      if (active && discovery.success) {
        setDiscoveredAccounts(discovery.accounts)
        setSelectedAccountId(discovery.preselectedAccountId || '')
      }
      const startupAccountRoot = discovery.success
        ? discovery.accounts.find((account) => account.id === discovery.preselectedAccountId)
            ?.accountRoot
        : undefined
      const autoLoginEnabled = settingsResult.settings.autoLogin
      // 开发环境允许使用 VITE_DB_KEY；生产安装包只能读取目标电脑自己的 safeStorage。
      const envKey = getDevelopmentDatabaseKey()
      // 生产环境以及未配置开发密钥时，读取上一次保存到 safeStorage 的密钥。
      let savedKey = ''
      if (!envKey) {
        const result = startupAccountRoot
          ? await window.api.getSavedDbKey(startupAccountRoot)
          : { success: true, saved: false, encryptionAvailable: true }
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
        const startupCacheReady = await loadStartupCache()
        setIsDatabaseConnecting(true)
        if (!startupAccountRoot) {
          setBootState('login')
          return
        }
        const initPromise = window.api.initDb(key, startupAccountRoot)
        if (startupCacheReady) {
          setIsAuthenticated(true)
          setIsDatabaseConnected(false)
          setBootState('login')
          void initPromise
            .then(async (result) => {
              const success = typeof result === 'boolean' ? result : result.success
              if (!success) {
                const error = typeof result === 'boolean' ? '' : result.error
                setDbKeyStatus(`后台连接失败${error ? `: ${error}` : ''}`)
                setDbKeyStatusKind('error')
                return
              }
              setIsNativeMonitorActive(typeof result !== 'boolean' && result.monitoring === true)
              setIsDatabaseConnected(true)
              setDbKeyStatus('已连接数据库')
              // The cached list paints first. Refresh lightweight session flags and
              // missing avatars after the database is connected.
              void loadContacts({ waitForAvatars: false })
                .then(() => refreshSelfInfo(3))
                .catch((error) => {
                  console.warn('[Startup] background contact refresh failed:', error)
                })
            })
            .catch((error) => {
              console.warn('[Startup] background database init failed:', error)
              setDbKeyStatusKind('error')
            })
            .finally(() => {
              if (active) setIsDatabaseConnecting(false)
            })
          return
        }
        const result = await initPromise
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
          const hasBootstrap = await loadBootstrapCache()
          if (hasBootstrap) {
            setIsAuthenticated(true)
          } else {
            await loadContacts()
            await refreshSelfInfo(3)
            setIsAuthenticated(true)
          }
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
      } finally {
        if (active) setIsDatabaseConnecting(false)
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

  const handleLogin = async (keyInput?: string, accountRootInput?: string): Promise<void> => {
    const keyToUse = keyInput || dbKey
    let accountRoot = accountRootInput || selectedAccount?.accountRoot
    if (!keyToUse || isDatabaseConnecting) return
    if (!accountRoot) {
      const discovery = await window.api.discoverAccounts(dbRootInput.trim())
      if (!discovery.success) {
        setDbKeyStatus(discovery.error || '微信数据目录不可用')
        setDbKeyStatusKind('error')
        return
      }
      if (!discovery.preselectedAccountId) {
        setDiscoveredAccounts(discovery.accounts)
        setDbKeyStatus('请选择要连接的微信账号')
        setDbKeyStatusKind('error')
        return
      }
      const account = discovery.accounts.find(
        (candidate) => candidate.id === discovery.preselectedAccountId
      )
      if (!account) return
      setDiscoveredAccounts(discovery.accounts)
      setSelectedAccountId(account.id)
      accountRoot = account.accountRoot
    }
    const operationId = ++connectionOperationRef.current
    if (databaseConnectionMode === 'automatic') setConnectionGuideStep(6)
    setIsDatabaseConnecting(true)
    // 持久化用户手动指定的微信聊天文件路径，供 db:init 读取 settings.dbRoot
    const trimmedRoot = accountRoot
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
      const result = await withTimeout(
        window.api.initDb(keyToUse, trimmedRoot),
        DATABASE_CONNECT_TIMEOUT_MS,
        '数据库连接超时，请检查数据目录后重试'
      )
      if (operationId !== connectionOperationRef.current) return
      const success = typeof result === 'boolean' ? result : result.success
      if (success) {
        setIsNativeMonitorActive(typeof result !== 'boolean' && result.monitoring === true)
        setStartupProgress({
          title: '正在读取缓存...',
          subtitle: '正在恢复上次联系人和头像',
          detail: '正在读取本地缓存',
          percent: 25
        })
        const hasBootstrap = await loadBootstrapCache()
        if (operationId !== connectionOperationRef.current) return
        // 持久化手动输入的密钥，供下次启动继续使用
        void window.api.saveDbKey(trimmedRoot, keyToUse).catch(() => undefined)
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
        if (hasBootstrap) {
          // Cached contacts are sufficient for the first paint. Refresh native data in the background.
          setIsAuthenticated(true)
          void loadContacts({ waitForAvatars: false })
            .then(() => refreshSelfInfo(3))
            .catch((error) => {
              console.warn('[Startup] background refresh failed:', error)
            })
        } else {
          await loadContacts({ waitForAvatars: false })
          await refreshSelfInfo(3)
          setIsAuthenticated(true)
        }
        setStartupProgress({
          title: '加载完成',
          subtitle: '正在进入主页面',
          detail: '联系人和头像已准备好',
          percent: 100
        })
        setIsDatabaseConnected(true)
        setBootState('login')
        maybeShowFirstUseWelcome()
        window.setTimeout(() => {
          setStartupProgress(null)
        }, 500)
      } else {
        const error = typeof result === 'boolean' ? '' : result.error
        setDbKeyStatus(error || '数据库连接失败，请检查密钥和数据目录后重试')
        setDbKeyStatusKind('error')
        if (databaseConnectionMode === 'automatic') setConnectionGuideStep(5)
        setBootState('login')
        setStartupProgress(null)
      }
    } catch (error) {
      console.error(error)
      setDbKeyStatus(
        error instanceof Error ? `数据库连接失败：${error.message}` : '数据库连接失败，请重试'
      )
      setDbKeyStatusKind('error')
      if (databaseConnectionMode === 'automatic') setConnectionGuideStep(5)
      setBootState('login')
      setStartupProgress(null)
    } finally {
      if (operationId === connectionOperationRef.current) setIsDatabaseConnecting(false)
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
      const enrichedMessages = enrichQuotedMessages(
        baseMessages,
        [...messageHistoryRef.current, ...baseMessages],
        (senderId) => memberMap?.get(senderId)?.nickname
      )
      if (!memberMap || memberMap.size === 0) return enrichedMessages

      return enrichedMessages.map((message) => {
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

  const storeGroupMemberMeta = React.useCallback(
    (contact: Contact, snapshot: GroupSnapshot): void => {
      currentGroupSnapshotRef.current = snapshot
      groupMemberMetaRef.current[contact.md5] = new Map(
        snapshot.members.map((member) => [
          member.wxid,
          { nickname: formatGroupMemberName(member), avatar: member.avatar || '' }
        ])
      )
    },
    []
  )

  const loadGroupMemberMeta = React.useCallback(
    async (contact: Contact | null): Promise<GroupSnapshot | null> => {
      if (!contact || contact.type !== 'group') return null
      const snapshot = await logGroupSnapshot(contact, 'load-member-meta')
      if (!snapshot) return null
      storeGroupMemberMeta(contact, snapshot)
      return snapshot
    },
    [logGroupSnapshot, storeGroupMemberMeta]
  )

  const handleReloadCurrentAvatars = React.useCallback(async (): Promise<void> => {
    const contact = selectedContact
    if (!contact) return

    try {
      const avatars = await window.api.getContactAvatars([contact.m_nsUsrName])
      const avatar = avatars[contact.m_nsUsrName]
      if (avatar) {
        const updateContact = (item: Contact): Contact =>
          item.md5 === contact.md5 ? { ...item, avatar } : item
        setContacts((current) => current.map(updateContact))
        setFilteredContacts((current) => current.map(updateContact))
        setSelectedContact((current) =>
          current?.md5 === contact.md5 ? updateContact(current) : current
        )
      }
    } catch (error) {
      console.warn('[Contacts] current avatar reload failed:', error)
    }

    const snapshot = await loadGroupMemberMeta(contact)
    if (!snapshot || selectedContactMd5Ref.current !== contact.md5) return
    setMessages((current) =>
      applyGroupMemberMeta(contact, mergeSyntheticMessages(contact, current, snapshot.roomId))
    )
  }, [applyGroupMemberMeta, loadGroupMemberMeta, mergeSyntheticMessages, selectedContact])

  const handleAutoGetDbKey = async (): Promise<void> => {
    if (isFetchingDbKey) return
    const operationId = ++connectionOperationRef.current
    setConnectionGuideStep(4)
    setIsFetchingDbKey(true)
    setDbKeyStatus('正在准备获取密钥...')
    setDbKeyStatusKind('normal')
    setShowMacKeyFaq(false)
    try {
      if (!selectedAccount) throw new Error('请先选择微信账号')
      const result = await window.api.autoGetDbKey(selectedAccount.accountRoot)
      if (operationId !== connectionOperationRef.current) return
      if (!result.success || !result.key) {
        setShowMacKeyFaq(result.code === 'SCAN_FAILED')
        throw new Error(result.error || '获取密钥失败')
      }
      setDbKey(result.key)
      setConnectionGuideStep(5)
      setDbKeyStatus(result.saved ? '密钥已获取并安全保存' : result.warning || '密钥已获取')
      setDbKeyStatusKind(result.saved ? 'success' : 'normal')
    } catch (error) {
      if (operationId !== connectionOperationRef.current) return
      setDbKeyStatus(error instanceof Error ? error.message : String(error))
      setDbKeyStatusKind('error')
      setConnectionGuideStep(3)
    } finally {
      if (operationId === connectionOperationRef.current) setIsFetchingDbKey(false)
    }
  }

  const handlePasteAndSaveDbKey = async (): Promise<void> => {
    setShowMacKeyFaq(false)
    if (!selectedAccount) {
      setDbKeyStatus('请先选择微信账号')
      setDbKeyStatusKind('error')
      return
    }
    const result = await window.api.pasteAndSaveDbKey(selectedAccount.accountRoot)
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
    if (!selectedAccount) return
    const result = await window.api.clearSavedDbKey(selectedAccount.accountRoot)
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
    setIsDatabaseConnecting(false)
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

  const handleSwitchAccount = async (account: WechatAccountCandidate): Promise<void> => {
    connectionOperationRef.current += 1
    await window.api.disconnectDb({ closeNative: true })
    setIsAuthenticated(false)
    setIsDatabaseConnected(false)
    setSelectedContact(null)
    setMessages([])
    setContacts([])
    setFilteredContacts([])
    setContentFilter('')
    setSelfInfo(null)
    setReportSourceContact(null)
    setExportTasks([])
    messageHistoryRef.current = []
    messagesRef.current = []
    selectedContactMd5Ref.current = ''
    currentGroupSnapshotRef.current = null
    groupMemberMetaRef.current = {}
    syntheticGroupMessagesRef.current = {}
    setDiscoveredAccounts((current) =>
      current.some((item) => item.id === account.id) ? current : [account]
    )
    setSelectedAccountId(account.id)
    setDbRootInput(account.accountRoot)
    await window.api.setSettings({ dbRoot: account.accountRoot, imageKeyRoot: account.accountRoot })
    const saved = await window.api.getSavedDbKey(account.accountRoot)
    if (!saved.success || !saved.key) {
      setDbKey('')
      setDatabaseConnectionMode('automatic')
      setBootState('login')
      setConnectionGuideStep(3)
      setDbKeyStatus('该账号尚无可用密钥，请为所选账号获取密钥')
      setDbKeyStatusKind('normal')
      return
    }
    setDbKey(saved.key)
    setDatabaseConnectionMode('manual')
    setBootState('login')
    await handleLogin(saved.key, account.accountRoot)
  }

  const handleSelectContact = async (contact: Contact, forceLive = false): Promise<void> => {
    setArchiveJumpTime(null)
    setSelectedContact(contact)
    selectedContactMd5Ref.current = contact.md5
    currentGroupSnapshotRef.current = null
    setIsMessagesLoading(true)
    setMessageHistoryStatus('idle')
    const cachedPage = await window.api.getCachedMessagePage(contact.md5)
    const cachedMsgs = cachedPage.messages
    if (selectedContactMd5Ref.current !== contact.md5) return
    if (cachedPage.groupSnapshot) {
      storeGroupMemberMeta(contact, cachedPage.groupSnapshot)
    }
    messageHistoryRef.current = cachedMsgs
    setMessages(
      applyGroupMemberMeta(
        contact,
        mergeSyntheticMessages(contact, cachedMsgs.slice(-INITIAL_MESSAGE_COUNT))
      )
    )
    const needsLivePage = forceLive || isDatabaseConnected
    if (!needsLivePage) {
      setIsMessagesLoading(false)
      if (contact.type === 'group' && cachedMsgs.length > 0 && !cachedPage.groupSnapshot) {
        window.setTimeout(() => {
          void loadGroupMemberMeta(contact).then((snapshot) => {
            if (!snapshot || selectedContactMd5Ref.current !== contact.md5) return
            setMessages((current) =>
              applyGroupMemberMeta(
                contact,
                mergeSyntheticMessages(contact, current, snapshot.roomId)
              )
            )
          })
        }, 0)
      }
      return
    }
    if (cachedMsgs.length >= INITIAL_MESSAGE_COUNT) setIsMessagesLoading(false)
    await waitForPaint()
    const loadLivePage = async (): Promise<void> => {
      const msgs = await window.api.getMessages(contact.md5, undefined, undefined, {
        limit: MESSAGE_PREFETCH_COUNT
      })
      if (selectedContactMd5Ref.current !== contact.md5) return
      messageHistoryRef.current = msgs
      const visibleMessages = applyGroupMemberMeta(
        contact,
        mergeSyntheticMessages(contact, msgs.slice(-INITIAL_MESSAGE_COUNT))
      )
      setMessages(visibleMessages)
      if (contact.type === 'group' && visibleMessages.length > 0) {
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
    }
    const prefetchPromise = loadLivePage()
    messagePrefetchRef.current = prefetchPromise
    try {
      await prefetchPromise
    } finally {
      if (messagePrefetchRef.current === prefetchPromise) messagePrefetchRef.current = null
      if (selectedContactMd5Ref.current === contact.md5) setIsMessagesLoading(false)
    }
  }

  const handleOpenSearchEvidence = async (contact: Contact, createTime?: number): Promise<void> => {
    setActivePage('archive')
    await handleSelectContact(contact)
    if (!createTime || selectedContactMd5Ref.current !== contact.md5) return

    try {
      const windowStart = Math.max(0, createTime - 12 * 3600)
      const windowEnd = createTime + 12 * 3600
      const nearbyMessages = await window.api.getMessages(contact.md5, windowStart, windowEnd)
      if (selectedContactMd5Ref.current !== contact.md5) return
      const focusedMessages = sortMessagesChronologically(nearbyMessages)
      messageHistoryRef.current = focusedMessages
      setMessages(applyGroupMemberMeta(contact, mergeSyntheticMessages(contact, focusedMessages)))
      setArchiveJumpTime(createTime)
    } catch (error) {
      console.warn('[Search] evidence context load failed:', error)
      setReportNotice('证据所在时间段加载失败，请在档案中手动查看')
    }
  }

  React.useEffect(() => {
    if (!isDatabaseConnected || !selectedContact) return
    void handleSelectContact(selectedContact)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDatabaseConnected])

  const loadStartupCache = async (): Promise<boolean> => {
    try {
      const cache = await window.api.getStartupCache()
      if (!cache?.contacts.length) return false
      setContacts(cache.contacts)
      setFilteredContacts(cache.contacts)
      if (cache.self) setSelfInfo(cache.self)
      return true
    } catch (error) {
      console.warn('[StartupCache] load failed:', error)
      return false
    }
  }

  const handleLoadOlderMessages = async (): Promise<void> => {
    const contact = selectedContact
    if (!contact || messagesRef.current.length === 0 || messageHistoryStatus === 'end') return
    if (messagePrefetchRef.current) await messagePrefetchRef.current
    if (selectedContactMd5Ref.current !== contact.md5) return
    const currentMessages = messagesRef.current
    const historyMessages = messageHistoryRef.current
    const firstVisibleIndex = historyMessages.findIndex(
      (message) => getMessageIdentity(message) === getMessageIdentity(currentMessages[0])
    )
    if (firstVisibleIndex > 0) {
      const inMemoryOlder = historyMessages.slice(
        Math.max(0, firstVisibleIndex - MESSAGE_PAGE_SIZE),
        firstVisibleIndex
      )
      setMessages((current) =>
        applyGroupMemberMeta(
          contact,
          mergeSyntheticMessages(contact, mergeMessagePages(inMemoryOlder, current))
        )
      )
      return
    }
    const oldestTime = currentMessages[0]?.createTime
    if (!oldestTime) return

    setIsMessagesLoading(true)
    try {
      const cachedPage = await window.api.getCachedMessagePage(
        contact.md5,
        undefined,
        oldestTime - 1
      )
      const olderMessages = cachedPage.hit
        ? cachedPage.messages
        : await window.api.getMessages(contact.md5, undefined, oldestTime - 1, {
            limit: MESSAGE_PAGE_SIZE
          })
      if (selectedContactMd5Ref.current !== contact.md5) return
      setMessageHistoryStatus(olderMessages.length === 0 ? 'end' : 'idle')
      messageHistoryRef.current = mergeMessagePages(olderMessages, historyMessages)
      setMessages((current) =>
        applyGroupMemberMeta(
          contact,
          mergeSyntheticMessages(contact, mergeMessagePages(olderMessages, current))
        )
      )
    } catch (error) {
      console.warn('[Messages] older page load failed:', error)
      if (selectedContactMd5Ref.current === contact.md5) setMessageHistoryStatus('error')
    } finally {
      if (selectedContactMd5Ref.current === contact.md5) setIsMessagesLoading(false)
    }
  }

  const loadExportPreviewMessages = async (contact: Contact): Promise<Message[]> => {
    try {
      return await window.api.getMessages(contact.md5, undefined, undefined, {
        limit: EXPORT_PREVIEW_LIMIT
      })
    } catch (error) {
      console.warn('[Export] preview load failed:', error)
      return []
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
        const latestMessages = await window.api.getMessages(contactMd5, undefined, undefined, {
          limit: INITIAL_MESSAGE_COUNT
        })
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

    const unsubscribe = window.api.onWcdbChange(({ json }) => {
      const eventText = String(json || '').toLowerCase()
      const targetIds = [contactMd5, selectedContact.m_nsUsrName]
        .filter(Boolean)
        .map((value) => value.toLowerCase())
      if (!targetIds.some((targetId) => eventText.includes(targetId))) return
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
    isAuthenticated,
    isNativeMonitorActive,
    selectedContact,
    logGroupSnapshot,
    applyGroupMemberMeta,
    mergeSyntheticMessages
  ])

  const handleSearchContacts = (keyword: string): void => {
    setFilteredContacts(filterContactList(contacts, keyword))
  }

  const handleRefreshContacts = async (filterKeyword: string): Promise<void> => {
    try {
      await loadContacts({ waitForAvatars: false, filterKeyword })
      setReportNotice('会话列表已刷新')
    } catch (error) {
      console.warn('[Contacts] refresh failed:', error)
      setReportNotice('会话列表刷新失败，请稍后重试')
    }
  }

  const isGroupContact = (contact: Contact | null): boolean =>
    Boolean(contact?.type === 'group' || contact?.m_nsUsrName?.endsWith('@chatroom'))

  const handlePageChange = (page: AppPage): void => {
    setActivePage(page)
    if (page === 'archive' && selectedContact) void handleSelectContact(selectedContact)
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

  const dismissFirstUseWelcome = (): void => {
    try {
      localStorage.setItem(FIRST_USE_WELCOME_SEEN_KEY, '1')
    } catch {
      // The welcome prompt is optional and should not interrupt normal use.
    }
    setShowFirstUseWelcome(false)
  }

  const maybeShowFirstUseWelcome = (): void => {
    try {
      if (localStorage.getItem(FIRST_USE_WELCOME_SEEN_KEY) === '1') return
    } catch {
      // If localStorage is unavailable, still show the one-time prompt for this session.
    }
    setShowFirstUseWelcome(true)
  }

  const openFirstUseSearch = (): void => {
    dismissFirstUseWelcome()
    setActivePage('search')
  }

  const openFirstUseReport = (): void => {
    dismissFirstUseWelcome()
    setReportWorkspaceView('configure')
    setSelectedReportId(null)
    setActivePage('report')
  }

  const openFirstUseAISettings = (): void => {
    dismissFirstUseWelcome()
    openModelSettings()
  }

  const openFirstUseGuide = (): void => {
    setShowFirstUseWelcome(true)
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

  const renderArchiveWorkspace = (): React.ReactElement => (
    <div className="app-container">
      <Sidebar
        contacts={filteredContacts}
        selectedContact={selectedContact}
        onSelectContact={handleSelectContact}
        onSearch={handleSearchContacts}
        onContentFilter={setContentFilter}
        width={sidebarWidth}
        selfInfo={selfInfo}
        dbReady={isDatabaseConnected}
        dbConnecting={isDatabaseConnecting}
        onOpenSettings={openSettings}
        onRefresh={handleRefreshContacts}
      />
      <div className="resizer" onMouseDown={startResizing} />
      <ChatWindow
        key={selectedContact?.md5}
        contact={selectedContact}
        messages={messages}
        isLoadingMessages={isMessagesLoading}
        messageHistoryStatus={messageHistoryStatus}
        contentFilter={contentFilter}
        onContentFilterChange={setContentFilter}
        onRefresh={() => selectedContact && handleSelectContact(selectedContact, true)}
        onRefreshData={loadContacts}
        onReloadAvatars={handleReloadCurrentAvatars}
        onLoadOlderMessages={handleLoadOlderMessages}
        onCreateGroupReport={handleOpenReportWorkspace}
        isAiLoading={reportGeneration.isGenerating}
        jumpToTime={archiveJumpTime}
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
          dbConnecting={isDatabaseConnecting}
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
          dbConnecting={isDatabaseConnecting}
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
          voiceTranscriptionProgress={reportGeneration.voiceTranscriptionProgress}
          voiceTranscriptionEnabled={summaryMessageTypes.includes('voice')}
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
            dbConnecting={isDatabaseConnecting}
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
            onAppearanceChange={handleAppearanceChange}
            onSwitchAccount={handleSwitchAccount}
          />
        )
      case 'search':
        return (
          <AISearchWorkspace
            contacts={contacts}
            selectedContact={selectedContact}
            dbReady={isDatabaseConnected}
            aiModelConfig={aiModelConfig}
            onSelectContact={(contact) => void handleSelectContact(contact)}
            onOpenEvidence={(contact, createTime) =>
              void handleOpenSearchEvidence(contact, createTime)
            }
            onOpenAISettings={openModelSettings}
            onNotice={setReportNotice}
          />
        )
      case 'export':
        return (
          <ExportWorkspace
            contacts={contacts}
            initialContact={selectedContact}
            selfInfo={selfInfo}
            dbReady={isDatabaseConnected}
            loadPreviewMessages={loadExportPreviewMessages}
            onOpenSettings={openSettings}
            exportTasks={exportTasks}
            onStartExport={handleStartExport}
            onCancelExport={handleCancelExport}
          />
        )
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
      <div className={`boot-splash ${appearanceSettings.showStartupProgress ? '' : 'is-quiet'}`}>
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
        isConnecting={isDatabaseConnecting}
        guideStep={connectionGuideStep}
        environment={databaseEnvironment}
        accounts={discoveredAccounts}
        selectedAccountId={selectedAccountId}
        status={dbKeyStatus}
        statusKind={dbKeyStatusKind}
        showMacKeyFaq={showMacKeyFaq}
        macKeyFaqUrl={MAC_KEY_FAQ_URL}
        onModeChange={setDatabaseConnectionMode}
        onDbKeyChange={setDbKey}
        onDbRootChange={(value) => {
          setDbRootInput(value)
          setDiscoveredAccounts([])
          setSelectedAccountId('')
        }}
        onSelectAccount={(account) => {
          setSelectedAccountId(account.id)
          setDbKey('')
          void window.api.getSavedDbKey(account.accountRoot).then((result) => {
            if (result.success && result.key) setDbKey(result.key)
          })
        }}
        onSelectDbRoot={() => {
          void window.api.selectDbRoot().then((result) => {
            if (!result.canceled && result.path) {
              setDbRootInput(result.path)
              void window.api.discoverAccounts(result.path).then((discovery) => {
                if (!discovery.success) {
                  setDiscoveredAccounts([])
                  setSelectedAccountId('')
                  setDbKeyStatus(discovery.error || '账号目录识别失败')
                  setDbKeyStatusKind('error')
                  return
                }
                setDiscoveredAccounts(discovery.accounts)
                setSelectedAccountId(discovery.preselectedAccountId || '')
              })
            }
          })
        }}
        onToggleDbKey={() => setShowDbKey((visible) => !visible)}
        onAutoGetKey={handleAutoGetDbKey}
        onRefreshEnvironment={() => void refreshConnectionEnvironment()}
        onGuideNext={() =>
          setConnectionGuideStep((current) => (current === 1 ? 2 : current === 2 ? 3 : current))
        }
        onGuideBack={() =>
          setConnectionGuideStep((current) =>
            current === 5 ? 3 : current > 1 ? ((current - 1) as 1 | 2 | 3 | 4 | 5 | 6) : 1
          )
        }
        onGuideCancel={() => {
          connectionOperationRef.current += 1
          setIsFetchingDbKey(false)
          setIsDatabaseConnecting(false)
          setBootState('login')
          setStartupProgress(null)
          setConnectionGuideStep(1)
          setDbKeyStatus('已取消，可以重新检查环境')
          setDbKeyStatusKind('normal')
        }}
        onValidateConnection={() => void handleLogin()}
        onCopyDiagnostics={() => {
          if (!databaseEnvironment?.diagnosticSummary) {
            setDbKeyStatus('诊断信息尚未准备好，请先重新检查环境')
            setDbKeyStatusKind('error')
            return
          }
          void window.api.copyText(databaseEnvironment.diagnosticSummary).then(() => {
            setDbKeyStatus('脱敏诊断摘要已复制')
            setDbKeyStatusKind('success')
          })
        }}
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
      dbConnecting={isDatabaseConnecting}
      onPageChange={handlePageChange}
      onOpenSettings={openSettings}
      onOpenGuide={openFirstUseGuide}
      appearanceTheme={appearanceSettings.theme}
      compactMode={appearanceSettings.compactMode}
    >
      {reportNotice && <div className="app-toast">{reportNotice}</div>}
      {showFirstUseWelcome && (
        <FirstUseWelcome
          onDismiss={dismissFirstUseWelcome}
          onOpenSearch={openFirstUseSearch}
          onOpenReport={openFirstUseReport}
          onOpenAISettings={openFirstUseAISettings}
        />
      )}
      {renderCurrentWorkspace()}
    </AppShell>
  )
}

export default App
