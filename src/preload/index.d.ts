import { ElectronAPI } from '@electron-toolkit/preload'
import { Contact, Message } from '../shared/types'
import { GroupReportExportRequest, GroupReportExportResult } from '../shared/group-report'
import { LocalApiTestRequest, LocalApiTestResponse } from '../shared/local-api-test'
import {
  DeleteGeneratedReportResult,
  ReportHistoryResult,
  SaveGeneratedReportRequest,
  SaveGeneratedReportResult
} from '../shared/report-history'
import type {
  DatabaseKeyEnvironment,
  DatabaseInitResult,
  DatabaseKeyStorageResult,
  DatabaseKeyValidationResult,
  AccountDiscoveryResult
} from '../shared/database-key'
import type {
  ImageDecoderSelectionResult,
  ImageDecoderStatus,
  ImageDecryptionStatus,
  ImageDecryptionTestResult,
  ImageKeyConfigResult,
  SaveImageKeyRequest,
  TestImageDecryptionRequest
} from '../shared/image-decryption'
import type {
  AIChatRequestOptions,
  AiSearchExternalAuthorizationRequest,
  AiSearchExternalAuthorizationResult,
  AiSearchProviderStatus,
  AIConnectionTestResult,
  AIProviderConfig,
  AIProviderListResult,
  AIRuntimeModelConfig,
  AIVisionTestRequest,
  AIVisionTestResult,
  LegacyAIConfig
} from '../shared/ai-provider'
import type {
  ImageAnalysisRequest,
  ImageAnalysisResponse,
  ImageCandidate,
  ImageCandidateQuery,
  ImageInsight
} from '../shared/image-insight'
import type { AgentHubActionResult, AgentHubLogEntry, AgentHubStatus } from '../shared/agent-hub'
import type { AppLogEntry } from '../shared/app-log'
import type { AppUpdateCheckResult, AppUpdateState } from '../shared/app-update'
import type { CacheSummary } from '../shared/cache'
import type { ExportRequest, ExportJobProgress, ExportResult } from '../shared/export'
import type {
  VoiceBatchPreflight,
  VoiceBatchConversationSummary,
  VoiceBatchProgress,
  VoiceBatchRequest,
  VoiceMessageReference,
  VoiceModelDownloadResult,
  VoiceModelProgressEvent,
  VoiceModelStatus,
  VoiceRecognitionResult,
  VoiceTranscriptSnapshot
} from '../shared/voice-recognition'
import type {
  AiSearchCancelResult,
  AiSearchPipelineRequest,
  AiSearchPipelineResult,
  AiSearchProgressEvent
} from '../shared/ai-search'
import type {
  KnowledgeRuntimeStatus,
  KnowledgeSearchIpcRequest,
  KnowledgeSearchIpcResult
} from '../shared/knowledge'

