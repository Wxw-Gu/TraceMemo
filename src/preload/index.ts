import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { GroupReportExportRequest } from '../shared/group-report'
import type { SaveGeneratedReportRequest } from '../shared/report-history'
import type {
  AIChatRequestOptions,
  AiSearchExternalAuthorizationRequest,
  AiSearchExternalAuthorizationResult,
  AiSearchProviderStatus,
  AIProviderConfig,
  AIVisionTestRequest,
  LegacyAIConfig
} from '../shared/ai-provider'
import type {
  ImageAnalysisRequest,
  ImageAnalysisResponse,
  ImageCandidate,
  ImageCandidateQuery,
  ImageInsight
} from '../shared/image-insight'
import type { AgentHubLogEntry, AgentHubStatus } from '../shared/agent-hub'
import type { AppLogEntry } from '../shared/app-log'
import type { AppUpdateState } from '../shared/app-update'
import type { CacheSummary } from '../shared/cache'
import type { ExportRequest, ExportJobProgress } from '../shared/export'
import type { ImageDecoderSelectionResult, ImageDecoderStatus } from '../shared/image-decryption'
import type { AccountDiscoveryResult } from '../shared/database-key'
import type {
  VoiceBatchConversationSummary,
  VoiceBatchPreflight,
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

// 渲染器的自定义 API
const api = {
  writeAppLog: (entry: AppLogEntry) => ipcRenderer.invoke('app-log:write', entry),
  getAppLogPath: () => ipcRenderer.invoke('app-log:getPath'),
  revealAppLog: () => ipcRenderer.invoke('app-log:reveal'),
  getAppUpdateState: (): Promise<AppUpdateState> => ipcRenderer.invoke('app-update:getState'),
  checkAppUpdate: () => ipcRenderer.invoke('app-update:check'),
  downloadAppUpdate: () => ipcRenderer.invoke('app-update:download'),
  installAppUpdate: () => ipcRenderer.invoke('app-update:install'),
  onAppUpdateState: (callback: (state: AppUpdateState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppUpdateState): void =>
      callback(state)
    ipcRenderer.on('app-update:state', listener)
    return () => ipcRenderer.removeListener('app-update:state', listener)
  },
  getCacheSummary: (): Promise<CacheSummary> => ipcRenderer.invoke('cache:getSummary'),
  clearCache: (scope: 'bootstrap' | 'electron' | 'knowledge' | 'all'): Promise<CacheSummary> =>
    ipcRenderer.invoke('cache:clear', scope),
  openKnowledgeDirectory: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('cache:openKnowledgeDirectory'),
  initDb: (key: string, accountRoot: string) => ipcRenderer.invoke('db:init', key, accountRoot),
  discoverAccounts: (inputPath: string): Promise<AccountDiscoveryResult> =>
    ipcRenderer.invoke('accounts:discover', inputPath),
  getBootstrapCache: () => ipcRenderer.invoke('db:getBootstrapCache'),
  getStartupCache: () => ipcRenderer.invoke('db:getStartupCache'),
  getContacts: (filter?: string) => ipcRenderer.invoke('db:getContacts', filter),
  getContactAvatars: (usernames: string[]) => ipcRenderer.invoke('db:getContactAvatars', usernames),
  getCachedMessages: (userMd5: string, startTime?: number, endTime?: number) =>
    ipcRenderer.invoke('db:getCachedMessages', userMd5, startTime, endTime),
  getCachedMessagePage: (userMd5: string, startTime?: number, endTime?: number) =>
    ipcRenderer.invoke('db:getCachedMessagePage', userMd5, startTime, endTime),
  getMessages: (
    userMd5: string,
    startTime?: number,
    endTime?: number,
    options?: { limit?: number }
  ) => ipcRenderer.invoke('db:getMessages', userMd5, startTime, endTime, options),
  getGroupSnapshot: (userMd5: string) => ipcRenderer.invoke('db:getGroupSnapshot', userMd5),
  search: (keyword: string) => ipcRenderer.invoke('db:search', keyword),
  searchKnowledge: (request: KnowledgeSearchIpcRequest): Promise<KnowledgeSearchIpcResult> =>
    ipcRenderer.invoke('knowledge:search', request),
  runAiSearch: (request: AiSearchPipelineRequest): Promise<AiSearchPipelineResult> =>
    ipcRenderer.invoke('ai-search:run', request),
  cancelAiSearch: (requestId: string): Promise<AiSearchCancelResult> =>
    ipcRenderer.invoke('ai-search:cancel', requestId),
  onAiSearchProgress: (callback: (progress: AiSearchProgressEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: AiSearchProgressEvent): void =>
      callback(progress)
    ipcRenderer.on('ai-search:progress', listener)
    return () => ipcRenderer.removeListener('ai-search:progress', listener)
  },
  getKnowledgeStatus: (): Promise<KnowledgeRuntimeStatus> =>
    ipcRenderer.invoke('knowledge:getStatus'),
  startKnowledgeIndex: (): Promise<KnowledgeRuntimeStatus> =>
    ipcRenderer.invoke('knowledge:startIndex'),
  onKnowledgeStatus: (callback: (status: KnowledgeRuntimeStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: KnowledgeRuntimeStatus): void =>
      callback(status)
    ipcRenderer.on('knowledge:status', listener)
    return () => ipcRenderer.removeListener('knowledge:status', listener)
  },
  aiChat: (messages: { role: string; content: string }[], options?: AIChatRequestOptions) =>
    ipcRenderer.invoke('ai:chat', messages, options),
  listAIProviders: () => ipcRenderer.invoke('ai:listProviders'),
  getAIRuntimeConfig: () => ipcRenderer.invoke('ai:getRuntimeConfig'),
  getAiSearchProviderStatus: (): Promise<AiSearchProviderStatus> =>
    ipcRenderer.invoke('ai-search:getProviderStatus'),
  authorizeAiSearchExternalProvider: (
    request: AiSearchExternalAuthorizationRequest
  ): Promise<AiSearchExternalAuthorizationResult> =>
    ipcRenderer.invoke('ai-search:authorizeExternalProvider', request),
  saveAIProvider: (provider: AIProviderConfig) => ipcRenderer.invoke('ai:saveProvider', provider),
  deleteAIProvider: (providerId: string) => ipcRenderer.invoke('ai:deleteProvider', providerId),
  setDefaultAIProvider: (providerId: string) =>
    ipcRenderer.invoke('ai:setDefaultProvider', providerId),
  testAIProvider: (providerId: string) => ipcRenderer.invoke('ai:testProvider', providerId),
  testAIVision: (request: AIVisionTestRequest) => ipcRenderer.invoke('ai:testVision', request),
  migrateLegacyAIConfig: (config: LegacyAIConfig) => ipcRenderer.invoke('ai:migrateLegacy', config),
  copyImage: (base64String) => ipcRenderer.invoke('copy-image', base64String),
  getVoiceData: (sessionId: string, localId: number, createTime: number, svrId?: string | number) =>
    ipcRenderer.invoke('db:getVoiceData', sessionId, localId, createTime, svrId),
  getVoiceModelStatus: (): Promise<VoiceModelStatus> => ipcRenderer.invoke('voice:getModelStatus'),
  downloadVoiceModel: (): Promise<VoiceModelDownloadResult> =>
    ipcRenderer.invoke('voice:downloadModel'),
  cancelVoiceModelDownload: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('voice:cancelModelDownload'),
  removeVoiceModel: (): Promise<VoiceModelStatus> => ipcRenderer.invoke('voice:removeModel'),
  openVoiceModelDirectory: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('voice:openModelDirectory'),
  recognizeVoice: (reference: VoiceMessageReference): Promise<VoiceRecognitionResult> =>
    ipcRenderer.invoke('voice:recognize', reference),
  getVoiceTranscriptSnapshot: (
    reference: VoiceMessageReference
  ): Promise<VoiceTranscriptSnapshot> =>
    ipcRenderer.invoke('voice:getTranscriptSnapshot', reference),
  cancelVoiceRecognition: (reference: VoiceMessageReference): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('voice:cancelRecognition', reference),
  getVoiceBatchPreflight: (request: VoiceBatchRequest): Promise<VoiceBatchPreflight> =>
    ipcRenderer.invoke('voice:getBatchPreflight', request),
  getVoiceBatchConversationSummaries: (
    request: VoiceBatchRequest
  ): Promise<VoiceBatchConversationSummary[]> =>
    ipcRenderer.invoke('voice:getBatchConversationSummaries', request),
  getVoiceBatchProgress: (): Promise<VoiceBatchProgress | undefined> =>
    ipcRenderer.invoke('voice:getBatchProgress'),
  startVoiceBatch: (request: VoiceBatchRequest): Promise<VoiceBatchProgress> =>
    ipcRenderer.invoke('voice:startBatch', request),
  cancelVoiceBatch: (): Promise<{ success: boolean }> => ipcRenderer.invoke('voice:cancelBatch'),
  retryFailedVoiceBatch: (): Promise<VoiceBatchProgress> =>
    ipcRenderer.invoke('voice:retryFailedBatch'),
  onVoiceBatchProgress: (callback: (progress: VoiceBatchProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: VoiceBatchProgress): void =>
      callback(progress)
    ipcRenderer.on('voice:batchProgress', listener)
    return () => ipcRenderer.removeListener('voice:batchProgress', listener)
  },
  onVoiceModelProgress: (callback: (status: VoiceModelProgressEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: VoiceModelProgressEvent): void =>
      callback(status)
    ipcRenderer.on('voice:modelProgress', listener)
    return () => ipcRenderer.removeListener('voice:modelProgress', listener)
  },
  parseMessage: (content: string, messageType: number) =>
    ipcRenderer.invoke('db:parseMessage', content, messageType),
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
  ) => ipcRenderer.invoke('db:getImage', imageMd5, imageDatNameOrThumb, sessionId, options),
  getVideo: (
    hashes: string[],
    options?: {
      createTime?: number
      byteLength?: number
      duration?: number
      width?: number
      height?: number
    }
  ) => ipcRenderer.invoke('db:getVideo', hashes, options),
  getSticker: (cdnUrl?: string, md5?: string) => ipcRenderer.invoke('db:getSticker', cdnUrl, md5),
  startExport: (request: ExportRequest) => ipcRenderer.invoke('export:start', request),
  cancelExport: (jobId: string) => ipcRenderer.invoke('export:cancel', jobId),
  revealExport: (path: string) => ipcRenderer.invoke('export:reveal', path),
  onExportProgress: (callback: (progress: ExportJobProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ExportJobProgress): void =>
      callback(progress)
    ipcRenderer.on('export:progress', listener)
    return () => ipcRenderer.removeListener('export:progress', listener)
  },
  exportGroupReport: (request: GroupReportExportRequest) =>
    ipcRenderer.invoke('report:export', request),
  listGeneratedReports: () => ipcRenderer.invoke('report:listGenerated'),
  saveGeneratedReport: (request: SaveGeneratedReportRequest) =>
    ipcRenderer.invoke('report:saveGenerated', request),
  deleteGeneratedReport: (reportId: string) =>
    ipcRenderer.invoke('report:deleteGenerated', reportId),
  revealGroupReport: (filePath: string) => ipcRenderer.invoke('report:reveal', filePath),
  getSavedDbKey: (accountRoot: string) => ipcRenderer.invoke('key:getSavedDbKey', accountRoot),
  getDatabaseKeyEnvironment: () => ipcRenderer.invoke('key:getEnvironment'),
  readDatabaseKeyClipboard: () => ipcRenderer.invoke('key:readClipboardDbKey'),
  autoGetDbKey: (accountRoot: string, options?: { save?: boolean }) =>
    ipcRenderer.invoke('key:autoGetDbKey', accountRoot, options),
  autoGetImageKey: (options?: { save?: boolean }) =>
    ipcRenderer.invoke('key:autoGetImageKey', options),
  getImageKeyConfig: () => ipcRenderer.invoke('image:getConfig'),
  getImageDecryptionStatus: () => ipcRenderer.invoke('image:getStatus'),
  selectImageDecoder: (): Promise<ImageDecoderSelectionResult> =>
    ipcRenderer.invoke('image:selectDecoder'),
  getImageDecoderStatus: (): Promise<ImageDecoderStatus> =>
    ipcRenderer.invoke('image:getDecoderStatus'),
  openImageDecoderDownload: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('image:openDecoderDownload'),
  saveImageKeyConfig: (request) => ipcRenderer.invoke('image:saveConfig', request),
  testImageDecryption: (request) => ipcRenderer.invoke('image:testConfig', request),
  clearImageKeyConfig: () => ipcRenderer.invoke('image:clearConfig'),
  pasteAndSaveDbKey: (accountRoot: string) =>
    ipcRenderer.invoke('key:pasteAndSaveDbKey', accountRoot),
  saveDbKey: (accountRoot: string, key: string) =>
    ipcRenderer.invoke('key:saveDbKey', accountRoot, key),
  clearSavedDbKey: (accountRoot: string) => ipcRenderer.invoke('key:clearSavedDbKey', accountRoot),
  onWcdbChange: (callback: (payload: { type: string; json: string }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { type: string; json: string }
    ): void => callback(payload)
    ipcRenderer.on('wcdb-change', listener)
    return () => ipcRenderer.removeListener('wcdb-change', listener)
  },
  onDbKeyStatus: (callback: (payload: { message: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { message: string }): void =>
      callback(payload)
    ipcRenderer.on('key:dbKeyStatus', listener)
    return () => ipcRenderer.removeListener('key:dbKeyStatus', listener)
  },
  onImageKeyStatus: (callback: (payload: { message: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { message: string }): void =>
      callback(payload)
    ipcRenderer.on('key:imageKeyStatus', listener)
    return () => ipcRenderer.removeListener('key:imageKeyStatus', listener)
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getSelf: () => ipcRenderer.invoke('settings:getSelf'),
  testConnection: (key: string, accountRoot?: string) =>
    ipcRenderer.invoke('db:testConnection', key, accountRoot),
  reopenWithRoot: (accountRoot: string) => ipcRenderer.invoke('db:reopenWithRoot', accountRoot),
  selectDbRoot: () => ipcRenderer.invoke('settings:selectDbRoot'),
  openAccountRoot: () => ipcRenderer.invoke('settings:openAccountRoot'),
  disconnectDb: (options?: { closeNative?: boolean }) =>
    ipcRenderer.invoke('db:disconnect', options),
  apiStatus: () => ipcRenderer.invoke('api:getStatus'),
  apiTokenStatus: () => ipcRenderer.invoke('api:tokenStatus'),
  revealApiToken: () => ipcRenderer.invoke('api:revealToken'),
  copyApiToken: () => ipcRenderer.invoke('api:copyToken'),
  rotateApiToken: () => ipcRenderer.invoke('api:rotateToken'),
  apiStart: (host?: string, port?: number) => ipcRenderer.invoke('api:start', host, port),
  apiStop: () => ipcRenderer.invoke('api:stop'),
  apiToggle: (enabled: boolean) => ipcRenderer.invoke('api:toggle', enabled),
  getReaderSkillStatus: () => ipcRenderer.invoke('api:skillStatus'),
  readReaderSkill: () => ipcRenderer.invoke('api:readSkill'),
  revealReaderSkill: () => ipcRenderer.invoke('api:revealSkill'),
  openReaderSkillGithub: () => ipcRenderer.invoke('api:openSkillGithub'),
  testLocalApiRequest: (request) => ipcRenderer.invoke('api:testLocalRequest', request),
  copyLocalApiCurl: (request) => ipcRenderer.invoke('api:copyCurl', request),
  copyText: (text: string) => ipcRenderer.invoke('api:copyText', text),
  // ============================================================
  // AI 图片理解基础设施(ImageInsightService)
  // ============================================================
  imageListCandidates: (
    query: ImageCandidateQuery
  ): Promise<{
    success: boolean
    candidates: ImageCandidate[]
    error?: string
  }> => ipcRenderer.invoke('image:listCandidates', query),
  imageAnalyze: (request: ImageAnalysisRequest): Promise<ImageAnalysisResponse> =>
    ipcRenderer.invoke('image:analyze', request),
  getImageInsight: (imageHash: string): Promise<{ success: boolean; insight?: ImageInsight }> =>
    ipcRenderer.invoke('image:getInsight', imageHash),
  listImageInsights: (
    sessionId: string,
    limit?: number
  ): Promise<{ success: boolean; insights: ImageInsight[] }> =>
    ipcRenderer.invoke('image:listInsights', sessionId, limit),
  getAgentHubStatus: () => ipcRenderer.invoke('agent-hub:getStatus'),
  getAgentHubLogs: () => ipcRenderer.invoke('agent-hub:getLogs'),
  clearAgentHubLogs: () => ipcRenderer.invoke('agent-hub:clearLogs'),
  startAgentHubLogin: () => ipcRenderer.invoke('agent-hub:startLogin'),
  cancelAgentHubLogin: () => ipcRenderer.invoke('agent-hub:cancelLogin'),
  reconnectAgentHub: () => ipcRenderer.invoke('agent-hub:reconnect'),
  disconnectAgentHub: () => ipcRenderer.invoke('agent-hub:disconnect'),
  selectAgentHubTestImage: () => ipcRenderer.invoke('agent-hub:selectTestImage'),
  onAgentHubStatus: (callback: (status: AgentHubStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: AgentHubStatus): void =>
      callback(status)
    ipcRenderer.on('agent-hub:status', listener)
    return () => ipcRenderer.removeListener('agent-hub:status', listener)
  },
  onAgentHubLog: (callback: (entry: AgentHubLogEntry) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: AgentHubLogEntry): void =>
      callback(entry)
    ipcRenderer.on('agent-hub:log', listener)
    return () => ipcRenderer.removeListener('agent-hub:log', listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
