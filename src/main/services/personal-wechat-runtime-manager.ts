import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { app, net } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { chmod, copyFile, cp, mkdir, mkdtemp, open, rename, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { promisify } from 'util'
import type {
  PersonalWechatRuntimeDownloadResult,
  PersonalWechatRuntimeStatus
} from '../../shared/personal-wechat-runtime'
import { findPersonalWechatRuntime } from './personal-wechat-send-service'

const execFileAsync = promisify(execFile)
const RUNTIME_VERSION = 'v0.0.18'
const ARCHIVE_NAME = 'onebot_mac_arm64.tar.gz'
const ARCHIVE_URL = `https://github.com/yincongcyincong/wechat_chatter/releases/download/${RUNTIME_VERSION}/${ARCHIVE_NAME}`
const ARCHIVE_SIZE = 66_599_785
const ARCHIVE_SHA256 = 'ee1e11bccef7cec1cf944cd8b2ac3fadaadb9376ba24cd823e3409143e107dab'

function patchPerSendPayload(scriptPath: string): void {
  let source = readFileSync(scriptPath, 'utf8')
  if (source.includes('var activeTriggerX1Payload = ptr(0);')) return

  const declarations = 'var triggerX1Payload;\nvar triggerX0;'
  const patchedDeclarations =
    'var triggerX1Payload;\nvar activeTriggerX1Payload = ptr(0);\nvar triggerX0;'
  const originalSend = `    const payloadData = hexToByteArray(payloadHex);
    triggerX1Payload.writeByteArray(payloadData);
    triggerX1Payload.add(0x18).writePointer(info.cgiAddr);
    triggerX1Payload.add(0xb8).writePointer(triggerX1Payload.add(0xc0));
    triggerX1Payload.add(0x190).writePointer(triggerX1Payload.add(0x198));`
  const patchedSend = `    const payloadData = hexToByteArray(payloadHex);
    activeTriggerX1Payload = Memory.alloc(payloadData.length);
    activeTriggerX1Payload.writeByteArray(payloadData);
    activeTriggerX1Payload.add(0x18).writePointer(info.cgiAddr);
    activeTriggerX1Payload.add(0xb8).writePointer(activeTriggerX1Payload.add(0xc0));
    activeTriggerX1Payload.add(0x190).writePointer(activeTriggerX1Payload.add(0x198));`

  if (!source.includes(declarations) || !source.includes(originalSend)) {
    throw new Error('下载的发送组件与当前应用不兼容')
  }
  source = source.replace(declarations, patchedDeclarations).replace(originalSend, patchedSend)
  source = source.replace(
    '        MMStartTask(triggerX0, triggerX1Payload);',
    '        MMStartTask(triggerX0, activeTriggerX1Payload);'
  )
  source = source.replace(
    '    } catch (e) {\n        console.error("[!] Error trigger " + msgType + " MMStartTask: " + e);',
    '    } catch (e) {\n        activeTriggerX1Payload = ptr(0);\n        console.error("[!] Error trigger " + msgType + " MMStartTask: " + e);'
  )
  source = source.replace(
    '\t\t\t\tpendingSendMsgType = "";\n\t\t\t\treturn',
    '\t\t\t\tpendingSendMsgType = "";\n\t\t\t\tactiveTriggerX1Payload = ptr(0);\n\t\t\t\treturn'
  )
  writeFileSync(scriptPath, source)
}

function patchImageHookReadiness(scriptPath: string): void {
  let source = readFileSync(scriptPath, 'utf8')
  if (
    source.includes('捕获到图片上传上下文，uploadGlobalX0') &&
    source.includes('图片上传 Hook Setup Complete')
  ) {
    return
  }
  const original = `\t\t\tuploadGlobalX0 = this.context.x0;`
  const patched = `\t\t\tconst capturedUploadX0 = this.context.x0;
\t\t\tif (uploadGlobalX0.equals(ptr(0)) && !capturedUploadX0.equals(ptr(0))) {
\t\t\t\tconsole.log("[+] 捕获到图片上传上下文，uploadGlobalX0：" + capturedUploadX0);
\t\t\t}
\t\t\tuploadGlobalX0 = capturedUploadX0;`
  if (!source.includes(original)) throw new Error('下载的媒体组件与当前应用不兼容')
  source = source.replace(original, patched)
  source = source.replace(
    '    })\n}\n\n\n\nfunction patchCdnOnComplete()',
    '    })\n    console.log("[+] 图片上传 Hook Setup Complete.");\n}\n\n\n\nfunction patchCdnOnComplete()'
  )
  writeFileSync(scriptPath, source)
}

function patchWechatCoreModuleBase(scriptPath: string): void {
  let source = readFileSync(scriptPath, 'utf8')
  if (source.includes('WeChat core module base:')) return
  const initMarker = 'function initAddresses() {'
  const initIndex = source.indexOf(initMarker)
  if (initIndex < 0 || !source.startsWith('var targetPath = ')) {
    throw new Error('下载的微信版本配置与当前应用不兼容')
  }
  const patchedHeader = `var targetPath = "/Applications/WeChat.app/Contents/Resources/wechat.dylib";
var module = Process.enumerateModules().find(function(m) {
    return m.path === targetPath || m.path.endsWith("/Contents/Resources/wechat.dylib");
});
if (!module) {
    throw new Error("[-] Cannot find WeChat core module: " + targetPath);
}
var moduleBase = module.base;
var baseAddr = moduleBase;
console.log("[+] WeChat core module base: " + baseAddr + " path=" + module.path);
setImmediate(initAddresses);

`
  source = patchedHeader + source.slice(initIndex)
  writeFileSync(scriptPath, source)
}

function addModifiedWorkNotice(scriptPath: string): void {
  let source = readFileSync(scriptPath, 'utf8')
  if (source.includes('TraceMemo wechat_chatter compatibility modifications')) return
  source = `/*
 * TraceMemo wechat_chatter compatibility modifications
 * Modified: 2026-08-17
 * Upstream: https://github.com/yincongcyincong/wechat_chatter
 * Runtime version: v0.0.18
 * License: GNU General Public License version 3 (GPL-3.0)
 * Changes: WeChat module discovery, per-send payload isolation, and image Hook readiness logging.
 * These modifications are not provided by the upstream author.
 */

${source}`
  writeFileSync(scriptPath, source)
}

export class PersonalWechatRuntimeManager {
  private downloadController: AbortController | null = null
  private downloadPromise: Promise<PersonalWechatRuntimeDownloadResult> | null = null
  private downloadedBytes = 0
  private lastProgressAt = 0
  private progressListener: ((status: PersonalWechatRuntimeStatus) => void) | null = null

  get directory(): string {
    return join(app.getPath('userData'), 'connectors', 'wechat-personal', 'darwin-arm64')
  }

  private get archivePath(): string {
    return join(
      app.getPath('userData'),
      'downloads',
      `wechat-chatter-${RUNTIME_VERSION}-${ARCHIVE_NAME}`
    )
  }

  setProgressListener(listener: ((status: PersonalWechatRuntimeStatus) => void) | null): void {
    this.progressListener = listener
  }

  async getStatus(): Promise<PersonalWechatRuntimeStatus> {
    if (!this.isSupported()) {
      return this.buildStatus(
        'unsupported',
        0,
        process.platform === 'win32'
          ? 'Windows 暂不支持个人微信发送组件'
          : `当前系统暂不支持个人微信发送组件：${process.platform} ${process.arch}`
      )
    }
    if (this.downloadPromise) return this.buildStatus('downloading', this.downloadedBytes)

    const runtime = findPersonalWechatRuntime()
    if (runtime) {
      return this.buildStatus('ready', ARCHIVE_SIZE, undefined, runtime.root)
    }

    const hasPartialInstall = await this.hasPartialInstall()
    return this.buildStatus(
      hasPartialInstall ? 'invalid' : 'missing',
      0,
      hasPartialInstall ? '发送组件文件不完整，请重新下载' : undefined,
      hasPartialInstall ? this.directory : undefined
    )
  }

  download(): Promise<PersonalWechatRuntimeDownloadResult> {
    if (!this.isSupported()) {
      return this.getStatus().then((status) => ({ success: false, status, error: status.error }))
    }
    if (this.downloadPromise) return this.downloadPromise
    this.downloadedBytes = 0
    this.downloadController = new AbortController()
    this.downloadPromise = this.runDownload(this.downloadController.signal).finally(() => {
      this.downloadPromise = null
      this.downloadController = null
    })
    return this.downloadPromise
  }

  cancelDownload(): boolean {
    if (!this.downloadController) return false
    this.downloadController.abort()
    return true
  }

  async remove(): Promise<PersonalWechatRuntimeStatus> {
    if (this.downloadPromise) return this.buildStatus('downloading', this.downloadedBytes)
    await Promise.all([
      rm(this.directory, { recursive: true, force: true }),
      rm(this.archivePath, { force: true }),
      rm(`${this.archivePath}.partial`, { force: true })
    ])
    return this.getStatus()
  }

  private async runDownload(signal: AbortSignal): Promise<PersonalWechatRuntimeDownloadResult> {
    const archive = this.archivePath
    const downloadsDirectory = dirname(archive)
    const partial = `${archive}.partial`
    let extractionDirectory = ''
    let stagedDirectory = ''
    try {
      await mkdir(downloadsDirectory, { recursive: true })
      await rm(partial, { force: true })
      const response = await net.fetch(ARCHIVE_URL, { signal })
      if (!response.ok || !response.body) {
        throw new Error(`发送组件下载失败：HTTP ${response.status}`)
      }

      const handle = await open(partial, 'w')
      const hash = createHash('sha256')
      try {
        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError')
          const chunk = Buffer.from(value)
          await handle.write(chunk)
          hash.update(chunk)
          this.downloadedBytes += chunk.length
          this.reportProgress(this.buildStatus('downloading', this.downloadedBytes))
        }
      } finally {
        await handle.close()
      }

      if (this.downloadedBytes !== ARCHIVE_SIZE || hash.digest('hex') !== ARCHIVE_SHA256) {
        throw new Error('发送组件校验失败，请重新下载')
      }
      await rm(archive, { force: true })
      await rename(partial, archive)

      extractionDirectory = await mkdtemp(join(tmpdir(), 'wechat-chatter-extract-'))
      await execFileAsync('/usr/bin/tar', ['-xzf', archive, '-C', extractionDirectory])
      stagedDirectory = `${this.directory}.installing-${process.pid}`
      await rm(stagedDirectory, { recursive: true, force: true })
      await mkdir(dirname(stagedDirectory), { recursive: true })
      await mkdir(join(stagedDirectory, 'onebot'), { recursive: true })

      const sourceOneBot = join(extractionDirectory, 'onebot')
      const sourceVersions = join(extractionDirectory, 'wechat_version')
      await Promise.all([
        cp(sourceVersions, join(stagedDirectory, 'wechat_version'), {
          recursive: true,
          force: true
        }),
        copyFile(join(sourceOneBot, 'onebot'), join(stagedDirectory, 'onebot', 'onebot')),
        copyFile(join(sourceOneBot, 'script.js'), join(stagedDirectory, 'onebot', 'script.js'))
      ])

      const executable = join(stagedDirectory, 'onebot', 'onebot')
      const script = join(stagedDirectory, 'onebot', 'script.js')
      patchWechatCoreModuleBase(script)
      patchPerSendPayload(script)
      patchImageHookReadiness(script)
      addModifiedWorkNotice(script)
      await chmod(executable, 0o755)

      for (const required of [
        executable,
        script,
        join(stagedDirectory, 'wechat_version', '4_1_11_53_mac.json')
      ]) {
        if (!existsSync(required)) throw new Error('发送组件解压后文件不完整')
      }

      await rm(this.directory, { recursive: true, force: true })
      await rename(stagedDirectory, this.directory)
      stagedDirectory = ''
      const status = this.buildStatus('ready', ARCHIVE_SIZE, undefined, this.directory)
      this.reportProgress(status, true)
      return { success: true, status }
    } catch (error) {
      const cancelled = signal.aborted
      const message = cancelled
        ? '发送组件下载已取消'
        : error instanceof Error
          ? error.message
          : String(error)
      await rm(partial, { force: true })
      const status = this.buildStatus(
        cancelled ? 'missing' : 'error',
        this.downloadedBytes,
        message
      )
      this.reportProgress(status, true)
      return { success: false, status, error: message }
    } finally {
      if (extractionDirectory) await rm(extractionDirectory, { recursive: true, force: true })
      if (stagedDirectory) await rm(stagedDirectory, { recursive: true, force: true })
    }
  }

  private async hasPartialInstall(): Promise<boolean> {
    try {
      await stat(this.directory)
      return true
    } catch {
      return false
    }
  }

  private isSupported(): boolean {
    return process.platform === 'darwin' && process.arch === 'arm64'
  }

  private buildStatus(
    state: PersonalWechatRuntimeStatus['state'],
    downloadedBytes: number,
    error?: string,
    directory?: string
  ): PersonalWechatRuntimeStatus {
    return {
      version: RUNTIME_VERSION,
      state,
      downloadedBytes,
      totalBytes: ARCHIVE_SIZE,
      progress: ARCHIVE_SIZE ? Math.min(1, downloadedBytes / ARCHIVE_SIZE) : 0,
      platform: process.platform,
      architecture: process.arch,
      supported: this.isSupported(),
      removable: directory === this.directory,
      ...(directory ? { directory } : {}),
      ...(error ? { error } : {})
    }
  }

  private reportProgress(status: PersonalWechatRuntimeStatus, force = false): void {
    const now = Date.now()
    if (!force && now - this.lastProgressAt < 100) return
    this.lastProgressAt = now
    this.progressListener?.(status)
  }
}
