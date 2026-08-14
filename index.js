"use strict";
const electron = require("electron");
const preload = require("@electron-toolkit/preload");
const api = {
  writeAppLog: (entry) => electron.ipcRenderer.invoke("app-log:write", entry),
  getAppLogPath: () => electron.ipcRenderer.invoke("app-log:getPath"),
  revealAppLog: () => electron.ipcRenderer.invoke("app-log:reveal"),
  getAppUpdateState: () => electron.ipcRenderer.invoke("app-update:getState"),
  checkAppUpdate: () => electron.ipcRenderer.invoke("app-update:check"),
  downloadAppUpdate: () => electron.ipcRenderer.invoke("app-update:download"),
  installAppUpdate: () => electron.ipcRenderer.invoke("app-update:install"),
  onAppUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    electron.ipcRenderer.on("app-update:state", listener);
    return () => electron.ipcRenderer.removeListener("app-update:state", listener);
  },
  getCacheSummary: () => electron.ipcRenderer.invoke("cache:getSummary"),
  clearCache: (scope) => electron.ipcRenderer.invoke("cache:clear", scope),
  initDb: (key) => electron.ipcRenderer.invoke("db:init", key),
  getBootstrapCache: () => electron.ipcRenderer.invoke("db:getBootstrapCache"),
  getStartupCache: () => electron.ipcRenderer.invoke("db:getStartupCache"),
  getContacts: (filter) => electron.ipcRenderer.invoke("db:getContacts", filter),
  getContactAvatars: (usernames) => electron.ipcRenderer.invoke("db:getContactAvatars", usernames),
  getCachedMessages: (userMd5, startTime, endTime) => electron.ipcRenderer.invoke("db:getCachedMessages", userMd5, startTime, endTime),
  getCachedMessagePage: (userMd5, startTime, endTime) => electron.ipcRenderer.invoke("db:getCachedMessagePage", userMd5, startTime, endTime),
  getMessages: (userMd5, startTime, endTime, options) => electron.ipcRenderer.invoke("db:getMessages", userMd5, startTime, endTime, options),
  getGroupSnapshot: (userMd5) => electron.ipcRenderer.invoke("db:getGroupSnapshot", userMd5),
  search: (keyword) => electron.ipcRenderer.invoke("db:search", keyword),
  aiChat: (messages, options) => electron.ipcRenderer.invoke("ai:chat", messages, options),
  listAIProviders: () => electron.ipcRenderer.invoke("ai:listProviders"),
  getAIRuntimeConfig: () => electron.ipcRenderer.invoke("ai:getRuntimeConfig"),
  saveAIProvider: (provider) => electron.ipcRenderer.invoke("ai:saveProvider", provider),
  deleteAIProvider: (providerId) => electron.ipcRenderer.invoke("ai:deleteProvider", providerId),
  setDefaultAIProvider: (providerId) => electron.ipcRenderer.invoke("ai:setDefaultProvider", providerId),
  testAIProvider: (providerId) => electron.ipcRenderer.invoke("ai:testProvider", providerId),
  testAIVision: (request) => electron.ipcRenderer.invoke("ai:testVision", request),
  migrateLegacyAIConfig: (config) => electron.ipcRenderer.invoke("ai:migrateLegacy", config),
  copyImage: (base64String) => electron.ipcRenderer.invoke("copy-image", base64String),
  getVoiceData: (sessionId, localId, createTime, svrId) => electron.ipcRenderer.invoke("db:getVoiceData", sessionId, localId, createTime, svrId),
  parseMessage: (content, messageType) => electron.ipcRenderer.invoke("db:parseMessage", content, messageType),
  getImage: (imageMd5, imageDatNameOrThumb, sessionId, options) => electron.ipcRenderer.invoke("db:getImage", imageMd5, imageDatNameOrThumb, sessionId, options),
  getVideo: (hashes) => electron.ipcRenderer.invoke("db:getVideo", hashes),
  getSticker: (cdnUrl, md5) => electron.ipcRenderer.invoke("db:getSticker", cdnUrl, md5),
  startExport: (request) => electron.ipcRenderer.invoke("export:start", request),
  cancelExport: (jobId) => electron.ipcRenderer.invoke("export:cancel", jobId),
  revealExport: (path) => electron.ipcRenderer.invoke("export:reveal", path),
  selectExportDirectory: () => electron.ipcRenderer.invoke("export:selectDirectory"),
  onExportProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    electron.ipcRenderer.on("export:progress", listener);
    return () => electron.ipcRenderer.removeListener("export:progress", listener);
  },
  exportGroupReport: (request) => electron.ipcRenderer.invoke("report:export", request),
  listGeneratedReports: () => electron.ipcRenderer.invoke("report:listGenerated"),
  saveGeneratedReport: (request) => electron.ipcRenderer.invoke("report:saveGenerated", request),
  deleteGeneratedReport: (reportId) => electron.ipcRenderer.invoke("report:deleteGenerated", reportId),
  revealGroupReport: (filePath) => electron.ipcRenderer.invoke("report:reveal", filePath),
  getSavedDbKey: () => electron.ipcRenderer.invoke("key:getSavedDbKey"),
  getDatabaseKeyEnvironment: () => electron.ipcRenderer.invoke("key:getEnvironment"),
  readDatabaseKeyClipboard: () => electron.ipcRenderer.invoke("key:readClipboardDbKey"),
  autoGetDbKey: (options) => electron.ipcRenderer.invoke("key:autoGetDbKey", options),
  autoGetImageKey: (options) => electron.ipcRenderer.invoke("key:autoGetImageKey", options),
  getImageKeyConfig: () => electron.ipcRenderer.invoke("image:getConfig"),
  getImageDecryptionStatus: () => electron.ipcRenderer.invoke("image:getStatus"),
  saveImageKeyConfig: (request) => electron.ipcRenderer.invoke("image:saveConfig", request),
  testImageDecryption: (request) => electron.ipcRenderer.invoke("image:testConfig", request),
  clearImageKeyConfig: () => electron.ipcRenderer.invoke("image:clearConfig"),
  pasteAndSaveDbKey: () => electron.ipcRenderer.invoke("key:pasteAndSaveDbKey"),
  saveDbKey: (key) => electron.ipcRenderer.invoke("key:saveDbKey", key),
  clearSavedDbKey: () => electron.ipcRenderer.invoke("key:clearSavedDbKey"),
  onWcdbChange: (callback) => {
    const listener = (_event, payload) => callback(payload);
    electron.ipcRenderer.on("wcdb-change", listener);
    return () => electron.ipcRenderer.removeListener("wcdb-change", listener);
  },
  onDbKeyStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    electron.ipcRenderer.on("key:dbKeyStatus", listener);
    return () => electron.ipcRenderer.removeListener("key:dbKeyStatus", listener);
  },
  onImageKeyStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    electron.ipcRenderer.on("key:imageKeyStatus", listener);
    return () => electron.ipcRenderer.removeListener("key:imageKeyStatus", listener);
  },
  getSettings: () => electron.ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => electron.ipcRenderer.invoke("settings:set", patch),
  getSelf: () => electron.ipcRenderer.invoke("settings:getSelf"),
  testConnection: (key, accountRoot) => electron.ipcRenderer.invoke("db:testConnection", key, accountRoot),
  reopenWithRoot: (accountRoot) => electron.ipcRenderer.invoke("db:reopenWithRoot", accountRoot),
  selectDbRoot: () => electron.ipcRenderer.invoke("settings:selectDbRoot"),
  openAccountRoot: () => electron.ipcRenderer.invoke("settings:openAccountRoot"),
  disconnectDb: (options) => electron.ipcRenderer.invoke("db:disconnect", options),
  apiStatus: () => electron.ipcRenderer.invoke("api:getStatus"),
  apiStart: (host, port) => electron.ipcRenderer.invoke("api:start", host, port),
  apiStop: () => electron.ipcRenderer.invoke("api:stop"),
  apiToggle: (enabled) => electron.ipcRenderer.invoke("api:toggle", enabled),
  getReaderSkillStatus: () => electron.ipcRenderer.invoke("api:skillStatus"),
  readReaderSkill: () => electron.ipcRenderer.invoke("api:readSkill"),
  revealReaderSkill: () => electron.ipcRenderer.invoke("api:revealSkill"),
  openReaderSkillGithub: () => electron.ipcRenderer.invoke("api:openSkillGithub"),
  testLocalApiRequest: (request) => electron.ipcRenderer.invoke("api:testLocalRequest", request),
  copyText: (text) => electron.ipcRenderer.invoke("api:copyText", text),
  // ============================================================
  // AI 图片理解基础设施(ImageInsightService)
  // ============================================================
  imageListCandidates: (query) => electron.ipcRenderer.invoke("image:listCandidates", query),
  imageAnalyze: (request) => electron.ipcRenderer.invoke("image:analyze", request),
  getImageInsight: (imageHash) => electron.ipcRenderer.invoke("image:getInsight", imageHash),
  listImageInsights: (sessionId, limit) => electron.ipcRenderer.invoke("image:listInsights", sessionId, limit),
  getAgentHubStatus: () => electron.ipcRenderer.invoke("agent-hub:getStatus"),
  getAgentHubLogs: () => electron.ipcRenderer.invoke("agent-hub:getLogs"),
  clearAgentHubLogs: () => electron.ipcRenderer.invoke("agent-hub:clearLogs"),
  startAgentHubLogin: () => electron.ipcRenderer.invoke("agent-hub:startLogin"),
  cancelAgentHubLogin: () => electron.ipcRenderer.invoke("agent-hub:cancelLogin"),
  reconnectAgentHub: () => electron.ipcRenderer.invoke("agent-hub:reconnect"),
  disconnectAgentHub: () => electron.ipcRenderer.invoke("agent-hub:disconnect"),
  selectAgentHubTestImage: () => electron.ipcRenderer.invoke("agent-hub:selectTestImage"),
  onAgentHubStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    electron.ipcRenderer.on("agent-hub:status", listener);
    return () => electron.ipcRenderer.removeListener("agent-hub:status", listener);
  },
  onAgentHubLog: (callback) => {
    const listener = (_event, entry) => callback(entry);
    electron.ipcRenderer.on("agent-hub:log", listener);
    return () => electron.ipcRenderer.removeListener("agent-hub:log", listener);
  }
};
if (process.contextIsolated) {
  try {
    electron.contextBridge.exposeInMainWorld("electron", preload.electronAPI);
    electron.contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  window.electron = preload.electronAPI;
  window.api = api;
}
