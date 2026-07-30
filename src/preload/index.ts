import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { GroupReportExportRequest } from '../shared/group-report'
import type { SaveGeneratedReportRequest } from '../shared/report-history'
import type {
  AIChatRequestOptions,
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
  clearCache: (scope: 'bootstrap' | 'electron' | 'all'): Promise<CacheSummary> =>
    ipcRenderer.invoke('cache:clear', scope),
  initDb: (key: string) => ipcRenderer.invoke('db:init', key),
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
  aiChat: (messages: { role: string; content: string }[], options?: AIChatRequestOptions) =>
    ipcRenderer.invoke('ai:chat', messages, options),
  listAIProviders: () => ipcRenderer.invoke('ai:listProviders'),
  getAIRuntimeConfig: () => ipcRenderer.invoke('ai:getRuntimeConfig'),
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
  parseMessage: (content: string, messageType: number) =>
    ipcRenderer.invoke('db:parseMessage', content, messageType),
  getImage: (
    imageMd5?: string,
    imageDatNameOrThumb?: string | boolean,
    sessionId?: string,
    options?: { force?: boolean; preferThumbnail?: boolean }
  ) => ipcRenderer.invoke('db:getImage', imageMd5, imageDatNameOrThumb, sessionId, options),
  getVideo: (hashes: string[]) => ipcRenderer.invoke('db:getVideo', hashes),
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
  getSavedDbKey: () => ipcRenderer.invoke('key:getSavedDbKey'),
  getDatabaseKeyEnvironment: () => ipcRenderer.invoke('key:getEnvironment'),
  readDatabaseKeyClipboard: () => ipcRenderer.invoke('key:readClipboardDbKey'),
  autoGetDbKey: (options?: { save?: boolean }) => ipcRenderer.invoke('key:autoGetDbKey', options),
  autoGetImageKey: (options?: { save?: boolean }) =>
    ipcRenderer.invoke('key:autoGetImageKey', options),
  getImageKeyConfig: () => ipcRenderer.invoke('image:getConfig'),
  getImageDecryptionStatus: () => ipcRenderer.invoke('image:getStatus'),
  saveImageKeyConfig: (request) => ipcRenderer.invoke('image:saveConfig', request),
  testImageDecryption: (request) => ipcRenderer.invoke('image:testConfig', request),
  clearImageKeyConfig: () => ipcRenderer.invoke('image:clearConfig'),
  pasteAndSaveDbKey: () => ipcRenderer.invoke('key:pasteAndSaveDbKey'),
  saveDbKey: (key: string) => ipcRenderer.invoke('key:saveDbKey', key),
  clearSavedDbKey: () => ipcRenderer.invoke('key:clearSavedDbKey'),
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
  apiStart: (host?: string, port?: number) => ipcRenderer.invoke('api:start', host, port),
  apiStop: () => ipcRenderer.invoke('api:stop'),
  apiToggle: (enabled: boolean) => ipcRenderer.invoke('api:toggle', enabled),
  getReaderSkillStatus: () => ipcRenderer.invoke('api:skillStatus'),
  readReaderSkill: () => ipcRenderer.invoke('api:readSkill'),
  revealReaderSkill: () => ipcRenderer.invoke('api:revealSkill'),
  openReaderSkillGithub: () => ipcRenderer.invoke('api:openSkillGithub'),
  testLocalApiRequest: (request) => ipcRenderer.invoke('api:testLocalRequest', request),
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
