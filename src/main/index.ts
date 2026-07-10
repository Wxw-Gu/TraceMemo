import { app, shell, BrowserWindow, ipcMain, nativeImage, clipboard, Menu, Tray } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { WechatDb } from './wechat-db'
import { VoiceService } from './voice-service'
import { StickerService } from './sticker-service'
import { parseMessageContent } from './message-parser'
import { ImageDecryptService } from './image-decrypt-service'
import { exportGroupReport } from './group-report-service'
import { GroupReportExportRequest } from '../shared/group-report'
import { DatabaseKeyStore } from './database-key-store'
import { KeyServiceMac } from './key-service-mac'
import * as chat from './services/chat-service'
import {
  apiServer
} from './http-server'
import {
  loadSettings,
  saveSettings,
  getSettingsPath,
  AppSettings
} from './services/settings-store'
import { installSafeConsole } from './safe-log'

// electron-vite can close the child's stdout/stderr after spawning Electron.
// Plain console.error then throws EPIPE on a closed pipe and crashes the IPC
// handler. Wrap console.* before any other module logs anything.
installSafeConsole()

let voiceService: VoiceService | null = null
let imageDecryptService: ImageDecryptService | null = null
let stickerService: StickerService | null = null
const databaseKeyStore = new DatabaseKeyStore()
const keyServiceMac = new KeyServiceMac()
let tray: Tray | null = null
const BUILD_MARK = 'wechat4-local-http-api-2026-07-03'
const TRAY_MODE =
  process.argv.includes('--tray') || (process.env['WXE_TRAY'] || '').toString() === '1'

// WechatExplorer's WCDB native library runs InitProtection before wcdb_init.
// In dev, matching the host app name avoids failing the native protection gate.
app.setName('WechatExplorer')

