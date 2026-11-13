import fs from 'fs-extra'
import path from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { EXTENSION_IPC } from '../../shared/extensions/ipc'
import type {
  ExtensionInstallResult,
  ExtensionLogEntry,
  ExtensionOperationResult,
  ExtensionPageDescriptor,
  ExtensionPageRequest,
  ExtensionPageResponse,
  InstalledExtension
} from '../../shared/extensions/types'
import type { ExtensionManager } from './extension-manager'
import type { ExtensionPaths } from './extension-paths'

export interface ExtensionIpcOptions {
  /** 懒取：扩展系统在窗口创建之后才完成初始化。 */
  getManager: () => ExtensionManager
  paths: ExtensionPaths
  /** 扩展页面 IPC 的调用方必须是主窗口；其它 webContents 一律拒绝。 */
  isTrustedSender: (senderId: number) => boolean
}

/**
 * 注册扩展中心的 IPC。
 *
 * 所有入参都在这一层收敛类型与长度：渲染层与扩展页面都是「不可信输入」，
 * 不能把未校验的对象直接交给 manager。
 */
export function registerExtensionIpc(options: ExtensionIpcOptions): void {
  const { paths } = options
  const manager = (): ExtensionManager => options.getManager()
  const guard = <Args extends unknown[], Result>(
    handler: (...args: Args) => Promise<Result> | Result
  ): ((
    event: Electron.IpcMainInvokeEvent,
    ...args: Args
  ) => Promise<Result | { success: false; error: { code: string; message: string } }>) => {
    return async (event, ...args) => {
      if (!options.isTrustedSender(event.sender.id)) {
        return { success: false, error: { code: 'PERMISSION_DENIED', message: '不受信任的调用方' } }
      }
      try {
        return await handler(...args)
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'ACTION_FAILED',
            message: error instanceof Error ? error.message : '扩展操作失败'
          }
        }
      }
    }
  }

  ipcMain.handle(
    EXTENSION_IPC.list,
    guard((): InstalledExtension[] => manager().list())
  )

  ipcMain.handle(
    EXTENSION_IPC.detail,
    guard((extensionId: unknown): InstalledExtension | null =>
      manager().get(requireId(extensionId))
    )
  )

  ipcMain.handle(
    EXTENSION_IPC.pickDirectory,
    guard(async (): Promise<string | null> => {
      const window = BrowserWindow.getFocusedWindow()
      const result = window
        ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
    })
  )

  ipcMain.handle(
    EXTENSION_IPC.pickPackage,
    guard(async (): Promise<string | null> => {
      const window = BrowserWindow.getFocusedWindow()
      const options: Electron.OpenDialogOptions = {
        properties: ['openFile'],
        filters: [
          { name: 'TraceMemo 扩展包', extensions: ['zip', 'tmext'] },
          { name: '全部文件', extensions: ['*'] }
        ]
      }
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
    })
  )

  ipcMain.handle(
    EXTENSION_IPC.installDirectory,
    guard(
      (directory: unknown): Promise<ExtensionInstallResult> =>
        manager().installFromDirectory(requirePath(directory))
    )
  )

  ipcMain.handle(
    EXTENSION_IPC.installPackage,
    guard(
      (packagePath: unknown): Promise<ExtensionInstallResult> =>
        manager().installFromPackage(requirePath(packagePath))
    )
  )

  ipcMain.handle(
    EXTENSION_IPC.setEnabled,
    guard((payload: unknown): Promise<ExtensionOperationResult> => {
      const input = (payload ?? {}) as { id?: unknown; enabled?: unknown }
      return manager().setEnabled(requireId(input.id), input.enabled === true)
    })
  )

  ipcMain.handle(
    EXTENSION_IPC.uninstall,
    guard((payload: unknown): Promise<ExtensionOperationResult> => {
      const input = (payload ?? {}) as { id?: unknown; keepData?: unknown }
      return manager().uninstall(requireId(input.id), input.keepData !== false)
    })
  )

  ipcMain.handle(
    EXTENSION_IPC.logs,
    guard((payload: unknown): ExtensionLogEntry[] => {
      const input = (payload ?? {}) as { id?: unknown; limit?: unknown }
      const limit = Number(input.limit)
      return manager().getLogs(requireId(input.id), Number.isFinite(limit) ? limit : 100)
    })
  )

  ipcMain.handle(
    EXTENSION_IPC.clearLogs,
    guard((extensionId: unknown): { success: true } => {
      manager().clearLogs(requireId(extensionId))
      return { success: true }
    })
  )

  ipcMain.handle(
    EXTENSION_IPC.pageUrl,
    guard((payload: unknown): ExtensionPageDescriptor => {
      const input = (payload ?? {}) as { id?: unknown; pageId?: unknown }
      const pageId =
        typeof input.pageId === 'string' && input.pageId.trim() ? input.pageId.trim() : undefined
      return manager().pageUrl(requireId(input.id), pageId)
    })
  )

  ipcMain.handle(
    EXTENSION_IPC.pageRequest,
    guard((payload: unknown): Promise<ExtensionPageResponse> => {
      const request = (payload ?? {}) as Partial<ExtensionPageRequest>
      const extensionId = requireId(request.extensionId)
      const method = String(request.method || '')
      const params =
        request.params && typeof request.params === 'object' && !Array.isArray(request.params)
          ? (request.params as Record<string, unknown>)
          : {}
      return manager().pageRequest(extensionId, method, params)
    })
  )

  ipcMain.handle(
    EXTENSION_IPC.openDataDir,
    guard(async (extensionId: unknown): Promise<{ success: boolean; error?: string }> => {
      const id = requireId(extensionId)
      const directory = paths.extensionDataDir(id)
      fs.ensureDirSync(directory)
      const error = await shell.openPath(directory)
      return error ? { success: false, error } : { success: true }
    })
  )
}

function requireId(value: unknown): string {
  const id = String(value || '').trim()
  if (!/^[a-z0-9.-]{3,128}$/.test(id)) throw new Error('扩展 id 不合法')
  return id
}

function requirePath(value: unknown): string {
  const target = String(value || '').trim()
  if (!target || target.length > 4_096) throw new Error('路径不合法')
  if (!path.isAbsolute(target)) throw new Error('必须使用绝对路径')
  return target
}
