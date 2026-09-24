import {
  isLegacyMigrationHelper,
  isUserDataIsolated,
  roots as appDataRoots
} from './app-data-bootstrap'
import './preload-env'
import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  nativeImage,
  clipboard,
  Menu,
  Tray,
  dialog,
  protocol
} from 'electron'
import { dirname, extname, join } from 'path'
import { existsSync, promises as fsPromises } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { WechatDb } from './wechat-db'
import { bootstrapWcdbNativeAsync, Wcdb4Client } from './wcdb4-client'
import { VoiceService } from './voice-service'
import { StickerService } from './sticker-service'
import { parseMessageContent } from './message-parser'
import {
  ImageDecryptService,
  inspectImageDecoderExecutable,
  inspectImageDecoderStatus,
  resolveFfmpegExecutable,
  type DecodedImage
} from './image-decrypt-service'
import { exportGroupReportSnapshot, extractGroupReportRenderSnapshot } from './group-report-service'
import {
  deleteGeneratedReport,
  listGeneratedReports,
  prepareGeneratedReportTemplateSwitch,
  saveGeneratedReport,
  updateGeneratedReportTemplate
} from './report-history-service'
import { reportTemplateService } from './report-template-service'
import { registerReportTemplateIpc } from './report-template-ipc'
import type { GroupReportRenderSnapshotExportRequest } from '../shared/group-report'
import type {
  SaveGeneratedReportRequest,
  PrepareGeneratedReportTemplateSwitchRequest,
  UpdateGeneratedReportTemplateRequest
} from '../shared/report-history'
import type {
  AIChatRequestOptions,
  AiSearchExternalAuthorizationRequest,
  AIProviderConfig,
  AIVisionTestRequest,
  LegacyAIConfig
} from '../shared/ai-provider'
import { DatabaseKeyStore } from './database-key-store'
import { apiTokenStore } from './api-token-store'
import { ImageKeyConfigService } from './services/image-key-config-service'
import { AIProviderService } from './services/ai-provider-service'
import { imageInsightService } from './services/image-insight-service'
import { systemOcrService } from './services/system-ocr-service'
import type {
  ImageAnalysisRequest,
  ImageAnalysisResponse,
  ImageCandidate,
  ImageCandidateQuery,
  ImageInsight
} from '../shared/image-insight'
import type { SystemOcrCapability, SystemOcrRequest, SystemOcrResult } from '../shared/system-ocr'
import { KeyServiceMac } from './key-service-mac'
import { KeyService as KeyServiceWin } from './key-service-win'
import * as chat from './services/chat-service'
import { apiServer, setLocalQueryApiService } from './http-server'
import { skillResourceService } from './services/skill-resource-service'
import { buildLocalApiCurlCommand, testLocalApiRequest } from './services/local-api-test-service'
import { isWechatRunning } from './services/wechat-process-status'
import {
  inspectImageDecryptionStatus,
  testImageDecryption
} from './services/image-decryption-status-service'
import type { SaveImageKeyRequest, TestImageDecryptionRequest } from '../shared/image-decryption'
import {
  loadSettings,
  saveSettings,
  getSettingsPath,
  AppSettings,
  validateDbRoot
} from './services/settings-store'
import {
  detectDataStructureVersion,
  detectWechatVersion,
  getOsVersionLabel
} from './services/connection-diagnostics'
import { buildSafeDiagnosticSummary } from '../shared/connection-diagnostics'
import {
  flushBootstrapCacheWritesSync,
  getBootstrapCache,
  getCachedMessagePage,
  getCachedMessages,
  mergeBootstrapAvatars,
  mergeCachedContactAvatars,
  mergeCachedSelfInfo,
  saveBootstrapContacts,
  saveBootstrapSelf,
  saveCachedGroupSnapshot,
  saveCachedMessages
} from './services/bootstrap-cache'
import { installSafeConsole } from './safe-log'
import { agentHubService } from './services/agent-hub-service'
import { WechatConnectorService } from './services/wechat-ilink'
import { wechatSendGateway } from './services/wechat-send-gateway'
import { groupExitMonitorService } from './services/group-exit-monitor-service'
import { wechatActionLogService } from './services/wechat-action-log-service'
import { wechatActionGateway } from './services/wechat-action-gateway'
import { personalWechatSendService } from './services/personal-wechat-send-service'
import { getPersonalWechatSendCapability } from './services/personal-wechat-capability-service'
import { scheduledReportService } from './services/scheduled-report-service'
import { PersonalWechatRuntimeManager } from './services/personal-wechat-runtime-manager'
import { personalWechatVoiceEnvironmentService } from './services/personal-wechat-voice-environment-service'
import type {
  PersonalWechatGeneratedTtsVoiceRequest,
  PersonalWechatSendRequest,
  PersonalWechatSendResult
} from '../shared/personal-wechat'
import type {
  ScheduledReportCreateInput,
  ScheduledReportUpdateInput
} from '../shared/scheduled-report'
import { isTruthyDebugFlag } from '../shared/debug-flags'
import { TextToSpeechSettingsService } from './services/text-to-speech-settings-service'
import type {
  ListTextToSpeechVoicesRequest,
  SaveTextToSpeechSettingsRequest,
  SynthesizeTextToSpeechRequest
} from '../shared/text-to-speech'
import { appLogger } from './app-logger'
import { wcdbDebugLog } from './wcdb-debug'

let getMessagesRequestSequence = 0

function nextGetMessagesRequestId(): string {
  getMessagesRequestSequence += 1
  return `GETMSG-${String(getMessagesRequestSequence).padStart(3, '0')}`
}
import type { AppLogEntry } from '../shared/app-log'
import { appUpdateService } from './services/app-update-service'
import { clearCache, getCacheSummary, openKnowledgeDirectory } from './services/cache-service'
import { imageTextIndexService } from './services/image-text-index-service'
import {
  IMAGE_TEXT_SEGMENT_MESSAGE_LIMIT,
  type ImageTextIndexStartOptions
} from '../shared/image-text-index'
import type { CacheClearScope } from './services/cache-service'
import { configureRecallArchive, RecallArchiveMonitor } from './services/recall-archive-service'
import { VideoAssetService } from './video-asset-service'
import { cancelExport, revealExport, runExport } from './export-service'
import type { ExportRequest } from '../shared/export'
import { discoverAccounts } from './services/account-discovery'
import { VoiceRecognitionUseCase } from './voice-pipeline/voice-recognition-use-case'
import { VoiceBatchService } from './voice-pipeline/voice-batch-service'
import type { VoiceBatchRequest, VoiceMessageReference } from '../shared/voice-recognition'
import type { AiSearchPipelineRequest } from '../shared/ai-search'
import type {
  AskWechatConfig,
  AskWechatQueryRequest,
  AskWechatQueryResult
} from '../shared/query-agent'
import type { KnowledgeSearchIpcRequest, KnowledgeSearchIpcResult } from '../shared/knowledge'
// 消息身份的规范化在 main / renderer 之间必须一致，所以只从 shared 取一份实现。
import { normalizeMessageIdentity } from '../shared/local-query-api'
import {
  isWindowsVcRuntimeMissingError,
  WINDOWS_VC_RUNTIME_ERROR_MESSAGE
} from '../shared/windows-runtime'
import { KnowledgeSearchService } from './knowledge/knowledge-search-service'
import {
  MESSAGES_AROUND_MAX_WINDOW,
  messagesAroundRadii,
  normalizeRadiusSeconds,
  sliceMessagesAroundWindow,
  widenRadiusSeconds
} from './services/messages-around'
import { LocalQueryApiService } from './services/local-query-api-service'
import { AiSearchPipelineService } from './services/ai-search-pipeline-service'
import { QueryAgentService } from './services/query-agent-service'
import { AskWechatService } from './services/ask-wechat-service'
import { createLocalQueryToolExecutor } from './services/local-query-tool-executor'
import { runLegacySafeStorageHelper } from './legacy-safe-storage-helper'
import { runFirstLaunchMigration } from './app-data-migration'
import { WechatShareConfigStore } from './wechat-share-config-store'
import { WechatShareCardService } from './wechat-share-card-service'
import type {
  PublishWechatShareCardRequest,
  WechatShareServiceConfig
} from '../shared/wechat-share-card'

// electron-vite can close the child's stdout/stderr after spawning Electron.
// Plain console.error then throws EPIPE on a closed pipe and crashes the IPC
// handler. Wrap console.* before any other module logs anything.
installSafeConsole()

/**
 * 进程内微信 iLink 连接器：inbound 回调与 outbound 发送都在主进程内完成，
 * 不依赖子进程，也不开本地 HTTP 端口。
 */
const wechatConnectorService = new WechatConnectorService()

let voiceService: VoiceService | null = null
let voiceRecognition: VoiceRecognitionUseCase | null = null
let voiceBatchService: VoiceBatchService | null = null
let knowledgeSearchService: KnowledgeSearchService | null = null
let localQueryApiService: LocalQueryApiService | null = null
let aiSearchPipelineService: AiSearchPipelineService | null = null
let queryAgentService: QueryAgentService | null = null
let askWechatService: AskWechatService | null = null
let imageDecryptService: ImageDecryptService | null = null
let stickerService: StickerService | null = null
let videoAssetService: VideoAssetService | null = null
const databaseKeyStore = new DatabaseKeyStore()
const imageKeyConfigService = new ImageKeyConfigService()
const aiProviderService = new AIProviderService()
const textToSpeechSettingsService = new TextToSpeechSettingsService()
const personalWechatRuntimeManager = new PersonalWechatRuntimeManager()
const keyServiceMac = new KeyServiceMac()
const keyServiceWin = new KeyServiceWin()
const wechatShareConfigStore = new WechatShareConfigStore()
const wechatShareCardService = new WechatShareCardService(wechatShareConfigStore)
let tray: Tray | null = null
let recallArchiveMonitor: RecallArchiveMonitor | null = null
let recallProtectionGeneration = 0
let recallJournalTimer: NodeJS.Timeout | null = null
let wcdbBootstrapPromise: Promise<unknown> | null = null
type ColdImageLoadItem = {
  priority: number
  sequence: number
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}
const coldImageLoadQueue: ColdImageLoadItem[] = []
let activeColdImageLoads = 0
let coldImageLoadSequence = 0
let coldImageLoadTimer: NodeJS.Timeout | null = null
let nextColdImageLoadAt = 0

const COLD_IMAGE_LOAD_GAP_MS = 100
const MAX_CONCURRENT_COLD_IMAGE_LOADS = 2

function pumpColdImageLoads(): void {
  if (activeColdImageLoads >= MAX_CONCURRENT_COLD_IMAGE_LOADS || coldImageLoadQueue.length === 0) {
    return
  }

  const waitMs = Math.max(0, nextColdImageLoadAt - Date.now())
  if (waitMs > 0) {
    if (!coldImageLoadTimer) {
      coldImageLoadTimer = setTimeout(() => {
        coldImageLoadTimer = null
        pumpColdImageLoads()
      }, waitMs)
    }
    return
  }

  coldImageLoadQueue.sort(
    (left, right) => left.priority - right.priority || left.sequence - right.sequence
  )
  const item = coldImageLoadQueue.shift()
  if (!item) return

  activeColdImageLoads += 1
  nextColdImageLoadAt = Date.now() + COLD_IMAGE_LOAD_GAP_MS
  void item
    .run()
    .then(item.resolve, item.reject)
    .finally(() => {
      activeColdImageLoads -= 1
      pumpColdImageLoads()
    })
  pumpColdImageLoads()
}

function enqueueColdImageLoad<T>(task: () => Promise<T> | T, priority = 0): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    coldImageLoadQueue.push({
      priority,
      sequence: coldImageLoadSequence++,
      run: async () => task(),
      resolve: (value) => resolve(value as T),
      reject
    })
    pumpColdImageLoads()
  })
}