export type ParsedContent =
  | { type: 'text'; content: string }
  | { type: 'voice'; duration?: number }
  | { type: 'location'; poiname?: string; label?: string; lat: number; lng: number }
  | { type: 'card'; username: string; nickname: string; avatarUrl?: string }
  | {
      type: 'share'
      title: string
      des?: string
      url: string
      appname?: string
      typeVal?: string
    }
  | {
      type: 'miniProgram'
      title: string
      description?: string
      appName?: string
      iconUrl?: string
      thumbMd5?: string
      thumbDatName?: string
      thumbDataUrl?: string
    }
  | { type: 'redPacket'; title: string; description?: string; url?: string }
  | { type: 'voip'; duration?: number; status: string; roomType?: number }
  | { type: 'image'; md5?: string; datName?: string; aeskey?: string; encrypVer?: number }
  | {
      type: 'video'
      md5?: string
      newMd5?: string
      rawMd5?: string
      byteLength?: number
      duration?: number
      width?: number
      height?: number
    }
  | {
      type: 'sticker'
      md5?: string
      url?: string
      thumbUrl?: string
      encryptUrl?: string
      aeskey?: string
    }
  | {
      type: 'quote'
      title?: string
      content?: string
      sender?: string
      quotedContent?: string
      quotedSender?: string
      quotedType?: string
    }
  | { type: 'system'; content: string }
  | { type: 'unknown'; raw: string }

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      writeAppLog: (entry: AppLogEntry) => Promise<void>
      getAppLogPath: () => Promise<string>
      revealAppLog: () => Promise<void>
      getAppUpdateState: () => Promise<AppUpdateState>
      checkAppUpdate: () => Promise<AppUpdateCheckResult>
      downloadAppUpdate: () => Promise<AppUpdateCheckResult>
      installAppUpdate: () => Promise<{ success: boolean; error?: string }>
      onAppUpdateState: (callback: (state: AppUpdateState) => void) => () => void
      getCacheSummary: () => Promise<CacheSummary>
      clearCache: (scope: 'bootstrap' | 'electron' | 'knowledge' | 'all') => Promise<CacheSummary>
      openKnowledgeDirectory: () => Promise<{ success: boolean; error?: string }>
      initDb: (key: string, accountRoot: string) => Promise<boolean | DatabaseInitResult>
      discoverAccounts: (inputPath: string) => Promise<AccountDiscoveryResult>
      getBootstrapCache: () => Promise<{
        self?: { wxid: string; nickname: string; avatar?: string; accountRoot: string }
        contacts: Contact[]
        updatedAt: number
      } | null>
      getStartupCache: () => Promise<{
        self?: { wxid: string; nickname: string; avatar?: string; accountRoot: string }
        contacts: Contact[]
        updatedAt: number
      } | null>
      getContacts: (filter?: string) => Promise<Contact[]>
      getContactAvatars: (usernames: string[]) => Promise<Record<string, string>>
      getCachedMessages: (
        userMd5: string,
        startTime?: number,
        endTime?: number
      ) => Promise<Message[]>
      getCachedMessagePage: (
        userMd5: string,
        startTime?: number,
        endTime?: number
      ) => Promise<{
        hit: boolean
        messages: Message[]
        groupSnapshot?: {
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
      }>
      getMessages: (
        userMd5: string,
        startTime?: number,
        endTime?: number,
        options?: { limit?: number }
      ) => Promise<Message[]>
      getGroupSnapshot: (userMd5: string) => Promise<{
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
      } | null>
      search: (keyword: string) => Promise<string | null>
      searchKnowledge: (request: KnowledgeSearchIpcRequest) => Promise<KnowledgeSearchIpcResult>
      runAiSearch: (request: AiSearchPipelineRequest) => Promise<AiSearchPipelineResult>
      cancelAiSearch: (requestId: string) => Promise<AiSearchCancelResult>
      onAiSearchProgress: (callback: (progress: AiSearchProgressEvent) => void) => () => void
      getKnowledgeStatus: () => Promise<KnowledgeRuntimeStatus>
      startKnowledgeIndex: () => Promise<KnowledgeRuntimeStatus>
      onKnowledgeStatus: (callback: (status: KnowledgeRuntimeStatus) => void) => () => void
      aiChat: (
        messages: { role: string; content: string }[],
        options?: AIChatRequestOptions
      ) => Promise<{
        success: boolean
        data?: string
        usage?: {
          input?: number
          output?: number
          total?: number
          estimated?: boolean
        }
        error?: string
      }>
      listAIProviders: () => Promise<AIProviderListResult>
      getAIRuntimeConfig: () => Promise<AIRuntimeModelConfig>
      getAiSearchProviderStatus: () => Promise<AiSearchProviderStatus>
      authorizeAiSearchExternalProvider: (
        request: AiSearchExternalAuthorizationRequest
      ) => Promise<AiSearchExternalAuthorizationResult>
      saveAIProvider: (provider: AIProviderConfig) => Promise<AIProviderListResult>
      deleteAIProvider: (providerId: string) => Promise<AIProviderListResult>
      setDefaultAIProvider: (providerId: string) => Promise<AIProviderListResult>
      testAIProvider: (providerId: string) => Promise<AIConnectionTestResult>
      testAIVision: (request: AIVisionTestRequest) => Promise<AIVisionTestResult>
      migrateLegacyAIConfig: (config: LegacyAIConfig) => Promise<AIProviderListResult>
      copyImage: (base64String: string) => Promise<{ success: boolean; error?: string }>
      getVoiceData: (
        sessionId: string,
        localId: number,
        createTime: number,
        svrId?: string | number
      ) => Promise<{ success: boolean; data?: string; error?: string }>
      getVoiceModelStatus: () => Promise<VoiceModelStatus>
      downloadVoiceModel: () => Promise<VoiceModelDownloadResult>
      cancelVoiceModelDownload: () => Promise<{ success: boolean }>
      removeVoiceModel: () => Promise<VoiceModelStatus>
      openVoiceModelDirectory: () => Promise<{ success: boolean; error?: string }>
      recognizeVoice: (reference: VoiceMessageReference) => Promise<VoiceRecognitionResult>
      getVoiceTranscriptSnapshot: (
        reference: VoiceMessageReference
      ) => Promise<VoiceTranscriptSnapshot>
      cancelVoiceRecognition: (reference: VoiceMessageReference) => Promise<{ success: boolean }>
      getVoiceBatchPreflight: (request: VoiceBatchRequest) => Promise<VoiceBatchPreflight>
      getVoiceBatchConversationSummaries: (
        request: VoiceBatchRequest
      ) => Promise<VoiceBatchConversationSummary[]>
      getVoiceBatchProgress: () => Promise<VoiceBatchProgress | undefined>
      startVoiceBatch: (request: VoiceBatchRequest) => Promise<VoiceBatchProgress>
      cancelVoiceBatch: () => Promise<{ success: boolean }>
      retryFailedVoiceBatch: () => Promise<VoiceBatchProgress>
      onVoiceBatchProgress: (callback: (progress: VoiceBatchProgress) => void) => () => void
      onVoiceModelProgress: (callback: (status: VoiceModelProgressEvent) => void) => () => void
      parseMessage: (content: string, messageType: number) => Promise<ParsedContent>
      getImage: (
        imageMd5?: string,
        imageDatNameOrThumb?: string | boolean,
        sessionId?: string,
        options?: {
          force?: boolean
          preferThumbnail?: boolean
          priority?: number
          includeData?: boolean
        }
      ) => Promise<{
        success: boolean
        data?: string
        error?: string
        isThumb?: boolean
        filePath?: string
      }>
      getVideo: (
        hashes: string[],
        options?: {
          createTime?: number
          byteLength?: number
          duration?: number
          width?: number
          height?: number
        }
      ) => Promise<{ success: boolean; url?: string; poster?: string; error?: string }>
      getSticker: (
        cdnUrl?: string,
        md5?: string
      ) => Promise<{
        success: boolean
        data?: string
        error?: string
        failureCode?: import('../shared/sticker').StickerFailureCode
        httpStatus?: number
      }>
      startExport: (request: ExportRequest) => Promise<ExportResult>
      cancelExport: (jobId: string) => Promise<{ success: boolean }>
      revealExport: (path: string) => Promise<{ success: boolean; error?: string }>
      onExportProgress: (callback: (progress: ExportJobProgress) => void) => () => void
      exportGroupReport: (request: GroupReportExportRequest) => Promise<GroupReportExportResult>
      listGeneratedReports: () => Promise<ReportHistoryResult>
      saveGeneratedReport: (
        request: SaveGeneratedReportRequest
      ) => Promise<SaveGeneratedReportResult>
      deleteGeneratedReport: (reportId: string) => Promise<DeleteGeneratedReportResult>
      revealGroupReport: (filePath: string) => Promise<{ success: boolean; error?: string }>
      getSavedDbKey: (accountRoot: string) => Promise<DatabaseKeyStorageResult>
      getDatabaseKeyEnvironment: () => Promise<DatabaseKeyEnvironment>
      readDatabaseKeyClipboard: () => Promise<{
        success: boolean
        value?: string
        error?: string
      }>
      autoGetDbKey: (
        accountRoot: string,
        options?: { save?: boolean }
      ) => Promise<{
        success: boolean
        key?: string
        error?: string
        code?: string
        saved?: boolean
        warning?: string
      }>
      autoGetImageKey: (options?: { save?: boolean }) => Promise<{
        success: boolean
        xorKey?: number
        aesKey?: string
        verified?: boolean
        error?: string
        imageXorKey?: string
        imageAesKey?: string
        settings?: {
          dbRoot: string
          apiEnabled: boolean
          apiHost: string
          apiPort: number
          imageKeyRoot: string
          ffmpegPath: string
          recallProtectionEnabled: boolean
          debugEnabled: boolean
          autoLogin: boolean
          autoLoginPreferenceSet: boolean
          appearanceTheme: 'system' | 'light' | 'dark'
          compactMode: boolean
          showStartupProgress: boolean
          imageXorKey: string
          imageAesKey: string
        }
      }>
      getImageKeyConfig: () => Promise<ImageKeyConfigResult>
      getImageDecryptionStatus: () => Promise<ImageDecryptionStatus>
      selectImageDecoder: () => Promise<ImageDecoderSelectionResult>
      getImageDecoderStatus: () => Promise<ImageDecoderStatus>
      openImageDecoderDownload: () => Promise<{ success: boolean; error?: string }>
      saveImageKeyConfig: (request: SaveImageKeyRequest) => Promise<ImageKeyConfigResult>
      testImageDecryption: (
        request: TestImageDecryptionRequest
      ) => Promise<ImageDecryptionTestResult>
      clearImageKeyConfig: () => Promise<{ success: boolean; error?: string }>
      pasteAndSaveDbKey: (
        accountRoot: string
      ) => Promise<{ success: boolean; key?: string; error?: string }>
      saveDbKey: (accountRoot: string, key: string) => Promise<DatabaseKeyStorageResult>
      clearSavedDbKey: (accountRoot: string) => Promise<{ success: boolean; error?: string }>
      onWcdbChange: (callback: (payload: { type: string; json: string }) => void) => () => void
      onDbKeyStatus: (callback: (payload: { message: string }) => void) => () => void
      onImageKeyStatus: (callback: (payload: { message: string }) => void) => () => void
      getSettings: () => Promise<{
        settings: {
          dbRoot: string
          apiEnabled: boolean
          apiHost: string
          apiPort: number
          imageKeyRoot: string
          ffmpegPath: string
          recallProtectionEnabled: boolean
          debugEnabled: boolean
          autoLogin: boolean
          autoLoginPreferenceSet: boolean
          appearanceTheme: 'system' | 'light' | 'dark'
          compactMode: boolean
          showStartupProgress: boolean
          imageXorKey: string
          imageAesKey: string
        }
        settingsPath: string
      }>
      setSettings: (
        patch: Partial<{
          dbRoot: string
          apiEnabled: boolean
          apiHost: string
          apiPort: number
          imageKeyRoot: string
          ffmpegPath: string
          recallProtectionEnabled: boolean
          debugEnabled: boolean
          autoLogin: boolean
          autoLoginPreferenceSet: boolean
          appearanceTheme: 'system' | 'light' | 'dark'
          compactMode: boolean
          showStartupProgress: boolean
          imageXorKey: string
          imageAesKey: string
        }>
      ) => Promise<{
        settings: {
          dbRoot: string
          apiEnabled: boolean
          apiHost: string
          apiPort: number
          imageKeyRoot: string
          ffmpegPath: string
          recallProtectionEnabled: boolean
          debugEnabled: boolean
          autoLogin: boolean
          autoLoginPreferenceSet: boolean
          appearanceTheme: 'system' | 'light' | 'dark'
          compactMode: boolean
          showStartupProgress: boolean
          imageXorKey: string
          imageAesKey: string
        }
        settingsPath: string
      }>
      getSelf: () => Promise<
        | {
            ready: true
            info: { wxid: string; nickname: string; avatar?: string; accountRoot: string }
          }
        | { ready: false }
      >
      testConnection: (key: string, accountRoot?: string) => Promise<DatabaseKeyValidationResult>
      reopenWithRoot: (accountRoot: string) => Promise<{
        success: boolean
        error?: string
        info?: { wxid: string; nickname: string; avatar?: string; accountRoot: string }
      }>
      selectDbRoot: () => Promise<{ canceled: boolean; path?: string }>
      openAccountRoot: () => Promise<{ success: boolean; error?: string }>
      disconnectDb: (options?: {
        closeNative?: boolean
      }) => Promise<{ success: boolean; error?: string }>
      apiStatus: () => Promise<{
        running: boolean
        host: string
        port: number
        error?: string
      }>
      apiTokenStatus: () => Promise<import('../shared/local-api-auth').ApiTokenStatus>
      revealApiToken: () => Promise<import('../shared/local-api-auth').ApiTokenRevealResult>
      copyApiToken: () => Promise<import('../shared/local-api-auth').ApiTokenActionResult>
      rotateApiToken: () => Promise<import('../shared/local-api-auth').ApiTokenActionResult>
      apiStart: (
        host?: string,
        port?: number
      ) => Promise<{ running: boolean; host: string; port: number; error?: string }>
      apiStop: () => Promise<{ running: boolean; host: string; port: number; error?: string }>
      apiToggle: (enabled: boolean) => Promise<{
        running: boolean
        host: string
        port: number
        error?: string
      }>
      getReaderSkillStatus: () => Promise<{
        available: boolean
        version?: string
        filePath?: string
        directoryPath?: string
        source: 'development' | 'bundled'
        githubUrl: string
        error?: string
      }>
      readReaderSkill: () => Promise<{ success: boolean; content?: string; error?: string }>
      revealReaderSkill: () => Promise<{ success: boolean; error?: string }>
      openReaderSkillGithub: () => Promise<{ success: boolean; error?: string }>
      testLocalApiRequest: (request: LocalApiTestRequest) => Promise<LocalApiTestResponse>
      copyLocalApiCurl: (
        request: LocalApiTestRequest
      ) => Promise<import('../shared/local-api-test').LocalApiCurlCopyResult>
      copyText: (text: string) => Promise<{ success: boolean; error?: string }>
      // ============================================================
      // AI 图片理解基础设施(ImageInsightService)
      // ============================================================
      imageListCandidates: (query: ImageCandidateQuery) => Promise<{
        success: boolean
        candidates: ImageCandidate[]
        error?: string
      }>
      imageAnalyze: (request: ImageAnalysisRequest) => Promise<ImageAnalysisResponse>
      getImageInsight: (imageHash: string) => Promise<{ success: boolean; insight?: ImageInsight }>
      listImageInsights: (
        sessionId: string,
        limit?: number
      ) => Promise<{ success: boolean; insights: ImageInsight[] }>
      getAgentHubStatus: () => Promise<AgentHubStatus>
      getAgentHubLogs: () => Promise<AgentHubLogEntry[]>
      clearAgentHubLogs: () => Promise<void>
      startAgentHubLogin: () => Promise<AgentHubActionResult>
      cancelAgentHubLogin: () => Promise<AgentHubActionResult>
      reconnectAgentHub: () => Promise<AgentHubActionResult>
      disconnectAgentHub: () => Promise<AgentHubActionResult>
      selectAgentHubTestImage: () => Promise<{ canceled: boolean; path?: string }>
      onAgentHubStatus: (callback: (status: AgentHubStatus) => void) => () => void
      onAgentHubLog: (callback: (entry: AgentHubLogEntry) => void) => () => void
    }
  }
}