function createWindow(): void {
  // 创建浏览器窗口
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 基于 electron-vite cli 的渲染器 HMR
  // 加载开发环境的远程 URL 或生产环境的本地 html 文件
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 当 Electron 完成初始化并准备好创建浏览器窗口时，将调用此方法
// 某些 API 只能在此事件发生后使用
app.whenReady().then(async () => {
  console.log(`WechatExplorer main build: ${BUILD_MARK}`)
  // 为窗口设置应用程序用户模型 ID
  electronApp.setAppUserModelId('com.electron')

  // 在开发环境中默认按 F12 打开或关闭 DevTools
  // 在生产环境中忽略 CommandOrControl + R
  // 参见 https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.handle('db:init', (_, key: string) => {
    try {
      const trimmedKey = String(key || '').trim()
      console.log(`db:init build=${BUILD_MARK} keyLength=${trimmedKey.length}`)
      const nextWechatDb = new WechatDb(key)
      chat.setChatDb(nextWechatDb)
      const wcdb4Client = nextWechatDb.getWcdb4Client()
      voiceService = new VoiceService(wcdb4Client)
      stickerService = new StickerService(wcdb4Client)
      const monitoring = wcdb4Client.startMonitor((type, json) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send('wcdb-change', { type, json })
        }
      })
      imageDecryptService = null
      return { success: true, monitoring }
    } catch (error) {
      console.error('Failed to init DB:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('key:getSavedDbKey', async () => databaseKeyStore.load())

  ipcMain.handle('key:pasteAndSaveDbKey', async () => {
    const clipboardKey = clipboard.readText().trim()
    return databaseKeyStore.save(clipboardKey)
  })

  ipcMain.handle('key:saveDbKey', async (_, key: string) => databaseKeyStore.save(String(key || '')))

  ipcMain.handle('key:clearSavedDbKey', async () => databaseKeyStore.clear())

  ipcMain.handle('key:autoGetDbKey', async (event) => {
    const result = await keyServiceMac.autoGetDbKey((message) => {
      if (!event.sender.isDestroyed()) event.sender.send('key:dbKeyStatus', { message })
    })
    if (!result.success || !result.key) return result

    const saved = await databaseKeyStore.save(result.key)
    return {
      ...result,
      saved: saved.success,
      warning: saved.success ? undefined : saved.error
    }
  })

  ipcMain.handle('db:getContacts', (_, filter?: string) => chat.listContacts(filter))

  ipcMain.handle('db:getMessages', (_, userMd5: string, startTime?: number, endTime?: number) =>
    chat.listMessages(userMd5, startTime, endTime)
  )

  ipcMain.handle('db:getGroupSnapshot', (_, userMd5: string) => chat.getGroupSnapshot(userMd5))

  ipcMain.handle('db:search', (_, keyword: string) => chat.searchMessages(keyword))

  ipcMain.handle(
    'ai:chat',
    async (
      _,
      messages: { role: string; content: string }[],
      options?: { apiKey?: string; model?: string; baseURL?: string }
    ) => {
      // @ts-ignore: vite env
      const apiKey = options?.apiKey || import.meta.env.VITE_DEEPSEEK_API_KEY
      const model = options?.model || import.meta.env.VITE_AI_MODEL || 'deepseek-v4-flash'
      const baseURL =
        options?.baseURL || import.meta.env.VITE_AI_BASE_URL || 'https://api.deepseek.com'

      if (!apiKey) {
        return { success: false, error: '未配置 API Key' }
      }

      // 动态导入以避免如果未安装或初始类型缺失的问题
      const { OpenAI } = await import('openai')

      const openai = new OpenAI({
        baseURL,
        apiKey
      })
      try {
        const completion = await openai.chat.completions.create({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: messages as any,
          model: model
        })
        return { success: true, data: completion.choices[0].message.content }
      } catch (error: unknown) {
        console.error('AI API Error:', error)
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        return { success: false, error: errorMessage }
      }
    }
  )

  ipcMain.handle('copy-image', async (_, base64String) => {
    try {
      const image = nativeImage.createFromDataURL(base64String)
      clipboard.writeImage(image)
      return { success: true }
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  ipcMain.handle('report:export', async (_, request: GroupReportExportRequest) => {
    return exportGroupReport(request)
  })

  ipcMain.handle('report:reveal', async (_, filePath: string) => {
    try {
      shell.showItemInFolder(filePath)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(
    'db:getVoiceData',
    async (_, sessionId: string, localId: number, createTime: number, svrId?: string | number) => {
      if (!voiceService) {
        return { success: false, error: 'VoiceService 未初始化' }
      }
      return voiceService.resolveVoice(sessionId, localId, createTime, svrId)
    }
  )

  ipcMain.handle('db:parseMessage', async (_, content: string, messageType: number) => {
    return parseMessageContent(content, messageType)
  })

  ipcMain.handle(
    'db:getImage',
    async (_, imageMd5?: string, imageDatNameOrThumb?: string | boolean, _sessionId?: string) => {
      void _sessionId
      if (!imageDecryptService) {
        // 从环境变量获取密钥
        const xorKey = import.meta.env.VITE_IMAGE_XOR_KEY || '0x40'
        const aesKey = import.meta.env.VITE_IMAGE_AES_KEY || ''
        if (!aesKey) {
          return { success: false, error: '未配置图片解密密钥' }
        }
        imageDecryptService = new ImageDecryptService(xorKey, aesKey, chat.getChatDb()?.getWcdb4Client())
      }

      const imageDatName = typeof imageDatNameOrThumb === 'string' ? imageDatNameOrThumb : undefined
      const filePath = imageDecryptService.findImageFile(imageMd5, imageDatName)
      if (!filePath) {
        return { success: false, error: '未找到图片文件' }
      }

      const base64 = imageDecryptService.decryptImageToBase64(filePath)
      if (!base64) {
        return { success: false, error: '图片解密失败' }
      }

      return { success: true, data: base64 }
    }
  )

  ipcMain.handle('db:getSticker', async (_, cdnUrl?: string, md5?: string) => {
    if (!stickerService) {
      stickerService = new StickerService(chat.getChatDb()?.getWcdb4Client())
    }
    return stickerService.resolveSticker(cdnUrl, md5)
  })

  // -------- Settings & API service --------

  ipcMain.handle('settings:get', () => ({
    settings: loadSettings(),
    settingsPath: getSettingsPath()
  }))

  ipcMain.handle('settings:set', (_, patch: Partial<AppSettings>) => {
    const merged = saveSettings({ ...loadSettings(), ...patch })
    return { settings: merged, settingsPath: getSettingsPath() }
  })

  ipcMain.handle('settings:getSelf', () => {
    const info = chat.getSelfAccountInfo()
    if (!info) return { ready: false }
    return { ready: true, info }
  })

  ipcMain.handle('db:testConnection', (_, key: string, accountRoot?: string) => {
    return chat.testConnection(key, accountRoot)
  })

  ipcMain.handle('db:reopenWithRoot', (_, accountRoot: string) => {
    const ok = chat.reopenWithRoot(accountRoot)
    if (!ok) return { success: false, error: '数据库未初始化或重新打开失败' }
    const info = chat.getSelfAccountInfo()
    return { success: true, info }
  })

  ipcMain.handle('api:getStatus', () => apiServer.getState())

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

  createWindow()

  // 启动本地 HTTP API(根据 settings.apiEnabled 控制)
  const settings = loadSettings()
  if (settings.apiEnabled) {
    await apiServer.start(settings.apiHost, settings.apiPort)
  }

  if (TRAY_MODE) {
    app.dock?.hide()
    setupTray()
  }

  app.on('activate', function () {
    // 在 macOS 上，当点击 dock 图标且没有其他窗口打开时，
    // 通常会在应用程序中重新创建一个窗口。
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 当所有窗口关闭时退出，除了 macOS。在那里，
// 应用程序及其菜单栏通常会保持活动状态，直到用户
// 显式使用 Cmd + Q 退出。
app.on('window-all-closed', () => {
  if (TRAY_MODE) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async () => {
  chat.setChatDb(null)
  await apiServer.stop().catch(() => undefined)
  if (tray) {
    tray.destroy()
    tray = null
  }
})

function showMainWindow(): void {
  if (TRAY_MODE) app.dock?.show().catch(() => undefined)
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
    {
      label: 'API 状态',
      click: () => showMainWindow()
    },
    { type: 'separator' },
    {
      label: '退出 WechatExplorer',
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
    const image = nativeImage.createFromPath(join(__dirname, '../../resources/icon.png'))
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
    tray.setToolTip('WechatExplorer')
    tray.setContextMenu(buildTrayMenu())
    tray.on('click', () => showMainWindow())
  } catch (error) {
    console.warn('[Tray] Failed to create tray:', error)
  }
}