function configureRecallProtection(
  wcdb4Client: Wcdb4Client,
  accountRoot: string,
  enabled: boolean,
  installJournal = false
): void {
  recallProtectionGeneration += 1
  const generation = recallProtectionGeneration
  recallArchiveMonitor?.stop()
  recallArchiveMonitor = null
  if (recallJournalTimer) {
    clearTimeout(recallJournalTimer)
    recallJournalTimer = null
  }
  configureRecallArchive(enabled ? accountRoot : '')
  if (!enabled) return

  const monitor = new RecallArchiveMonitor(
    () =>
      wcdb4Client.getSessions().map((session) => ({
        md5: wcdb4Client.md5(session.username),
        m_nsUsrName: session.username,
        type: session.username.endsWith('@chatroom') ? 'group' : 'user',
        activityKey: [
          session.raw['last_timestamp'],
          session.raw['sort_timestamp'],
          session.raw['last_msg_locald_id'],
          session.raw['last_msg_type'],
          session.raw['summary']
        ].join(':')
      })),
    (sessionMd5) =>
      chat.listMessages(sessionMd5, Math.floor(Date.now() / 1000) - 10 * 60, undefined, {
        limit: 500
      })
  )
  recallArchiveMonitor = monitor
  // Session indexing is not required to open the UI. Defer it so large databases
  // do not make db:init wait for every conversation to be enumerated.
  setImmediate(() => {
    if (generation === recallProtectionGeneration && recallArchiveMonitor === monitor) {
      monitor.seedAll()
    }
  })
  if (!installJournal) return
  // Creating recall triggers scans every message table and runs synchronously in
  // the main process. Only do this after the user explicitly enables protection;
  // existing installations remain active without repeating the scan at startup.
  recallJournalTimer = setTimeout(() => {
    recallJournalTimer = null
    if (generation !== recallProtectionGeneration || recallArchiveMonitor !== monitor) return
    const result = wcdb4Client.installRecallJournal(
      wcdb4Client.getSessions().map((session) => session.username)
    )
    console.log(
      `[WCDB4] recall journal ready installed=${result.installed} failed=${result.failed}`
    )
  }, 30_000)
}

const packagedIconPath = join(process.resourcesPath, 'resources', 'icon.png')
const appIconPath = existsSync(packagedIconPath) ? packagedIconPath : icon

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'wxe-media',
    privileges: { secure: true, standard: true, stream: true, supportFetchAPI: true }
  }
])

let dbInitInFlight: Promise<{ success: boolean; monitoring?: boolean; error?: string }> | null =
  null
let appShutdownRequested = false
let isQuitting = false
const BUILD_MARK = 'wechat4-local-http-api-2026-07-03'
const TRAY_MODE =
  process.argv.includes('--tray') || (process.env['WXE_TRAY'] || '').toString() === '1'

function getConfiguredImageKeys(): { xorKey: string; aesKey: string } {
  const config = imageKeyConfigService.getConfig()
  return {
    xorKey: config.xorKey || '0x40',
    aesKey: config.aesKey || ''
  }
}

function getImageMediaService(): VideoAssetService | null {
  if (videoAssetService) return videoAssetService
  const client = chat.getChatDb()?.getWcdb4Client()
  if (!client) return null
  videoAssetService = new VideoAssetService(client)
  return videoAssetService
}

function getLocalMediaMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.mp4':
      return 'video/mp4'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.bmp':
      return 'image/bmp'
    default:
      return 'application/octet-stream'
  }
}

function buildImageResponse(
  image: DecodedImage,
  includeData = false
): {
  success: true
  data: string
  isThumb: boolean
  filePath: string
  mimeType?: string
} {
  const mediaService = image.cacheFilePath ? getImageMediaService() : null
  const data =
    !includeData && mediaService && image.cacheFilePath && existsSync(image.cacheFilePath)
      ? mediaService.createLocalMediaUrl(image.cacheFilePath)
      : image.data
  return {
    success: true,
    data,
    isThumb: image.isThumbnail,
    filePath: image.filePath,
    mimeType: image.mimeType
  }
}

async function createLocalMediaResponse(request: Request, filePath: string): Promise<Response> {
  const { size } = await fsPromises.stat(filePath)
  const mimeType = getLocalMediaMimeType(filePath)
  const commonHeaders = {
    'Accept-Ranges': 'bytes',
    'Content-Type': mimeType,
    'Cache-Control': 'private, max-age=300'
  }
  const range = request.headers.get('range')

  if (!range) {
    const body =
      request.method === 'HEAD' ? null : Uint8Array.from(await fsPromises.readFile(filePath))
    return new Response(body, {
      status: 200,
      headers: { ...commonHeaders, 'Content-Length': String(size) }
    })
  }

  const match = /^bytes=(\d+)-(\d*)$/i.exec(range.trim())
  if (!match) {
    return new Response(null, {
      status: 416,
      headers: { ...commonHeaders, 'Content-Range': `bytes */${size}` }
    })
  }
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  const end = Math.min(requestedEnd, size - 1)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    return new Response(null, {
      status: 416,
      headers: { ...commonHeaders, 'Content-Range': `bytes */${size}` }
    })
  }

  const length = end - start + 1
  let body: Buffer | null = null
  if (request.method !== 'HEAD') {
    const handle = await fsPromises.open(filePath, 'r')
    try {
      body = Buffer.allocUnsafe(length)
      await handle.read(body, 0, length, start)
    } finally {
      await handle.close()
    }
  }
  return new Response(body ? Uint8Array.from(body) : null, {
    status: 206,
    headers: {
      ...commonHeaders,
      'Content-Length': String(length),
      'Content-Range': `bytes ${start}-${end}/${size}`
    }
  })
}

function createWindow(): void {
  // 创建浏览器窗口
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    icon: appIconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  let closePromptInFlight = false

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('close', (event) => {
    if (isQuitting || appShutdownRequested) return
    event.preventDefault()
    if (closePromptInFlight) return
    closePromptInFlight = true
    void dialog
      .showMessageBox(mainWindow, {
        type: 'question',
        title: '关闭 TraceMemo',
        message: '请选择关闭方式',
        detail: '你可以将窗口隐藏到系统托盘，或退出整个应用进程。',
        buttons: ['最小化到系统托盘', '关闭进程', '取消'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      })
      .then(({ response }) => {
        if (response === 0) {
          setupTray()
          mainWindow.hide()
          if (process.platform === 'darwin') app.dock?.hide()
          return
        }
        if (response === 1) {
          isQuitting = true
          app.quit()
        }
      })
      .catch((error) => {
        console.warn('[Window] close prompt failed:', error)
      })
      .finally(() => {
        closePromptInFlight = false
      })
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 基于 electron-vite CLI 的渲染器热更新
  // 加载开发环境的远程 URL，或生产环境的本地 HTML 文件
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Electron 初始化完成并准备创建浏览器窗口后，将调用此方法
// 某些 API 只能在此事件发生后使用
app.whenReady().then(async () => {
  if (isLegacyMigrationHelper) {
    try {
      runLegacySafeStorageHelper()
      app.exit(0)
    } catch {
      app.exit(1)
    }
    return
  }

  try {
    const migration = isUserDataIsolated ? null : await runFirstLaunchMigration(appDataRoots)
    apiTokenStore.setAutomaticGenerationBlocked(migration?.tokenBlockReason)
    if (!migration) {
      appLogger.write({
        level: 'info',
        scope: 'app-data-migration',
        message: '隔离 userData 已启用，跳过真实用户数据迁移'
      })
    } else {
      appLogger.write({
        level: migration.assessment.selection.legacyConflict ? 'warn' : 'info',
        scope: 'app-data-migration',
        message: migration.assessment.selection.legacyConflict
          ? '检测到两个独立的 legacy userData，已按兼容优先级选择 WechatExplorer 作为迁移源'
          : 'TraceMemo 数据身份检查完成',
        details: {
          action: migration.action,
          reason: migration.assessment.reason,
          sourceRoot: migration.assessment.sourceRoot,
          targetRoot: appDataRoots.current,
          legacyExists: migration.assessment.selection.directories.legacy,
          legacyPackageExists: migration.assessment.selection.directories.legacyPackage,
          legacyAssets: migration.assessment.selection.assets.legacy,
          legacyPackageAssets: migration.assessment.selection.assets.legacyPackage,
          legacyRootsEquivalent: migration.assessment.selection.legacyRootsEquivalent,
          legacyConflict: migration.assessment.selection.legacyConflict,
          migrationStatus: migration.execution?.state.status,
          tokenGenerationBlocked: migration.tokenGenerationBlocked
        }
      })
    }
  } catch (error) {
    const targetToken = join(appDataRoots.current, 'local-api-token.bin')
    const legacyTokenExists = [appDataRoots.legacy, appDataRoots.legacyPackage].some((root) =>
      existsSync(join(root, 'local-api-token.bin'))
    )
    if (!existsSync(targetToken) && legacyTokenExists) {
      apiTokenStore.setAutomaticGenerationBlocked(
        '旧版 API Token 迁移未完成，本地 API 已安全停用。请保留旧数据并重新启动迁移。'
      )
    }
    appLogger.write({
      level: 'error',
      scope: 'app-data-migration',
      message: 'TraceMemo 数据迁移初始化失败',
      details: { error: error instanceof Error ? error.message : String(error) }
    })
    await dialog.showMessageBox({
      type: 'warning',
      title: 'TraceMemo 数据迁移',
      message: '旧数据迁移未能启动',
      detail:
        '旧目录没有被修改或删除。请保留 WechatExplorer 数据并重新启动 TraceMemo；旧 API Token 不会被静默替换。',
      buttons: ['好']
    })
  }

  voiceRecognition = new VoiceRecognitionUseCase({
    modelRoot: join(app.getPath('userData'), 'models', 'sensevoice-small-int8'),
    databasePath: join(app.getPath('userData'), 'cache', 'voice-transcripts.sqlite'),
    workerPath: join(__dirname, 'voiceRecognitionWorker.js')
  })
  knowledgeSearchService = new KnowledgeSearchService(
    app.getPath('userData'),
    join(__dirname, 'knowledgeWorker.js')
  )
  knowledgeSearchService.setVoiceTranscriptResolver(
    (reference) => voiceRecognition?.getTranscriptSnapshot(reference) || { state: 'pending' }
  )
  voiceRecognition.onTranscriptUpdate((update) =>
    knowledgeSearchService?.indexVoiceTranscript(update)
  )

  /**
   * 确保图片解密服务可用（按需创建，与 `db:getImage` 冷路径同一套构造方式）。
   *
   * 提取成显式入口是因为原来它只存在于 `db:getImage` 的闭包里，
   * 别的需要解密的路径（图片文字索引回填）拿不到、只能拿到 `null`。
   */
  function ensureImageDecryptService(): ImageDecryptService | null {
    if (imageDecryptService) return imageDecryptService
    const { xorKey, aesKey } = getConfiguredImageKeys()
    if (!aesKey) return null
    imageDecryptService = new ImageDecryptService(
      xorKey,
      aesKey,
      chat.getChatDb()?.getWcdb4Client(),
      loadSettings().dbRoot
    )
    return imageDecryptService
  }

  // 图片文字索引（本地 System OCR 派生文本）。
  // 与语音转写完全同构：派生文本在 main 进程解析后贴到消息上，Knowledge 侧只消费结果。
  knowledgeSearchService.setImageOcrResolver((conversationId, messageId) =>
    imageTextIndexService.getConversationOcr(conversationId).get(messageId)
  )
  /**
   * 图片文字索引需要解密图片。
   *
   * 解密服务原本只在 `db:getImage`（用户点开某张图）里才懒加载，于是没点开过图片时
   * 全量回填会拿到 `null`。这里改成显式"按需确保"，凡是需要解密的路径都能自己建起来。
   */
  imageTextIndexService.bind({
    databaseRoot: join(app.getPath('userData'), 'image-text-index'),
    resolveAccountId: () =>
      chat.isReady()
        ? String(chat.getSelfAccountInfo()?.wxid || chat.getCurrentAccountRoot() || '')
        : '',
    resolveAccountRoot: () => chat.getCurrentAccountRoot() || loadSettings().dbRoot || '',
    listContacts: async () => {
      const contacts = await chat.listContactsAsync()
      return contacts.map((contact) => ({
        md5: contact.md5,
        m_nsUsrName: contact.m_nsUsrName,
        type: contact.type
      }))
    },
    listMessages: (conversationId) =>
      chat.listMessagesAsync(
        conversationId,
        undefined,
        undefined,
        undefined,
        undefined,
        'image-text-index'
      ),
    /**
     * 图片索引走**专用查询**：只读图片消息，不读整个会话。
     *
     * 全量读取一个 20 万条消息的会话实测要 15s 以上，而其中 99% 以上的行
     * 图片索引根本不看 —— 那是数据边界错了，不是 OCR 慢。
     */
    listImageMessages: (conversationId, window) =>
      chat.listImageMessagesAsync(
        conversationId,
        {
          ...(window?.sinceMs !== undefined ? { sinceMs: window.sinceMs } : {}),
          ...(window?.beforeMs !== undefined ? { beforeMs: window.beforeMs } : {}),
          limit: IMAGE_TEXT_SEGMENT_MESSAGE_LIMIT
        },
        'image-text-index'
      ),
    countConversationImages: (conversationId, range) =>
      chat.countImageMessagesAsync(conversationId, range),
    imageWatermark: (conversationId, range) =>
      chat.imageConversationWatermarkAsync(conversationId, range),
    decryptService: () => ensureImageDecryptService(),
    capability: () => systemOcrService.getCapability(),
    /**
     * OCR 并发度的运行时覆盖；不设置则走 `DEFAULT_IMAGE_TEXT_OCR_CONCURRENCY`。
     *
     * 同一份二进制、同一批图片只改这一个数，才能把并发度当作对照变量来比较。
     * 非法值会被 `resolveImageTextOcrConcurrency` 收敛掉。
     */
    ...(process.env.TRACEMEMO_OCR_CONCURRENCY
      ? { ocrConcurrency: Number(process.env.TRACEMEMO_OCR_CONCURRENCY) }
      : {}),
    /** 低频性能画像：只写性能数字，不含图片内容 / 路径 / 会话标识。 */
    logStageProfile: (profile) =>
      appLogger.write({
        level: 'info',
        scope: 'image-text-index',
        message: '图片文字索引性能画像',
        details: { ...profile }
      }),
    recognize: async (imageDataUrl) => {
      const result = await systemOcrService.recognize({ imageDataUrl })
      return {
        success: result.success,
        text: result.text,
        language: result.language,
        ...(result.errorCode ? { errorCode: result.errorCode } : {})
      }
    },
    // 会话图片全部处理完 → 重建该会话索引，OCR 文本才可被 search_messages 检索。
    onConversationIndexed: (conversationId) =>
      knowledgeSearchService?.indexImageOcr(conversationId) ?? Promise.resolve()
  })
  aiSearchPipelineService = new AiSearchPipelineService(knowledgeSearchService, aiProviderService)
  localQueryApiService = new LocalQueryApiService(knowledgeSearchService)
  // 图片文字索引覆盖度是**独立覆盖维度**：接到 search_messages 的 tool result 上，
  // 让 Query Agent 在图片索引没做完时不能凭 0 条证据断言"没有"。
  localQueryApiService.setImageTextCoverageProvider(() =>
    imageTextIndexService.getCoverageSnapshot()
  )
  /**
   * 单条图片消息的 OCR 派生文本也要接到精确读消息路径上。
   *
   * 与覆盖度是**两件不同的事**：覆盖度回答"索引建了多少"，这里回答
   * "这一条图片已经识别出的文字是什么"。只接前者的话，图片索引建好了模型也读不到正文，
   * 只能看到一个空的 `attachment`。
   *
   * 只读派生库，**不触发 OCR / 解密 / 读原图**。
   */
  localQueryApiService.setImageOcrEntryProvider((conversationId, messageId) =>
    imageTextIndexService.getConversationOcr(conversationId).get(messageId)
  )
  // 收藏只读检索：search_messages 合并 favorite.db 命中（无库时返回空）。
  localQueryApiService.setFavoritesSearchProvider(async (query, limit) => {
    const wcdb = chat.getChatDb()?.getWcdb4Client()
    if (!wcdb) return []
    const { FavoritesService } = await import('./favorites-service')
    return new FavoritesService(wcdb).searchHits(query, limit)
  })
  setLocalQueryApiService(localQueryApiService)
  // Query Agent：生产 Runtime 只在这里实例化一次，桌面问问微信与 Agent Hub 共用同一个实例。
  queryAgentService = new QueryAgentService(
    aiProviderService,
    createLocalQueryToolExecutor(localQueryApiService)
  )
  askWechatService = new AskWechatService(queryAgentService, {
    entry: 'desktop',
    // Legacy 仅在 Runtime 不可恢复错误时使用（见 AskWechatService 的 fallback 规则）。
    runLegacy: (request) => {
      if (!aiSearchPipelineService) throw new Error('本地搜索服务尚未初始化')
      return aiSearchPipelineService.run(request, () => undefined)
    },
    log: (record) =>
      appLogger.write({
        level: record.level,
        scope: 'query-agent',
        message: record.message,
        details: record.details
      })
  })
  agentHubService.setQueryAgentService(queryAgentService)
  // 微信 iLink 连接器直接跑在主进程内：inbound 回调与 outbound 发送都不经过本地 HTTP 桥。
  agentHubService.setWechatConnector(wechatConnectorService)
  wechatSendGateway.configureIlinkSender(async (request) => {
    const target = {
      to: request.to,
      ...(request.account_id ? { accountId: request.account_id } : {}),
      ...(request.context_token ? { contextToken: request.context_token } : {})
    }
    if (request.type === 'text') {
      await wechatConnectorService.sendText({ ...target, text: request.msg })
      return
    }
    if (request.type === 'image' || request.type === 'file') {
      if (/^https?:\/\//i.test(request.msg)) {
        await wechatConnectorService.sendMediaUrl({ ...target, mediaUrl: request.msg })
      } else {
        await wechatConnectorService.sendMediaPath({ ...target, filePath: request.msg })
      }
      return
    }
    throw new Error('iLink 通道暂不支持发送语音')
  })
  knowledgeSearchService.onStatusChange((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('knowledge:status', status)
    }
  })
  imageTextIndexService.onStatusChange((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('image-text-index:status', status)
    }
  })
  voiceRecognition.modelManager.setProgressListener((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('voice:modelProgress', status)
    }
  })
  personalWechatRuntimeManager.setProgressListener((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('wechat-personal:runtimeProgress', status)
    }
  })
  protocol.handle('wxe-media', async (request) => {
    const filePath = videoAssetService?.pathForUrl(request.url)
    if (!filePath) return new Response('Not found', { status: 404 })
    try {
      return await createLocalMediaResponse(request, filePath)
    } catch (error) {
      console.warn('[Video] local media request failed:', error)
      return new Response('Media unavailable', { status: 500 })
    }
  })
  console.log(`TraceMemo main build: ${BUILD_MARK}`)
  appLogger.write({
    level: 'info',
    scope: 'lifecycle',
    message: 'TraceMemo 启动',
    details: { build: BUILD_MARK, platform: process.platform, version: app.getVersion() }
  })
  process.on('uncaughtException', (error) => {
    appLogger.write({
      level: 'error',
      scope: 'main-process',
      message: error.message,
      details: { stack: error.stack }
    })
  })
  process.on('unhandledRejection', (reason) => {
    appLogger.write({
      level: 'error',
      scope: 'main-process',
      message: reason instanceof Error ? reason.message : 'Promise 未处理拒绝',
      details: {
        stack: reason instanceof Error ? reason.stack : undefined,
        reason: reason instanceof Error ? undefined : String(reason)
      }
    })
  })

  // Create the renderer before native WCDB bootstrap so startup progress is visible immediately.
  await reportTemplateService.recover()
  registerReportTemplateIpc()
  createWindow()
  wcdbBootstrapPromise = bootstrapWcdbNativeAsync().then(() => {
    console.log('[WCDB4] async bootstrap complete')
  })
  void wcdbBootstrapPromise.catch((error) => {
    appLogger.write({
      level: 'error',
      scope: 'wcdb-bootstrap',
      message: error instanceof Error ? error.message : String(error)
    })
  })

  // 设置应用程序用户模型 ID
  electronApp.setAppUserModelId('com.tracememo.app')

  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath)

  // 开发环境中默认使用 F12 打开或关闭 DevTools
  // 生产环境中忽略 CommandOrControl + R
  // 参见 https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))
  ipcMain.handle('app-log:write', (_, entry: AppLogEntry) => appLogger.write(entry))
  ipcMain.handle('app-log:getPath', () => appLogger.logPath)
  ipcMain.handle('app-log:reveal', () => appLogger.reveal())
  ipcMain.handle('app-update:getState', () => appUpdateService.getState())
  ipcMain.handle('app-update:check', () => appUpdateService.check())
  ipcMain.handle('app-update:download', () => appUpdateService.download())
  ipcMain.handle('app-update:install', () => appUpdateService.install())
  ipcMain.handle('app-update:openDownloadPage', () => appUpdateService.openDownloadPage())
  appUpdateService.scheduleStartupCheck()
  ipcMain.handle('cache:getSummary', () => getCacheSummary())
  ipcMain.handle('cache:openKnowledgeDirectory', () => openKnowledgeDirectory())
  ipcMain.handle('cache:clear', async (_, scope: CacheClearScope) => {
    const allowedScopes: CacheClearScope[] = [
      'bootstrap',
      'electron',
      'knowledge',
      'image-text-index',
      'all'
    ]
    if (!allowedScopes.includes(scope)) return getCacheSummary()
    imageDecryptService = null
    // 这里刻意**不再**提前 resetAccount()：清理钩子需要先读到派生库里的
    // "哪些会话有 OCR 派生文本"，才能把这些会话的 Knowledge 索引一起失效。
    // 句柄由 beforeClearImageTextIndex 内部的 clear() 自己关闭（删文件前）。
    return clearCache(scope, {
      beforeClearKnowledge: () =>
        knowledgeSearchService?.prepareForCacheClear() || Promise.resolve(),
      beforeClearImageTextIndex: async () => {
        await imageTextIndexService.prepareForCacheClear()
        imageTextIndexService.resetAccount()
      }
    })
  })

  ipcMain.handle('db:init', async (_, key: string, accountRoot?: string) => {
    if (appShutdownRequested) {
      return { success: false, error: '应用正在退出，数据库连接已取消', monitoring: false }
    }
    if (dbInitInFlight) return dbInitInFlight

    dbInitInFlight = (async () => {
      const startedAt = Date.now()
      try {
        if (wcdbBootstrapPromise) await wcdbBootstrapPromise
        if (appShutdownRequested) {
          return { success: false, error: '应用正在退出，数据库连接已取消', monitoring: false }
        }
        const trimmedKey = String(key || '').trim()
        console.log(`db:init build=${BUILD_MARK} keyLength=${trimmedKey.length}`)
        const settings = loadSettings()
        const selectedRoot = String(accountRoot || settings.dbRoot || '').trim()
        const rootValidation = validateDbRoot(selectedRoot)
        if (!rootValidation.valid) {
          return {
            success: false,
            code: 'ROOT_UNAVAILABLE',
            error: rootValidation.error,
            monitoring: false
          }
        }
        if (!existsSync(join(selectedRoot, 'db_storage'))) {
          return {
            success: false,
            code: 'ACCOUNT_SELECTION_REQUIRED',
            error: '请先明确选择一个微信账号',
            monitoring: false
          }
        }
        if (
          chat.isReady() &&
          chat.getCurrentKey().replace(/^0x/i, '').trim() === trimmedKey.replace(/^0x/i, '') &&
          chat.getCurrentAccountRoot() === selectedRoot
        ) {
          console.log('[WCDB4] db:init reuse current connection')
          void groupExitMonitorService.start(true)
          return { success: true, monitoring: true }
        }
        const nextWechatDb = await WechatDb.create(key, selectedRoot)
        if (appShutdownRequested) {
          await nextWechatDb.closeAsync()
          return { success: false, error: '应用正在退出，数据库连接已取消', monitoring: false }
        }
        groupExitMonitorService.stop()
        const resolvedRoot = nextWechatDb.getWcdb4Client().getAccountRoot()
        if (resolvedRoot) {
          // 同步更新 imageKeyRoot，避免自动获取图片密钥时扫描到错误目录
          saveSettings({
            ...settings,
            dbRoot: resolvedRoot,
            imageKeyRoot: resolvedRoot
          })
        }
        if (!chat.setChatDb(nextWechatDb)) {
          return { success: false, error: '应用正在退出，数据库连接已取消', monitoring: false }
        }
        const wcdb4Client = nextWechatDb.getWcdb4Client()
        const sessions = await wcdb4Client.getSessionsAsync({ hydrateDisplayNames: false })
        configureRecallProtection(wcdb4Client, resolvedRoot, settings.recallProtectionEnabled)
        voiceService = new VoiceService(wcdb4Client, resolvedRoot)
        voiceRecognition?.connect(voiceService, resolvedRoot)
        stickerService = new StickerService(wcdb4Client)
        videoAssetService = new VideoAssetService(wcdb4Client)
        const monitoring = await wcdb4Client.startMonitor((type, json) => {
          wcdb4Client.invalidateSessionCache()
          groupExitMonitorService.notifyDatabaseChanged(json)
          recallArchiveMonitor?.handleDatabaseChange(json)
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.webContents.send('wcdb-change', { type, json })
          }
        })
        void groupExitMonitorService.start(monitoring)
        const recentSession = sessions[0]
        if (recentSession?.username) {
          void wcdb4Client
            .getMessagesAsync(recentSession.username, undefined, undefined, { limit: 1 })
            .catch((error) => console.warn('[WCDB4] message cursor warmup failed:', error))
        }
        imageDecryptService = null
        // 派生库按 accountId 分目录，切账号必须换句柄，否则会串账号。
        imageTextIndexService.resetAccount()
        console.log(
          `[WCDB4] db:init ready sessions=${sessions.length} monitoring=${monitoring} cost=${Date.now() - startedAt}ms`
        )
        return { success: true, monitoring }
      } catch (error) {
        console.error('Failed to init DB:', error)
        const detail = error instanceof Error ? error.message : String(error)
        if (isWindowsVcRuntimeMissingError(detail, process.platform)) {
          return {
            success: false,
            code: 'VC_RUNTIME_MISSING',
            error: WINDOWS_VC_RUNTIME_ERROR_MESSAGE,
            monitoring: false
          }
        }
        return { success: false, error: detail }
      } finally {
        dbInitInFlight = null
      }
    })()

    return dbInitInFlight
  })

  ipcMain.handle('accounts:discover', (_, inputPath: string) =>
    discoverAccounts(inputPath, databaseKeyStore, chat.getCurrentAccountRoot())
  )

  ipcMain.handle('key:getSavedDbKey', async (_, accountRoot: string) => {
    const selectedRoot = String(accountRoot || '').trim()
    const scoped = await databaseKeyStore.load(selectedRoot)
    if (scoped.saved || !selectedRoot) return scoped
    const legacy = await databaseKeyStore.loadLegacy()
    if (!legacy.success || !legacy.key) return scoped
    const validation = await chat.testConnection(legacy.key, selectedRoot)
    if (!validation.success) return scoped
    const migrated = await databaseKeyStore.save(selectedRoot, legacy.key)
    if (migrated.success) await databaseKeyStore.clearLegacy()
    return migrated
  })

  ipcMain.handle('key:getEnvironment', async () => {
    const storage = await databaseKeyStore.getStatus(
      chat.getCurrentAccountRoot() || loadSettings().dbRoot
    )
    const self = chat.getSelfAccountInfo()
    const settings = loadSettings()
    const intelMac = process.platform === 'darwin' && process.arch === 'x64'
    const intelEnvironment = intelMac ? await keyServiceMac.getIntelEnvironmentStatus() : undefined
    const environment = {
      platform: process.platform,
      architecture: process.arch,
      osVersion: getOsVersionLabel(),
      appVersion: `v${app.getVersion()}`,
      wechatVersion: await detectWechatVersion(),
      dataStructureVersion: detectDataStructureVersion(settings.dbRoot),
      dataDirectoryDetected: validateDbRoot(settings.dbRoot).valid,
      autoDetectSupported: process.platform === 'win32' || process.platform === 'darwin',
      wechatRunning: await isWechatRunning(),
      accountIdentified: Boolean(self?.wxid),
      dbConnected: chat.isReady(),
      encryptionAvailable: storage.encryptionAvailable,
      ...(intelEnvironment || {})
    }
    return { ...environment, diagnosticSummary: buildSafeDiagnosticSummary(environment) }
  })

  ipcMain.handle('key:readClipboardDbKey', () => {
    try {
      return { success: true, value: clipboard.readText().trim() }
    } catch {
      return { success: false, error: '无法读取剪贴板' }
    }
  })

  ipcMain.handle('key:installIntelMacRuntime', async (event) => {
    const onStatus = (message: string): void => {
      if (!event.sender.isDestroyed()) event.sender.send('key:dbKeyStatus', { message })
    }
    return keyServiceMac.installIntelKeyRuntime(onStatus)
  })

  ipcMain.handle('key:pasteAndSaveDbKey', async (_, accountRoot: string) => {
    const clipboardKey = clipboard.readText().trim()
    return databaseKeyStore.save(String(accountRoot || ''), clipboardKey)
  })

  ipcMain.handle('key:saveDbKey', async (_, accountRoot: string, key: string) =>
    databaseKeyStore.save(String(accountRoot || ''), String(key || ''))
  )

  ipcMain.handle('key:clearSavedDbKey', async (_, accountRoot: string) =>
    databaseKeyStore.clear(String(accountRoot || ''))
  )

  ipcMain.handle(
    'key:autoGetDbKey',
    async (event, accountRoot: string, options?: { save?: boolean }) => {
      const onStatus = (message: string): void => {
        if (!event.sender.isDestroyed()) event.sender.send('key:dbKeyStatus', { message })
      }
      const result =
        process.platform === 'win32'
          ? await keyServiceWin.autoGetDbKey(60_000, onStatus)
          : await keyServiceMac.autoGetDbKey(onStatus, 60_000, accountRoot)
      if (!result.success || !result.key) return result

      const selectedRoot = String(accountRoot || '').trim()
      if (!selectedRoot) return { success: false, error: '请先选择微信账号' }
      const validation = await chat.testConnection(result.key, selectedRoot)
      if (!validation.success) {
        return {
          ...result,
          success: false,
          key: undefined,
          error:
            '获取到的密钥不属于所选账号, 也可能是选择错误的目录了, 请打开微信设置 左下角确认目录是否和软件内填写一致'
        }
      }
      if (options?.save === false) return result

      const saved = await databaseKeyStore.save(selectedRoot, result.key)
      return {
        ...result,
        saved: saved.success,
        warning: saved.success ? undefined : saved.error
      }
    }
  )
  // 日报等系统动作仍复用现有发送服务；普通聊天不再暴露这个入口。
  ipcMain.handle('wechat-personal:send', async (_, request: PersonalWechatSendRequest) => {
    if (request.type !== 'voice' || String(request.fromId || '').trim()) {
      return personalWechatSendService.send(request)
    }
    let fromId = ''
    try {
      const self = await chat.getSelfAccountInfoAsync()
      fromId = String(self?.wxid || '').trim()
    } catch {
      // 无法读取账号 wxid 时仍交给发送服务返回规范化错误。
    }
    return personalWechatSendService.send(fromId ? { ...request, fromId } : request)
  })

  ipcMain.handle('key:autoGetImageKey', async (event, options?: { save?: boolean }) => {
    const settings = loadSettings()
    const self = chat.getSelfAccountInfo()
    // 优先级：chat 真实识别到的根 → self.accountRoot → settings.imageKeyRoot → settings.dbRoot
    // 必须先看 chat.getCurrentAccountRoot()，否则 settings 缓存漂移会导致扫错目录。
    const accountRoot =
      chat.getCurrentAccountRoot() || self?.accountRoot || settings.imageKeyRoot || settings.dbRoot
    const wxid = self?.wxid
    const onStatus = (message: string): void => {
      if (!event.sender.isDestroyed()) event.sender.send('key:imageKeyStatus', { message })
    }
    const result =
      process.platform === 'win32'
        ? await keyServiceWin.autoGetImageKey(accountRoot, onStatus, wxid)
        : await keyServiceMac.autoGetImageKey(accountRoot, onStatus, wxid)

    if (!result.success || !result.aesKey) return result
    if (process.platform === 'win32') {
      onStatus('发现候选密钥，图片模板验证通过')
    }

    const imageXorKey = `0x${Number(result.xorKey ?? 0x40)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0')}`
    const verified = result.verified ?? process.platform === 'win32'
    if (options?.save === false) {
      return { ...result, verified, imageXorKey, imageAesKey: result.aesKey }
    }
    const saved = imageKeyConfigService.save({
      resourceRoot: accountRoot,
      xorKey: imageXorKey,
      aesKey: result.aesKey
    })
    if (saved.success) imageDecryptService = null
    // 派生库按 accountId 分目录，切账号必须换句柄，否则会串账号。
    imageTextIndexService.resetAccount()
    return {
      ...result,
      success: saved.success,
      error: saved.success ? undefined : saved.error,
      verified,
      imageXorKey,
      imageAesKey: result.aesKey,
      settings: imageKeyConfigService.getLegacySettingsView()
    }
  })

  ipcMain.handle('image:getConfig', () => imageKeyConfigService.getConfig())

  ipcMain.handle('image:getStatus', async () =>
    inspectImageDecryptionStatus(imageKeyConfigService.getConfig())
  )

  ipcMain.handle('image:saveConfig', (_, request: SaveImageKeyRequest) => {
    const result = imageKeyConfigService.save(request)
    if (result.success) imageDecryptService = null
    // 派生库按 accountId 分目录，切账号必须换句柄，否则会串账号。
    imageTextIndexService.resetAccount()
    return result
  })

  ipcMain.handle('image:testConfig', (_, request: TestImageDecryptionRequest) =>
    testImageDecryption(request)
  )

  ipcMain.handle('image:clearConfig', () => {
    const result = imageKeyConfigService.clear()
    if (result.success) imageDecryptService = null
    // 派生库按 accountId 分目录，切账号必须换句柄，否则会串账号。
    imageTextIndexService.resetAccount()
    return result
  })

  ipcMain.handle('image:selectDecoder', async (event) => {
    const settings = loadSettings()
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(owner!, {
      title: '选择 FFmpeg 解压或安装目录',
      defaultPath: settings.ffmpegPath ? dirname(settings.ffmpegPath) : app.getPath('downloads'),
      properties: ['openDirectory']
    })
    if (result.canceled) return { success: false, canceled: true }

    const selectedDirectory = result.filePaths[0]
    if (!selectedDirectory) return { success: false, canceled: true }

    const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    const candidates = [
      join(selectedDirectory, executable),
      join(selectedDirectory, 'bin', executable)
    ]
    let selectedPath = ''
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      const inspection = await inspectImageDecoderExecutable(candidate)
      if (inspection.installed) {
        selectedPath = candidate
        break
      }
    }

    if (!selectedPath) {
      return {
        success: false,
        canceled: false,
        error: '所选目录中没有找到 FFmpeg，请选择解压后的文件夹或其中的 bin 文件夹。'
      }
    }

    saveSettings({ ...settings, ffmpegPath: selectedPath })
    return {
      success: true,
      canceled: false,
      status: await inspectImageDecoderStatus(selectedPath)
    }
  })

  ipcMain.handle('image:getDecoderStatus', () => inspectImageDecoderStatus())

  ipcMain.handle('image:openDecoderDownload', async () => {
    const url =
      process.platform === 'win32'
        ? 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
        : process.platform === 'darwin'
          ? 'https://brew.sh/'
          : 'https://ffmpeg.org/download.html'
    try {
      await shell.openExternal(url)
      return { success: true }
    } catch {
      return { success: false, error: '无法打开下载页面，请检查系统默认浏览器设置。' }
    }
  })

  ipcMain.handle('db:getBootstrapCache', () => {
    if (!chat.isReady()) return null
    return getBootstrapCache(chat.getCurrentAccountRoot())
  })

  ipcMain.handle('db:getStartupCache', () => {
    const settings = loadSettings()
    return settings.dbRoot ? getBootstrapCache(settings.dbRoot) : null
  })

  ipcMain.handle(
    'db:getCachedMessages',
    (_, userMd5: string, startTime?: number, endTime?: number) => {
      const accountRoot = chat.isReady() ? chat.getCurrentAccountRoot() : loadSettings().dbRoot
      return accountRoot ? getCachedMessages(accountRoot, userMd5, startTime, endTime) : []
    }
  )

  ipcMain.handle(
    'db:getCachedMessagePage',
    (_, userMd5: string, startTime?: number, endTime?: number) => {
      const accountRoot = chat.isReady() ? chat.getCurrentAccountRoot() : loadSettings().dbRoot
      return accountRoot
        ? getCachedMessagePage(accountRoot, userMd5, startTime, endTime)
        : { hit: false, messages: [] }
    }
  )

  ipcMain.handle('db:getContacts', async (_, filter?: string) => {
    const accountRoot = chat.getCurrentAccountRoot()
    const contacts = accountRoot
      ? mergeCachedContactAvatars(accountRoot, await chat.listContactsAsync(filter))
      : await chat.listContactsAsync(filter)
    if (!filter && chat.isReady() && accountRoot) {
      saveBootstrapContacts(accountRoot, contacts)
    }
    return contacts
  })

  ipcMain.handle(
    'db:getContactAvatars',
    async (_, usernames: string[], options?: { refresh?: boolean }) => {
      const avatars = await chat.getContactAvatars(usernames, options)
      if (chat.isReady()) mergeBootstrapAvatars(chat.getCurrentAccountRoot(), avatars)
      return avatars
    }
  )

  ipcMain.handle(
    'db:getMessages',
    async (
      _,
      userMd5: string,
      startTime?: number,
      endTime?: number,
      options?: { limit?: number }
    ) => {
      const requestId = nextGetMessagesRequestId()
      const startedAt = Date.now()
      wcdbDebugLog(
        `[${requestId}] IPC db:getMessages start start=${startTime || 0} end=${endTime || 0} limit=${options?.limit || 0}`
      )
      try {
        const messages = await chat.listMessagesAsync(
          userMd5,
          startTime,
          endTime,
          options,
          requestId
        )
        if (chat.isReady()) {
          saveCachedMessages(chat.getCurrentAccountRoot(), userMd5, startTime, endTime, messages)
        }
        wcdbDebugLog(
          `[${requestId}] IPC db:getMessages end rows=${messages.length} cost=${Date.now() - startedAt}ms`
        )
        return messages
      } catch (error) {
        wcdbDebugLog(`[${requestId}] IPC db:getMessages error cost=${Date.now() - startedAt}ms`)
        throw error
      }
    }
  )

  /**
   * 「跳转到原聊天」的锚点读取。
   *
   * 与 `db:getMessages` 的区别：目标是**某一条消息**，不是"某个时间段"。
   * 以 `anchorSeconds` 为中心读一个**有界**窗口（默认 ±6h，找不到再放宽到 ±3d），
   * 在窗口内按规范化消息 id 精确匹配。
   *
   * 不整段加载会话历史：最大会话可达数十万条消息，整段读既慢又会挤爆 IPC；
   * 而时间窗口在真实数据上是稀疏的，±6h 的量级很小。
   *
   * `found: false` 表示"已打开会话但无法定位原消息"，调用方必须走降级文案，
   * 不能假装跳转成功。
   */
  ipcMain.handle(
    'db:getMessagesAround',
    async (
      _,
      userMd5: string,
      messageId: string,
      anchorSeconds?: number,
      radiusSeconds?: number
    ) => {
      const requestId = nextGetMessagesRequestId()
      const startedAt = Date.now()
      const target = normalizeMessageIdentity(userMd5, messageId)
      if (!target) return { messages: [], found: false, radiusSeconds: 0, truncated: false }
      const baseRadius = normalizeRadiusSeconds(radiusSeconds)
      const widenRadius = widenRadiusSeconds(baseRadius)
      const maxWindowMessages = MESSAGES_AROUND_MAX_WINDOW
      const radii = messagesAroundRadii(anchorSeconds, baseRadius, widenRadius)
      if (!radii.length) {
        // 没有时间锚点时**不能**退化成整段加载会话历史（最大会话可达数十万条，
        // 整段读既慢又会挤爆 IPC）。诚实返回"未定位到"，由调用方给出降级文案。
        wcdbDebugLog(`[${requestId}] IPC db:getMessagesAround skipped reason=no-anchor`)
        return { messages: [], found: false, radiusSeconds: 0, truncated: false }
      }
      wcdbDebugLog(
        `[${requestId}] IPC db:getMessagesAround start messageId=${target.messageId} anchor=${anchorSeconds || 0}`
      )
      for (const radius of radii) {
        const start = Math.max(0, (anchorSeconds as number) - radius)
        const end = (anchorSeconds as number) + radius
        let messages: Awaited<ReturnType<typeof chat.listMessagesAsync>>
        try {
          messages = await chat.listMessagesAsync(userMd5, start, end, undefined, requestId)
        } catch (error) {
          wcdbDebugLog(`[${requestId}] IPC db:getMessagesAround error radius=${radius}`)
          throw error
        }
        const { window, index, truncated } = sliceMessagesAroundWindow(
          messages,
          userMd5,
          target.messageId,
          maxWindowMessages
        )
        if (index >= 0) {
          if (chat.isReady()) {
            saveCachedMessages(chat.getCurrentAccountRoot(), userMd5, start, end, window)
          }
          wcdbDebugLog(
            `[${requestId}] IPC db:getMessagesAround found radius=${radius} rows=${window.length} cost=${Date.now() - startedAt}ms`
          )
          return { messages: window, found: true, radiusSeconds: radius, truncated }
        }
        // 窗口内没有这条消息：可能是时间戳口径漂移，也可能是它已经被删除/清理。
        // 只有还值得放宽时才继续，避免把一次点击变成全库扫描。
        if (radius === radii[radii.length - 1]) {
          wcdbDebugLog(
            `[${requestId}] IPC db:getMessagesAround not-found rows=${window.length} cost=${Date.now() - startedAt}ms`
          )
          return { messages: window, found: false, radiusSeconds: radius, truncated }
        }
      }
      return { messages: [], found: false, radiusSeconds: 0, truncated: false }
    }
  )

  ipcMain.handle('db:getGroupSnapshot', async (_, userMd5: string) => {
    const snapshot = await chat.getGroupSnapshotAsync(userMd5)
    if (snapshot && chat.isReady()) {
      return saveCachedGroupSnapshot(chat.getCurrentAccountRoot(), userMd5, snapshot)
    }
    return snapshot
  })

  ipcMain.handle('group-exit-monitor:getState', () => groupExitMonitorService.getState())
  ipcMain.handle('group-exit-monitor:setEnabled', (_, enabled: boolean) =>
    groupExitMonitorService.setEnabled(enabled === true)
  )
  ipcMain.handle(
    'group-exit-monitor:setGroups',
    (_, roomIds: string[], notificationRoomIds?: string[]) =>
      groupExitMonitorService.setMonitoredRoomIds(
        Array.isArray(roomIds) ? roomIds : [],
        Array.isArray(notificationRoomIds) ? notificationRoomIds : []
      )
  )
  ipcMain.handle('group-exit-monitor:setTemplate', (_, template: unknown) =>
    groupExitMonitorService.setNotificationTemplate(template)
  )
  ipcMain.handle('group-exit-monitor:checkNow', () => groupExitMonitorService.checkNow())
  ipcMain.handle('group-exit-monitor:clearEvents', () => groupExitMonitorService.clearEvents())
  ipcMain.handle('group-exit-monitor:resendEvent', (_, eventId: string) =>
    groupExitMonitorService.resendEvent(eventId)
  )
  ipcMain.handle('group-exit-monitor:markRead', (_, readAt?: number) =>
    groupExitMonitorService.markRead(readAt)
  )
  ipcMain.handle('wechat-action-log:list', () => wechatActionLogService.list())

  ipcMain.handle('db:search', (_, keyword: string) => chat.searchMessages(keyword))
  ipcMain.handle(
    'knowledge:search',
    (_, request: KnowledgeSearchIpcRequest): Promise<KnowledgeSearchIpcResult> => {
      if (!knowledgeSearchService) {
        throw new Error('本地知识库服务尚未初始化')
      }
      return knowledgeSearchService.search(request)
    }
  )
  ipcMain.handle('knowledge:getStatus', () => {
    if (!knowledgeSearchService) throw new Error('本地知识库服务尚未初始化')
    return knowledgeSearchService.getStatus()
  })
  ipcMain.handle('knowledge:startIndex', () => {
    if (!knowledgeSearchService) throw new Error('本地知识库服务尚未初始化')
    return knowledgeSearchService.startCurrentAccountIndex()
  })
  /**
   * 取消正在跑的索引 pass。
   *
   * - 只中止**索引**：并发的交互查询用另一套 Abort scope，不会被连带取消；
   * - 当前 batch 安全收尾：已提交的会话保留，**不回滚**；
   * - `run_state` 落到 `cancelled`，不残留 `indexing`；
   * - 取消 ≠ 清空：下一次同步从 per-conversation checkpoint 继续，不从头全量重扫。
   */
  ipcMain.handle('knowledge:cancelIndex', () => {
    if (!knowledgeSearchService) throw new Error('本地知识库服务尚未初始化')
    return knowledgeSearchService.cancelCurrentAccountIndex()
  })
  // ---- 图片文字索引（本地 System OCR 派生文本，非 AI Provider）----
  ipcMain.handle('image-text-index:getStatus', () => imageTextIndexService.getStatus())
  /**
   * 点击索引前的快速统计：纯 SQL COUNT，**不解密任何图片**。
   * 这是「先告诉用户有多少张图片再决定是否开始」能足够快的前提。
   */
  ipcMain.handle('image-text-index:count', (_, sinceMs?: number) =>
    imageTextIndexService.countImageMessages(sinceMs)
  )
  ipcMain.handle('image-text-index:start', (_, options?: ImageTextIndexStartOptions) =>
    imageTextIndexService.startPass(options ?? {})
  )
  ipcMain.handle('image-text-index:pause', () => imageTextIndexService.pause())
  ipcMain.handle('image-text-index:resume', (_, options?: ImageTextIndexStartOptions) =>
    imageTextIndexService.resume(options ?? {})
  )
  ipcMain.handle('image-text-index:cancel', () => imageTextIndexService.cancel())
  ipcMain.handle('image-text-index:clear', () => imageTextIndexService.clear())
  // 只重置失败记录（成功记录与其它数据一律不动），供"修好代码后重跑"使用。
  ipcMain.handle('image-text-index:resetFailures', () =>
    imageTextIndexService.resetRetriableFailures()
  )
  // 派生索引修复：只重建 Knowledge 里的图片派生条目（L3），**不重新 OCR**（L1 不动）。
  ipcMain.handle('image-text-index:repair', () => imageTextIndexService.repairKnowledgeIndex())
  ipcMain.handle('ai-search:run', (event, request: AiSearchPipelineRequest) => {
    if (!aiSearchPipelineService) throw new Error('本地搜索服务尚未初始化')
    return aiSearchPipelineService.run(request, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai-search:progress', progress)
    })
  })
  ipcMain.handle('ai-search:cancel', (_, requestId: string) => {
    if (!aiSearchPipelineService) throw new Error('本地搜索服务尚未初始化')
    return aiSearchPipelineService.cancel(requestId)
  })
  voiceBatchService = new VoiceBatchService(voiceRecognition)
  voiceBatchService.onProgress((progress) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('voice:batchProgress', progress)
    }
  })
  ipcMain.handle('ai-search:getProviderStatus', () => aiProviderService.getAiSearchProviderStatus())
  // 问问微信主路径：查询大脑走 Query Agent Runtime（与 Agent Hub 同一实现）。
  ipcMain.handle(
    'ask-wechat:getConfig',
    (): AskWechatConfig => ({ queryAgentEnabled: loadSettings().queryAgentEnabled !== false })
  )
  ipcMain.handle(
    'ask-wechat:query',
    (event, request: AskWechatQueryRequest): Promise<AskWechatQueryResult> => {
      if (!askWechatService) throw new Error('本地查询服务尚未初始化')
      // 进度事件只在真实 Runtime 边界产生，并且**带 requestId** 回传：
      // UI 可以据此忽略过期请求的进度（用户连问两次时不会串台）。
      return askWechatService.ask(request, 'default', (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('ask-wechat:progress', request.requestId, progress)
        }
      })
    }
  )
  ipcMain.handle('ask-wechat:forgetConversation', () => {
    askWechatService?.forgetConversation()
  })
  ipcMain.handle(
    'ai-search:authorizeExternalProvider',
    (_, request: AiSearchExternalAuthorizationRequest) => {
      if (!aiSearchPipelineService) throw new Error('本地搜索服务尚未初始化')
      return aiSearchPipelineService.authorizeExternalProvider(request)
    }
  )

  ipcMain.handle(
    'ai:chat',
    async (_, messages: { role: string; content: string }[], options?: AIChatRequestOptions) =>
      aiProviderService.chat(messages, options)
  )

  ipcMain.handle('ai:listProviders', () => aiProviderService.list())
  ipcMain.handle('ai:getRuntimeConfig', () => aiProviderService.getRuntimeConfig())
  ipcMain.handle('ai:getVisionRuntimeConfig', () => aiProviderService.getVisionRuntimeConfig())
  ipcMain.handle('ai:saveProvider', (_, provider: AIProviderConfig) =>
    aiProviderService.save(provider)
  )
  ipcMain.handle('ai:deleteProvider', (_, providerId: string) =>
    aiProviderService.delete(providerId)
  )
  ipcMain.handle('ai:setDefaultProvider', (_, providerId: string) =>
    aiProviderService.setDefault(providerId)
  )
  ipcMain.handle('ai:testProvider', (_, providerId: string) => aiProviderService.test(providerId))
  ipcMain.handle('ai:testVision', (_, request: AIVisionTestRequest) =>
    aiProviderService.testVision(request)
  )
  ipcMain.handle('ai:migrateLegacy', (_, config: LegacyAIConfig) =>
    aiProviderService.migrateLegacy(config)
  )

  ipcMain.handle('tts:getSettings', () => textToSpeechSettingsService.get())
  ipcMain.handle('tts:saveSettings', (_, request: SaveTextToSpeechSettingsRequest) =>
    textToSpeechSettingsService.save(request)
  )
  ipcMain.handle('tts:listVoices', (_, request?: ListTextToSpeechVoicesRequest) =>
    textToSpeechSettingsService.listVoices(request)
  )
  ipcMain.handle('tts:synthesize', (_, request: SynthesizeTextToSpeechRequest) =>
    textToSpeechSettingsService.synthesize(request)
  )
  ipcMain.handle('tts:removeGeneratedAudio', (_, filePath: string) =>
    textToSpeechSettingsService.removeGeneratedAudio(String(filePath || ''))
  )
  ipcMain.handle('tts:openApiKeys', async () => {
    try {
      await shell.openExternal('https://fish.audio/app/api-keys/')
      return { success: true }
    } catch {
      return { success: false, error: '无法打开 Fish Audio API Key 页面' }
    }
  })

  ipcMain.handle('copy-image', async (_, imageSource: unknown) => {
    try {
      if (typeof imageSource !== 'string' || !imageSource) {
        return { success: false, error: 'Image source is empty' }
      }
      const image = imageSource.startsWith('wxe-media://')
        ? nativeImage.createFromPath(getImageMediaService()?.pathForUrl(imageSource) || '')
        : nativeImage.createFromDataURL(imageSource)
      if (image.isEmpty()) return { success: false, error: 'Image source is invalid' }
      clipboard.writeImage(image)
      return { success: true }
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  ipcMain.handle(
    'report:exportSnapshot',
    async (_, request: GroupReportRenderSnapshotExportRequest) => exportGroupReportSnapshot(request)
  )

  ipcMain.handle('export:start', async (event, request: ExportRequest) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return { success: false, error: '窗口不可用' }
    return runExport(request, window, voiceRecognition || undefined)
  })
  ipcMain.handle('export:selectDirectory', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window!, {
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? { canceled: true } : { canceled: false, path: result.filePaths[0] }
  })
  ipcMain.handle('export:cancel', (_, jobId: string) => {
    cancelExport(jobId)
    return { success: true }
  })
  ipcMain.handle('export:reveal', async (_, path: string) => {
    try {
      await revealExport(path)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
  ipcMain.handle('report:listGenerated', async () => {
    return listGeneratedReports()
  })

  ipcMain.handle('report:saveGenerated', async (_, request: SaveGeneratedReportRequest) => {
    return saveGeneratedReport(request)
  })

  ipcMain.handle(
    'report:updateGeneratedTemplate',
    async (_, request: UpdateGeneratedReportTemplateRequest) => {
      return updateGeneratedReportTemplate(request)
    }
  )

  ipcMain.handle(
    'report:prepareTemplateSwitch',
    async (_, request: PrepareGeneratedReportTemplateSwitchRequest) =>
      prepareGeneratedReportTemplateSwitch(request.reportId, extractGroupReportRenderSnapshot)
  )

  ipcMain.handle('report:deleteGenerated', async (_, reportId: string) => {
    return deleteGeneratedReport(reportId)
  })

  ipcMain.handle('wechat-personal:getSendCapability', () => getPersonalWechatSendCapability())
  ipcMain.handle('scheduled-report:list', () => scheduledReportService.listTasks())
  ipcMain.handle('scheduled-report:listExecutions', (_, taskId?: string) =>
    scheduledReportService.listExecutions(taskId)
  )
  ipcMain.handle('scheduled-report:getNotificationSettings', () =>
    scheduledReportService.getNotificationSettings()
  )
  ipcMain.handle('scheduled-report:setNotificationEnabled', (_, enabled: boolean) =>
    scheduledReportService.setNotificationEnabled(Boolean(enabled))
  )
  ipcMain.handle('scheduled-report:create', (_, request: ScheduledReportCreateInput) =>
    scheduledReportService.createTask(request)
  )
  ipcMain.handle(
    'scheduled-report:update',
    (_, taskId: string, request: ScheduledReportUpdateInput) =>
      scheduledReportService.updateTask(taskId, request)
  )
  ipcMain.handle('scheduled-report:delete', (_, taskId: string) =>
    scheduledReportService.deleteTask(taskId)
  )
  ipcMain.handle('scheduled-report:setEnabled', (_, taskId: string, enabled: boolean) =>
    scheduledReportService.setTaskEnabled(taskId, Boolean(enabled))
  )
  ipcMain.handle('scheduled-report:runNow', (_, taskId: string) =>
    scheduledReportService.runScheduledReportNow(taskId)
  )
  ipcMain.handle('scheduled-report:retrySend', (_, executionId: string) =>
    scheduledReportService.retryScheduledReportSend(executionId)
  )
  ipcMain.handle('scheduled-report:testErrorNotification', (_, taskId: string) => {
    if (!isTruthyDebugFlag(import.meta.env.VITE_SCHEDULED_REPORT_DEBUG)) {
      return Promise.resolve({
        success: false,
        error: '调试测试按钮未开启，请在 .env 中设置 VITE_SCHEDULED_REPORT_DEBUG=true。'
      })
    }
    return scheduledReportService.testScheduledReportErrorNotification(taskId)
  })

  ipcMain.handle('report:reveal', async (_, filePath: string) => {
    try {
      shell.showItemInFolder(filePath)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('wechat-share:getConfig', async () => wechatShareConfigStore.status())
  ipcMain.handle('wechat-share:saveConfig', async (_, config: WechatShareServiceConfig) =>
    wechatShareConfigStore.save(config)
  )
  ipcMain.handle('wechat-share:publish', async (_, request: PublishWechatShareCardRequest) =>
    wechatShareCardService.publish(request)
  )

  ipcMain.handle(
    'db:getVoiceData',
    async (_, sessionId: string, localId: number, createTime: number, svrId?: string | number) => {
      if (!voiceService) {
        return { success: false, error: 'VoiceService 未初始化' }
      }
      return voiceService.resolveVoice(sessionId, localId, createTime, svrId)
    }
  )

  ipcMain.handle(
    'voice:showSourceContextMenu',
    (
      event,
      reference: { sessionId: string; localId: number; createTime: number; svrId?: string | number }
    ) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window || !voiceService) return { success: false, error: '语音服务未初始化' }

      const revealSource = async (): Promise<void> => {
        try {
          const result = await voiceService!.resolveSource(
            reference.sessionId,
            reference.localId,
            reference.createTime,
            reference.svrId
          )
          if (!result.success) throw new Error(result.error)

          const directory = join(app.getPath('userData'), 'voice-sources')
          await fsPromises.mkdir(directory, { recursive: true })
          const fileName = `voice_${reference.localId}_${reference.createTime}_${result.source.sourceHash.slice(0, 12)}.silk`
          const filePath = join(directory, fileName)
          await fsPromises.writeFile(filePath, result.source.data)
          shell.showItemInFolder(filePath)
        } catch (error) {
          await dialog.showMessageBox(window, {
            type: 'error',
            title: '查找语音源文件失败',
            message: '无法提取这条语音的源文件',
            detail: error instanceof Error ? error.message : String(error)
          })
        }
      }

      Menu.buildFromTemplate([
        {
          label: '查找语音源文件',
          click: () => void revealSource()
        }
      ]).popup({ window })
      return { success: true }
    }
  )

  ipcMain.handle('voice:getModelStatus', async () => {
    if (!voiceRecognition) throw new Error('Voice recognition is not initialized')
    return voiceRecognition.getModelStatus()
  })

  ipcMain.handle('voice:downloadModel', async () => {
    if (!voiceRecognition) throw new Error('Voice recognition is not initialized')
    return voiceRecognition.downloadModel()
  })

  ipcMain.handle(
    'voice:cancelModelDownload',
    () => voiceRecognition?.cancelModelDownload() || { success: false }
  )

  ipcMain.handle('voice:removeModel', async () => {
    if (!voiceRecognition) throw new Error('Voice recognition is not initialized')
    return voiceRecognition.removeModel()
  })

  ipcMain.handle('voice:openModelDirectory', async () => {
    if (!voiceRecognition) return { success: false, error: '语音识别服务尚未初始化' }
    const directory = voiceRecognition.modelManager.directory
    await fsPromises.mkdir(directory, { recursive: true })
    const error = await shell.openPath(directory)
    return error ? { success: false, error } : { success: true }
  })

  ipcMain.handle(
    'voice:recognize',
    (_, reference: VoiceMessageReference, options?: { force?: boolean }) => {
      if (!voiceRecognition) {
        return { success: false, code: 'NOT_CONNECTED', error: '语音识别服务尚未初始化' }
      }
      return voiceRecognition.recognize(reference, options)
    }
  )

  ipcMain.handle('voice:getTranscriptSnapshot', (_, reference: VoiceMessageReference) => {
    return voiceRecognition?.getTranscriptSnapshot(reference) || { state: 'pending' as const }
  })

  ipcMain.handle('voice:getBatchPreflight', (_, request: VoiceBatchRequest) => {
    if (!voiceBatchService) throw new Error('Voice recognition is not initialized')
    return voiceBatchService.preflight(request)
  })

  ipcMain.handle('voice:getBatchConversationSummaries', (_, request: VoiceBatchRequest) => {
    if (!voiceBatchService) throw new Error('Voice recognition is not initialized')
    return voiceBatchService.conversationSummaries(request)
  })

  ipcMain.handle('voice:getBatchProgress', () => voiceBatchService?.getProgress())

  ipcMain.handle('voice:startBatch', (_, request: VoiceBatchRequest) => {
    if (!voiceBatchService) throw new Error('Voice recognition is not initialized')
    return voiceBatchService.start(request)
  })

  ipcMain.handle('voice:cancelBatch', () => ({ success: voiceBatchService?.cancel() || false }))

  ipcMain.handle('voice:retryFailedBatch', () => {
    if (!voiceBatchService) throw new Error('Voice recognition is not initialized')
    return voiceBatchService.retryFailed()
  })

  ipcMain.handle(
    'voice:cancelRecognition',
    (_, reference: VoiceMessageReference) =>
      voiceRecognition?.cancelRecognition(reference) || { success: false }
  )

  ipcMain.handle('db:parseMessage', async (_, content: string, messageType: number) => {
    return parseMessageContent(content, messageType)
  })

  ipcMain.handle(
    'db:getImage',
    async (
      _,
      imageMd5?: string,
      imageDatNameOrThumb?: string | boolean,
      _sessionId?: string,
      options?: {
        force?: boolean
        preferThumbnail?: boolean
        priority?: number
        includeData?: boolean
      }
    ) => {
      let service = imageDecryptService
      if (!service) {
        const { xorKey, aesKey } = getConfiguredImageKeys()
        // Reading an already-decoded cache entry does not require the AES key.
        // Before db:init resolves the account identity, secure storage may not
        // expose that key yet, so keep this cache-only service local.
        service = new ImageDecryptService(
          xorKey,
          aesKey,
          chat.getChatDb()?.getWcdb4Client(),
          loadSettings().dbRoot
        )
        if (aesKey) imageDecryptService = service
      }

      const imageDatName = typeof imageDatNameOrThumb === 'string' ? imageDatNameOrThumb : undefined
      const force = options?.force === true
      const preferThumbnail = options?.preferThumbnail === true
      const includeData = options?.includeData === true
      const priority = Number.isFinite(options?.priority) ? Number(options?.priority) : 0
      const imageCacheKey = [
        imageMd5 || '',
        imageDatName || '',
        force ? 'original' : preferThumbnail ? 'thumbnail' : 'auto'
      ].join('|')
      const mediaService = getImageMediaService()
      const cachedImage = await service.getCachedDecodedImage(imageCacheKey, {
        includeData: includeData || !mediaService
      })
      if (cachedImage && (!force || !cachedImage.isThumbnail)) {
        return buildImageResponse(cachedImage, includeData)
      }

      return enqueueColdImageLoad(async () => {
        // Disk cache was already checked without waiting for database startup.
        // Only a real miss needs the initialized WCDB client and hardlink index.
        if (dbInitInFlight) {
          await dbInitInFlight.catch(() => undefined)
        }

        let coldService = imageDecryptService
        if (!coldService) {
          const { xorKey, aesKey } = getConfiguredImageKeys()
          if (!aesKey) return { success: false, error: '未配置图片解密密钥' }
          coldService = new ImageDecryptService(
            xorKey,
            aesKey,
            chat.getChatDb()?.getWcdb4Client(),
            loadSettings().dbRoot
          )
          imageDecryptService = coldService
        }

        // A previous queued request may have populated the cache while this one waited.
        const queuedMediaService = getImageMediaService()
        const queuedCacheHit = await coldService.getCachedDecodedImage(imageCacheKey, {
          includeData: includeData || !queuedMediaService
        })
        if (queuedCacheHit && (!force || !queuedCacheHit.isThumbnail)) {
          return buildImageResponse(queuedCacheHit, includeData)
        }

        let filePath = force
          ? await coldService.findImageFileAsync(imageMd5, imageDatName, {
              allowThumbnail: false,
              sessionId: _sessionId
            })
          : null
        if (!filePath) {
          filePath = await coldService.findImageFileAsync(imageMd5, imageDatName, {
            allowThumbnail: true,
            preferThumbnail,
            sessionId: _sessionId
          })
        }
        if (!filePath) {
          return {
            success: false,
            error: force ? '未找到原图或缩略图文件' : '未找到图片文件'
          }
        }

        const decrypted = await coldService.decryptImageToBase64WithFallbackAsync(filePath, true)
        if (!decrypted) {
          return { success: false, error: '图片解密失败' }
        }

        const decodedImage: DecodedImage = {
          data: decrypted.data,
          filePath: decrypted.filePath,
          isThumbnail: coldService.isThumbnailFile(decrypted.filePath)
        }
        await coldService.cacheDecodedImage(imageCacheKey, decodedImage)
        return buildImageResponse(decodedImage, includeData)
      }, priority)
    }
  )

  // ============================================================
  // AI 图片理解基础设施(ImageInsightService)
  // ============================================================
  // 注入依赖(用闭包捕获当前 db:getImage 已经初始化过的 imageDecryptService)
  // 同时把 imageDecryptService 暴露到 globalThis,供 group-report-service 渲染时按 imageHash 取图
  ;(globalThis as { __imageDecrypt?: typeof imageDecryptService }).__imageDecrypt =
    imageDecryptService
  imageInsightService.bind({
    providerService: aiProviderService,
    decryptService: {
      findImageFile: (md5, datName, opts) =>
        imageDecryptService?.findImageFile(md5, datName, opts) ?? null,
      decryptImageToBase64: (filePath) =>
        imageDecryptService?.decryptImageToBase64(filePath) ?? null
    }
  })

  // System OCR 是独立的本地 Runtime（不是 AI Provider）：只注入项目统一的 ffmpeg
  // 解析逻辑（GIF/BMP/WebP/TIFF → PNG 归一化）和系统 locale（OCR 语言包探测）。
  systemOcrService.bind({
    resolveFfmpegExecutable,
    locale: () => app.getLocale()
  })

  /** 日报入口:取会话 Top N 热点图片 + 已缓存的 Insight */
  ipcMain.handle(
    'image:listCandidates',
    async (
      _,
      query: ImageCandidateQuery
    ): Promise<{ success: boolean; candidates: ImageCandidate[]; error?: string }> => {
      console.log('[IPC] image:listCandidates query=%j', query)
      try {
        const inputs = (query as ImageCandidateQuery & { inputs?: unknown[] }).inputs || []
        console.log('[IPC] image:listCandidates received %d inputs', inputs.length)
        const candidates = await imageInsightService.listTopHotImages(query, inputs as never)
        console.log('[IPC] image:listCandidates returned %d candidates', candidates.length)
        return { success: true, candidates }
      } catch (error) {
        console.warn('[IPC] image:listCandidates failed:', error)
        return {
          success: false,
          candidates: [],
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  /** 单图分析:缓存命中即返回,未命中调 AI;失败不抛 */
  ipcMain.handle(
    'image:analyze',
    async (_, request: ImageAnalysisRequest): Promise<ImageAnalysisResponse> => {
      console.log('[IPC] image:analyze hash=%s messageId=%s', request.imageHash, request.messageId)
      // 校验 provider 是否支持 vision
      const runtime = aiProviderService.getRuntimeConfig()
      if (!runtime.configured) {
        return { success: false, error: '尚未配置 AI Provider' }
      }
      const list = aiProviderService.list()
      const provider = list.providers.find((p) => p.id === runtime.providerId)
      const model = provider?.models.find((m) => m.id === runtime.model)
      if (!provider || !model) {
        return { success: false, error: '当前 AI 模型不存在' }
      }
      // Capability metadata is stored per machine. A model verified on macOS
      // may still be unmarked on Windows, so do not reject before making the
      // real multimodal request. The provider response remains authoritative.
      // request 来自 renderer,imageHash 是 md5(优先)或 sha256(...),dataUrl 在内部算出
      // 这里直接调 service,dataUrl 由 renderer 通过 window.api.getImage 拿到再传进来
      return imageInsightService.analyze(request)
    }
  )

  /** 单图查询缓存 */
  ipcMain.handle(
    'image:getInsight',
    async (_, imageHash: string): Promise<{ success: boolean; insight?: ImageInsight }> => {
      const insight = imageInsightService.getInsight(imageHash)
      return { success: true, insight: insight || undefined }
    }
  )

  /** 列出某会话所有已分析的 insights */
  ipcMain.handle(
    'image:listInsights',
    async (
      _,
      sessionId: string,
      limit?: number
    ): Promise<{ success: boolean; insights: ImageInsight[] }> => {
      return { success: true, insights: imageInsightService.listBySession(sessionId, limit) }
    }
  )

  // ============================================================
  // 本地图片文字识别（System OCR Runtime：Windows 系统 OCR / macOS 系统 OCR）
  // ============================================================
  // 这是本地 Runtime，不是 AI Vision Provider：
  //   - 不联网、不上传原图；
  //   - 不读写 AI Provider / Vision 模型配置；
  //   - 本 IPC 只返回识别文本、不落库：派生文本的持久化由图片文字索引负责。
  ipcMain.handle('system-ocr:getCapability', async (): Promise<SystemOcrCapability> => {
    return imageInsightService.getSystemOcrCapability()
  })

  ipcMain.handle(
    'system-ocr:recognize',
    async (_, request: SystemOcrRequest): Promise<SystemOcrResult> => {
      // 单图识别是用户主动触发的一次操作，结果里已经带了 text / durationMs / errorCode，
      // 调用方直接用返回值判断即可，这里不再打日志（尤其不打稳定的图片标识）。
      return imageInsightService.extractLocalText(request)
    }
  )

  ipcMain.handle('db:getSticker', async (_, cdnUrl?: string, md5?: string) => {
    if (!stickerService) {
      stickerService = new StickerService(chat.getChatDb()?.getWcdb4Client())
    }
    return stickerService.resolveSticker(cdnUrl, md5)
  })

  ipcMain.handle(
    'db:getVideo',
    async (
      _,
      hashes: string[],
      options?: {
        createTime?: number
        byteLength?: number
        duration?: number
        width?: number
        height?: number
      }
    ) => {
      if (!videoAssetService) {
        const client = chat.getChatDb()?.getWcdb4Client()
        if (!client) return { success: false, error: '数据库尚未连接' }
        videoAssetService = new VideoAssetService(client)
      }
      return videoAssetService.resolve(Array.isArray(hashes) ? hashes : [], options)
    }
  )

  // -------- Settings & API service --------

  ipcMain.handle('settings:get', () => ({
    settings: imageKeyConfigService.getLegacySettingsView(),
    settingsPath: getSettingsPath()
  }))

  ipcMain.handle('settings:set', (_, patch: Partial<AppSettings>) => {
    const before = loadSettings()
    const current = imageKeyConfigService.getConfig()
    const resourceRoot = patch.imageKeyRoot ?? before.imageKeyRoot
    const xorKey = patch.imageXorKey ?? current.xorKey ?? '0x40'
    const aesKey = patch.imageAesKey ?? current.aesKey ?? ''
    const includesImageKey = 'imageXorKey' in patch || 'imageAesKey' in patch
    const nextSettings = saveSettings({ ...before, ...patch, imageXorKey: '', imageAesKey: '' })
    if (includesImageKey) {
      if (aesKey) imageKeyConfigService.save({ resourceRoot, xorKey, aesKey })
      else imageKeyConfigService.clear()
      imageDecryptService = null
      // 派生库按 accountId 分目录，切账号必须换句柄，否则会串账号。
      imageTextIndexService.resetAccount()
    }
    if ('recallProtectionEnabled' in patch && chat.isReady()) {
      const currentDb = chat.getChatDb()
      if (currentDb) {
        configureRecallProtection(
          currentDb.getWcdb4Client(),
          chat.getCurrentAccountRoot(),
          nextSettings.recallProtectionEnabled,
          nextSettings.recallProtectionEnabled && !before.recallProtectionEnabled
        )
      }
    }
    return {
      settings: imageKeyConfigService.getLegacySettingsView(),
      settingsPath: getSettingsPath()
    }
  })

  ipcMain.handle('settings:getSelf', async () => {
    const rawInfo = await chat.getSelfAccountInfoAsync()
    if (!rawInfo) return { ready: false }
    const info = mergeCachedSelfInfo(rawInfo.accountRoot, rawInfo)
    if (chat.isReady()) saveBootstrapSelf(chat.getCurrentAccountRoot(), info)
    return { ready: true, info }
  })

  ipcMain.handle('db:testConnection', (_, key: string, accountRoot?: string) => {
    return chat.testConnection(key, accountRoot)
  })

  ipcMain.handle('db:reopenWithRoot', async (_, accountRoot: string) => {
    groupExitMonitorService.stop()
    const ok = chat.reopenWithRoot(accountRoot)
    if (!ok) return { success: false, error: '数据库未初始化或重新打开失败' }
    const client = chat.getChatDb()?.getWcdb4Client()
    if (client) {
      voiceService = new VoiceService(client, client.getAccountRoot())
      voiceRecognition?.connect(voiceService, client.getAccountRoot())
      const monitoring = await client.startMonitor((type, json) => {
        client.invalidateSessionCache()
        groupExitMonitorService.notifyDatabaseChanged(json)
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send('wcdb-change', { type, json })
        }
      })
      void groupExitMonitorService.start(monitoring)
    }
    // 同步 imageKeyRoot，避免自动获取扫描到旧目录
    const settings = loadSettings()
    if (accountRoot && accountRoot !== settings.imageKeyRoot) {
      saveSettings({ ...settings, imageKeyRoot: accountRoot })
    }
    const rawInfo = await chat.getSelfAccountInfoAsync()
    const info = rawInfo ? mergeCachedSelfInfo(rawInfo.accountRoot, rawInfo) : null
    return { success: true, info }
  })

  ipcMain.handle('settings:selectDbRoot', async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
      title: '选择微信数据库目录',
      defaultPath: loadSettings().dbRoot || undefined,
      properties: ['openDirectory']
    })
    return result.canceled ? { canceled: true } : { canceled: false, path: result.filePaths[0] }
  })

  ipcMain.handle('settings:openAccountRoot', async () => {
    const accountRoot = chat.getCurrentAccountRoot()
    if (!accountRoot) return { success: false, error: '当前没有可打开的账号目录' }
    const error = await shell.openPath(accountRoot)
    return error ? { success: false, error } : { success: true }
  })

  ipcMain.handle('db:disconnect', (_, options?: { closeNative?: boolean }) => {
    // 断开操作保持幂等：渲染进程可能已标记断开，或主进程连接已先行失效。
    // 即使当前未就绪，也应让用户正常返回登录页。
    voiceBatchService?.cancel()
    voiceRecognition?.disconnect()
    voiceService = null
    groupExitMonitorService.stop()
    if (options?.closeNative !== false && chat.isReady()) chat.setChatDb(null)
    return { success: true }
  })

  ipcMain.handle('api:getStatus', () => apiServer.getState())

  ipcMain.handle('api:tokenStatus', () => apiTokenStore.ensureToken())
  ipcMain.handle('api:revealToken', () => apiTokenStore.revealToken())
  ipcMain.handle('api:copyToken', () => {
    const result = apiTokenStore.revealToken()
    if (!result.token) return { ...result, success: false }
    try {
      clipboard.writeText(result.token)
      return {
        success: true,
        available: result.available,
        hasToken: result.hasToken,
        maskedToken: result.maskedToken
      }
    } catch {
      return { ...apiTokenStore.getStatus(), success: false, error: 'API Token 复制失败' }
    }
  })
  ipcMain.handle('api:rotateToken', () => apiTokenStore.rotateToken())

  ipcMain.handle('api:start', async (_, host?: string, port?: number) => {
    const settings = loadSettings()
    const target = {
      host: host || settings.apiHost,
      port: port || settings.apiPort
    }
    if (host || port) saveSettings({ ...settings, ...target })
    return apiServer.start(target.host, target.port)
  })

  ipcMain.handle('api:stop', async () => apiServer.stop())

  ipcMain.handle('api:toggle', async (_, enabled: boolean) => {
    const settings = saveSettings({ ...loadSettings(), apiEnabled: enabled })
    if (enabled) {
      return apiServer.start(settings.apiHost, settings.apiPort)
    }
    return apiServer.stop()
  })

  ipcMain.handle('api:skillStatus', () => skillResourceService.getStatus())
  ipcMain.handle('api:readSkill', () => skillResourceService.read())
  ipcMain.handle('api:revealSkill', () => skillResourceService.reveal())
  ipcMain.handle('api:openSkillGithub', () => skillResourceService.openGithub())
  ipcMain.handle('api:testLocalRequest', (_, request) => testLocalApiRequest(request))
  ipcMain.handle('api:copyCurl', (_, request) => {
    const result = buildLocalApiCurlCommand(request)
    if (!result.success || !result.command) return { success: false, error: result.error }
    try {
      clipboard.writeText(result.command)
      return { success: true }
    } catch {
      return { success: false, error: 'curl 命令复制失败' }
    }
  })
  ipcMain.handle('api:copyText', (_, text: unknown) => {
    if (typeof text !== 'string' || text.length > 1024 * 1024) {
      return { success: false, error: '复制内容无效或过大' }
    }
    try {
      clipboard.writeText(text)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('agent-hub:getStatus', () => agentHubService.getStatus())
  ipcMain.handle('agent-hub:getLogs', () => agentHubService.getLogs())
  ipcMain.handle('agent-hub:clearLogs', () => agentHubService.clearLogs())
  ipcMain.handle('agent-hub:startLogin', () => agentHubService.startLogin())
  ipcMain.handle('agent-hub:cancelLogin', () => agentHubService.cancelLogin())
  ipcMain.handle('agent-hub:reconnect', () => agentHubService.reconnect())
  ipcMain.handle('agent-hub:disconnect', () => agentHubService.disconnect())
  // 对话记录：完整收发回看，仅本机，不进日志。
  ipcMain.handle('agent-hub:getConversations', () => agentHubService.listConversations())
  ipcMain.handle('agent-hub:getConversation', (_, userId: string) =>
    agentHubService.getConversation(String(userId || ''))
  )
  ipcMain.handle('agent-hub:clearConversations', () => {
    agentHubService.clearConversations()
    return { success: true }
  })
  ipcMain.handle('wechat-personal:getStatus', () => personalWechatSendService.getStatus())
  ipcMain.handle('wechat-personal:getKeepProcess', () =>
    personalWechatSendService.getKeepOneBotProcess()
  )
  ipcMain.handle('wechat-personal:setKeepProcess', (_, keep: boolean) =>
    personalWechatSendService.setKeepOneBotProcess(Boolean(keep))
  )
  ipcMain.handle('wechat-personal:checkStatus', (_, port?: string) =>
    personalWechatSendService.checkWindowsStatus(port)
  )
  ipcMain.handle('wechat-personal:checkVoiceEnvironment', () =>
    personalWechatVoiceEnvironmentService.check()
  )
  ipcMain.handle('wechat-personal:installPilk', async () => {
    const result = await personalWechatVoiceEnvironmentService.installPilk()
    if (!result.success || process.platform !== 'darwin') return result

    const senderStatus = await personalWechatSendService.getStatus()
    if (!senderStatus.oneBotPid) return result
    try {
      const restartedStatus = await personalWechatSendService.restartRuntime()
      return {
        ...result,
        restarted: restartedStatus.state !== 'error',
        ...(restartedStatus.state === 'error'
          ? { restartError: restartedStatus.error || restartedStatus.message }
          : {})
      }
    } catch (error) {
      return {
        ...result,
        restarted: false,
        restartError: error instanceof Error ? error.message : String(error)
      }
    }
  })
  ipcMain.handle('wechat-personal:openVoicePythonDownload', async () => {
    try {
      await shell.openExternal('https://www.python.org/downloads/macos/')
      return { success: true }
    } catch {
      return { success: false, error: '无法打开 Python 下载页面' }
    }
  })
  ipcMain.handle('wechat-personal:openVoiceFfmpegDownload', async () => {
    try {
      await shell.openExternal('https://brew.sh/')
      return { success: true }
    } catch {
      return { success: false, error: '无法打开 FFmpeg 安装页面' }
    }
  })
  ipcMain.handle('wechat-personal:getRuntimeStatus', () => personalWechatRuntimeManager.getStatus())
  ipcMain.handle('wechat-personal:downloadRuntime', () => personalWechatRuntimeManager.download())
  ipcMain.handle('wechat-personal:cancelRuntimeDownload', () => ({
    success: personalWechatRuntimeManager.cancelDownload()
  }))
  ipcMain.handle('wechat-personal:removeRuntime', async () => {
    await personalWechatSendService.terminate(true)
    return personalWechatRuntimeManager.remove()
  })
  ipcMain.handle('wechat-personal:openRuntimeDirectory', async () => {
    const status = await personalWechatRuntimeManager.getStatus()
    const directory = status.directory || personalWechatRuntimeManager.directory
    await fsPromises.mkdir(directory, { recursive: true })
    const error = await shell.openPath(directory)
    return error ? { success: false, error } : { success: true }
  })
  ipcMain.handle('wechat-personal:rebind', () => personalWechatSendService.rebind())
  ipcMain.handle(
    'wechat-personal:sendGeneratedTtsVoice',
    async (_, request: PersonalWechatGeneratedTtsVoiceRequest) => {
      const to = String(request?.to || '').trim()
      const filePath = String(request?.filePath || '').trim()
      let fromId = ''
      try {
        const self = await chat.getSelfAccountInfoAsync()
        fromId = String(self?.wxid || '').trim()
      } catch {
        // Windows 语音发送需要当前账号 wxid；Gateway 会继续规范化失败结果。
      }
      const action = await wechatActionGateway.execute({
        origin: 'user_tts',
        purpose: 'tts_voice',
        triggerType: 'user',
        recipient: {
          type: request?.isGroup || to.endsWith('@chatroom') ? 'group' : 'contact',
          id: to
        },
        content: { type: 'voice', path: filePath },
        metadata: fromId ? { fromId } : undefined
      })
      const sendResult =
        action.sendResult && typeof action.sendResult === 'object'
          ? (action.sendResult as PersonalWechatSendResult)
          : undefined
      const status = sendResult?.status || (await personalWechatSendService.getStatus())
      return { action, status }
    }
  )
  ipcMain.handle('wechat-personal:getVoiceDiagnostic', () =>
    personalWechatSendService.getLatestVoiceDiagnostic()
  )
  ipcMain.handle('agent-hub:selectTestImage', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window!, {
      title: '选择要发送的图片',
      properties: ['openFile'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? { canceled: true } : { canceled: false, path: result.filePaths[0] }
  })

  // 启动本地 HTTP API（由 settings.apiEnabled 控制）
  const settings = loadSettings()
  // v2.1.8 and earlier did not have an API token. Generate it once during
  // upgrade/startup without changing any existing API or database settings.
  apiTokenStore.ensureToken()
  if (settings.apiEnabled) {
    await apiServer.start(settings.apiHost, settings.apiPort)
  }

  await agentHubService.start(settings)
  await scheduledReportService.start()

  setupTray()
  if (TRAY_MODE) app.dock?.hide()

  app.on('activate', function () {
    // 在 macOS 上点击 Dock 图标且没有其他窗口打开时，
    // 通常会在应用程序中重新创建一个窗口。
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 除 macOS 外，所有窗口关闭时退出应用。在 macOS 上，
// 应用程序及其菜单栏通常会保持活动状态，直到用户
// 明确使用 Cmd + Q 退出。
app.on('window-all-closed', () => {
  if (TRAY_MODE) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

let quitCleanupStarted = false
let quitCleanupComplete = false

app.on('before-quit', (event) => {
  if (quitCleanupComplete) return
  isQuitting = true
  appShutdownRequested = true
  event.preventDefault()
  if (quitCleanupStarted) return
  quitCleanupStarted = true
  voiceBatchService?.cancel()
  console.log('[Shutdown] cleanup started')

  void (async () => {
    agentHubService.stop()
    scheduledReportService.stop()
    groupExitMonitorService.stop()
    flushBootstrapCacheWritesSync()
    const [, nativeCallsDrained] = await Promise.all([
      apiServer.stop().catch(() => undefined),
      chat.closeChatDbForQuit().catch(() => false),
      voiceRecognition?.dispose().catch(() => undefined),
      knowledgeSearchService?.dispose().catch(() => undefined),
      personalWechatSendService.terminate().catch((error) => {
        console.warn('[Shutdown] personal WeChat sender cleanup failed:', error)
      })
    ])
    if (!nativeCallsDrained) {
      console.warn('[Shutdown] WCDB async calls did not fully drain before quit')
    }
    if (tray) {
      tray.destroy()
      tray = null
    }
    console.log('[Shutdown] cleanup completed')
  })()
    .catch((error) => {
      console.warn('[Shutdown] cleanup failed:', error)
    })
    .finally(() => {
      quitCleanupComplete = true
      // The first quit request has already been cancelled so cleanup can finish safely.
      // app.exit() avoids starting a second before-quit cycle that can leave Electron alive
      // on macOS even after every application service has stopped.
      console.log('[Shutdown] exiting application')
      app.exit(0)
    })
})

function showMainWindow(): void {
  if (process.platform === 'darwin') app.dock?.show().catch(() => undefined)
  const wins = BrowserWindow.getAllWindows()
  if (wins.length === 0) {
    createWindow()
    return
  }
  const win = wins[0]
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: '打开主窗口',
      click: () => showMainWindow()
    },
    { type: 'separator' },
    {
      label: '退出 TraceMemo',
      click: () => {
        tray?.destroy()
        tray = null
        app.quit()
      }
    }
  ])
}

function setupTray(): void {
  if (tray) return
  try {
    const image = nativeImage.createFromPath(appIconPath)
    const traySize = process.platform === 'darwin' ? 20 : 24
    const trayImage = image.isEmpty()
      ? nativeImage.createEmpty()
      : image.resize({ width: traySize, height: traySize, quality: 'best' })
    tray = new Tray(trayImage)
    tray.setToolTip('TraceMemo')
    // macOS may show a Tray context menu on a primary click when it is set
    // directly on the Tray. Keep the menu for an explicit secondary click so
    // the primary click only restores the main window.
    tray.on('click', () => showMainWindow())
    tray.on('right-click', () => tray?.popUpContextMenu(buildTrayMenu()))
  } catch (error) {
    console.warn('[Tray] Failed to create tray:', error)
  }
}
