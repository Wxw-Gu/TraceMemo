import { execFile, execFileSync, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'node:util'
import { chmodSync, existsSync } from 'fs'
import { get, request as httpRequest } from 'http'
import { join } from 'path'

import { app } from 'electron'

import { appLogger } from '../app-logger'
import {
  isMacNativeRuntimeUnavailable,
  resolveWechatRuntimeDirectory
} from '../native-runtime-paths'
import type { MacLicenseStatus } from '../../shared/personal-wechat-mac-license'
import {
  offlineMacLicenseStatus,
  parseMacLicenseStatus
} from '../../shared/personal-wechat-mac-license'
import type {
  MacWechatBindResult,
  MacWechatBindingStatus,
  MacWechatRuntimeManifest,
  MacWechatRuntimeLifecycle,
  MacWechatRuntimeSnapshot,
  MacWechatSendRuntimeAvailabilityResult
} from '../../shared/personal-wechat-mac-runtime'
import type { PersonalWechatSenderStatus } from '../../shared/personal-wechat'
import { hasValidWechatLicense } from '../../shared/personal-wechat-mac-send-action'
import {
  bindingMatchesRuntimeManifest,
  MacWechatRuntimeManifestCache
} from './mac-wechat-runtime-artifact'

const execFileAsync = promisify(execFile)

/*
 * MacWechatRuntimeManager — lifecycle owner of the built-in macOS native
 * WeChat runtime (tm-wechat-host + libtmwechat.dylib).
 *
 * Process isolation is a hard requirement: Electron NEVER dlopens the dylib.
 * It spawns tm-wechat-host, which is the ONLY binding owner, and talks to it
 * over 127.0.0.1 HTTP. A native crash therefore cannot take Electron down.
 *
 * Binding lifecycle is "bind once per WeChat process":
 *   - starting the host NEVER attaches to WeChat (the host is lazy)
 *   - bind happens only on an explicit user action
 *   - a host crash while bound leaves an orphaned frida agent inside WeChat
 *     that frida cannot remove from the outside; the only recovery is
 *     restarting WeChat. Surfaced as wechatRestartRequired. This was verified
 *     experimentally (2026-09-21) — do not "fix" it by auto-restarting and
 *     auto-binding, that path dead-ends in a 20s attach timeout every time.
 */

/* Helper 会继承监听 fd，并在 Host 退出后继续持有；它卡在内核不可中断态时
 * SIGKILL 也不回收，重试同一端口永远失败，所以启动必须允许备用端口。 */
const DEFAULT_PORT = Number(process.env.TM_WECHAT_HOST_PORT) || 4290
const PORT_FALLBACK_SPAN = 3
const HOST = '127.0.0.1'
const START_TIMEOUT_MS = 15_000
const REQUEST_TIMEOUT_MS = 30_000
const CRASH_RESTART_DELAY_MS = 1_500
/* /license/status is a local cache read; keep it snappy. /license/refresh runs a
 * real challenge->sign->check cycle inside the host, which is bounded at 15s. */
const LICENSE_STATUS_TIMEOUT_MS = 8_000
const LICENSE_REFRESH_TIMEOUT_MS = 20_000

/* 仅地址占用可以通过切换端口恢复。 */
function isPortConflictDiagnostic(diagnostic: string): boolean {
  return /address already in use|EADDRINUSE|bind .*failed/i.test(diagnostic)
}

async function describePortHolder(port: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/sbin/lsof',
      ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'],
      { timeout: 2_000 }
    )
    const pid = Number(stdout.trim().split(/\s+/)[0])
    if (!Number.isSafeInteger(pid) || pid <= 0) return ''
    try {
      const { stdout: command } = await execFileAsync(
        '/bin/ps',
        ['-p', String(pid), '-o', 'comm='],
        { timeout: 2_000 }
      )
      const name = command.trim().split('/').pop() || 'unknown'
      return `${name}（PID ${pid}）`
    } catch {
      return `PID ${pid}（进程信息不可读，可能卡在退出中）`
    }
  } catch {
    return ''
  }
}

interface MacWechatSenderStatusInput {
  snapshot: MacWechatRuntimeSnapshot
  binding: MacWechatBindingStatus | null
  manifest: MacWechatRuntimeManifest
  arch?: string
}

export function shouldClearWechatRestartRequired(
  orphanWechatPid: number,
  currentWechatPid: number
): boolean {
  return orphanWechatPid > 0 && currentWechatPid > 0 && orphanWechatPid !== currentWechatPid
}

export function formatMacWechatHostStartupFailure(code: number | null, diagnostic: string): string {
  const lines = diagnostic.trim().split('\n').filter(Boolean)
  const detail = lines[lines.length - 1]
  if (detail) return `发送运行时启动失败（进程退出码 ${code ?? '未知'}）：${detail}`
  return code === null ? '发送运行时在启动过程中退出' : `发送运行时启动失败（进程退出码 ${code}）`
}

export function resolveMacWechatSendMechanism(
  binding: MacWechatBindingStatus | null,
  manifest: MacWechatRuntimeManifest | null
): string | undefined {
  if (!binding || !manifest || !bindingMatchesRuntimeManifest(binding, manifest)) return undefined
  return binding.wechatVersion
    ? manifest.capabilitiesByVersion?.[binding.wechatVersion]?.textMechanism
    : undefined
}

export function deriveMacWechatSenderStatus({
  snapshot,
  binding,
  manifest,
  arch = process.arch
}: MacWechatSenderStatusInput): PersonalWechatSenderStatus {
  const identityMatches = binding !== null && bindingMatchesRuntimeManifest(binding, manifest)
  const stale = binding?.bindingState === 'stale'
  const versionCapabilities = binding?.wechatVersion
    ? manifest.capabilitiesByVersion?.[binding.wechatVersion]
    : undefined
  const contextIndependentMechanism =
    versionCapabilities?.textMechanism === 'native-msg-object' ||
    versionCapabilities?.textMechanism === 'tm-message-source-send'
  const nativeBindingReady =
    identityMatches &&
    contextIndependentMechanism &&
    binding?.runtimeState === 'ready' &&
    binding.sessionAttached &&
    binding.scriptLoaded

  let state: PersonalWechatSenderStatus['state'] = 'stopped'
  let message = '正在初始化微信发送能力'
  if (snapshot.wechatRestartRequired) {
    state = 'error'
    message = '微信发送组件异常退出。由于当前微信进程中可能残留上一发送会话，请重启微信后重新绑定。'
  } else if (snapshot.lifecycle === 'crashed_unbound') {
    state = 'error'
    message = snapshot.error || '微信发送运行时启动失败，请重新启动发送组件。'
  } else if (snapshot.lifecycle === 'stopped' && snapshot.error) {
    state = 'error'
    message = snapshot.error
  } else if (binding && !identityMatches) {
    state = 'error'
    message = '运行中的微信发送 host 与当前 Native Runtime 不一致，请退出旧 host 后重启 TraceMemo。'
  } else if (binding && !binding.wechatRunning) {
    state = 'wechat_not_running'
    message = '微信未运行'
  } else if (binding?.runtimeState === 'unsupported_version') {
    state = 'error'
    message = binding.wechatVersion
      ? `当前微信版本是 ${binding.wechatVersion}，不在支持列表`
      : '当前微信版本不在支持列表'
  } else if (binding?.bindingState === 'ready' || nativeBindingReady) {
    state = 'online'
    message = '个人微信已准备好发送日报'
  } else if (binding?.bindingState === 'bound' || binding?.bindingState === 'binding') {
    state = 'hook_not_ready'
    message = contextIndependentMechanism
      ? '已绑定，等待原生发送 hook 就绪'
      : '已绑定，等待捕获微信发送上下文'
  } else if (stale) {
    state = 'stopped'
    message = '检测到微信已重启，请重新绑定'
  } else if (binding?.bindingState === 'failed') {
    state = 'error'
    message = '微信绑定失败'
  } else {
    state = 'stopped'
    message = '尚未绑定当前微信，可点击"绑定微信"'
  }

  const runtimeCapabilities = new Set(manifest.capabilities)
  const supportsCapability = (name: 'text' | 'image' | 'voice'): boolean => {
    if (manifest.capabilitiesByVersion) return versionCapabilities?.[name] === 'verified'
    return runtimeCapabilities.has(name)
  }
  const bindingReady =
    identityMatches &&
    state === 'online' &&
    (binding?.sendContextReady === true || nativeBindingReady)
  const canSendText = bindingReady && supportsCapability('text') && binding?.canSendText === true
  const canSendImage = bindingReady && supportsCapability('image') && binding?.canSendImage === true
  const canSendVoice = bindingReady && supportsCapability('voice') && binding?.canSendVoice === true
  /*
   * 视频复用图片的媒体通道（Host 的 `/SendMsg` type=video）。
   * Runtime manifest 不单独声明 video 能力，因此以图片通道是否可用作为判据；
   * 真正的发送结果仍以 Host 返回为准，不在 UI 层假装支持。
   */
  const canSendVideo = bindingReady && binding?.canSendImage === true
  const sessionAttached = identityMatches && (binding?.sessionAttached ?? false)
  const scriptLoaded = identityMatches && (binding?.scriptLoaded ?? false)

  return {
    state,
    platform: 'darwin',
    arch,
    // 当前 gadget runtime 不依赖宿主 SIP 状态；该字段仅用于兼容旧 sender contract。
    sipDisabled: true,
    wechatRunning: binding?.wechatRunning ?? false,
    wechatPid: binding?.wechatPid ?? 0,
    boundWechatPid: binding?.boundWechatPid ?? 0,
    endpoint: snapshot.endpoint,
    endpointReady: snapshot.lifecycle === 'online',
    wechatVersion: binding?.wechatVersion,
    runtimeReady: snapshot.lifecycle === 'online' && identityMatches,
    attachReady: sessionAttached,
    baseAddressReady: sessionAttached,
    textHookInstalled: scriptLoaded,
    textHookReady: identityMatches && (binding?.sendContextReady ?? false),
    imageHookInstalled: identityMatches && (binding?.canSendImage ?? false),
    imageHookReady: identityMatches && (binding?.canSendImage ?? false),
    messageListenerReady: scriptLoaded,
    canSend: canSendText || canSendImage || canSendVoice || canSendVideo,
    canSendText,
    canSendImage,
    canSendVoice,
    canSendVideo,
    message,
    error: state === 'error' ? message : undefined
  }
}

/**
 * 在线刷新失败时的返回策略：
 * 缓存里还有可用授权就保留它（只把失败写进 message），否则明确报告网络故障。
 * 单独抽出来是因为这两条分支都必须可测 —— 把网络故障错报成「已撤销」会让
 * 用户去找客服，错报成「有效」又会掩盖真实故障。
 */
export function resolveLicenseRefreshFailure(
  snapshot: MacLicenseStatus | null,
  diagnostic: string
): MacLicenseStatus {
  if (snapshot?.authorized) {
    return {
      ...snapshot,
      message: `本次刷新失败：${diagnostic}（仍使用本地缓存授权）`
    }
  }
  return offlineMacLicenseStatus('server_unavailable', diagnostic)
}

export class MacWechatRuntimeManager {
  private child: ChildProcess | null = null
  private startInFlight: Promise<MacWechatRuntimeSnapshot> | null = null
  private lifecycle: MacWechatRuntimeLifecycle = 'stopped'
  private wechatRestartRequired = false
  /* The WeChat pid that was bound when the host died / bind hit the orphan
   * wall. The orphan agent lives INSIDE that process; once WeChat is restarted
   * the pid changes and the orphan is gone, so the flag must auto-clear. */
  private orphanWechatPid = 0
  private lastBinding: MacWechatBindingStatus | null = null
  private manifest: MacWechatRuntimeManifest | null = null
  private readonly manifestCache = new MacWechatRuntimeManifestCache()
  private senderStatusInFlight: Promise<PersonalWechatSenderStatus> | null = null
  private lastError: string | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private manuallyStopped = false
  private activePort = DEFAULT_PORT
  private portFallbackFrom: number | null = null

  getPort(): number {
    return this.activePort
  }

  getSnapshot(): MacWechatRuntimeSnapshot {
    return {
      lifecycle: this.lifecycle,
      wechatRestartRequired: this.wechatRestartRequired,
      endpoint: `http://${HOST}:${this.activePort}`,
      port: this.activePort,
      ...(this.portFallbackFrom === null ? {} : { portFallbackFrom: this.portFallbackFrom }),
      runtimeDir: this.resolveRuntimeDir() ?? undefined,
      error: this.lastError ?? undefined,
      binding: this.lastBinding ?? undefined
    }
  }

  prepareForResidualCleanup(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.lifecycle = 'stopped'
    this.manuallyStopped = true
    this.child = null
    this.lastBinding = null
    this.lastError = null
  }

  async startAfterResidualCleanup(): Promise<MacWechatRuntimeSnapshot> {
    return this.ensureStarted({ allowManualRestart: true })
  }

  private resolveRuntimeDir(): string | null {
    if (isMacNativeRuntimeUnavailable()) return null
    const resolved = resolveWechatRuntimeDirectory()
    if (resolved) return resolved
    if (app.isPackaged) return null
    return join(app.getAppPath(), 'resources', 'runtime', 'darwin-arm64')
  }

  private resolveHostPath(): string {
    return join(this.resolveRuntimeDir() || '', 'tm-wechat-host')
  }

  /** Runtime binaries present and executable? Cheap check for the settings UI. */
  isRuntimePresent(): boolean {
    if (isMacNativeRuntimeUnavailable()) return false
    try {
      const runtimeDir = this.resolveRuntimeDir()
      if (!runtimeDir) return false
      this.manifest = this.manifestCache.read(runtimeDir)
      return true
    } catch {
      return false
    }
  }

  getSendRuntimeAvailability(): MacWechatSendRuntimeAvailabilityResult {
    if (isMacNativeRuntimeUnavailable()) {
      return { state: 'unavailable', message: '当前版本没有微信发送能力' }
    }
    try {
      const runtimeDir = this.resolveRuntimeDir()
      if (!runtimeDir) throw new Error('发送 Runtime 目录缺失')
      this.manifest = this.manifestCache.read(runtimeDir)
      return { state: 'available', message: '微信发送组件可用' }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { state: 'component_error', message: `发送组件缺失或异常：${detail}` }
    }
  }

  /**
   * Start the host if it is not already running. Deliberately lazy: the host
   * comes up WITHOUT touching WeChat (lazy init inside the host), so "runtime
   * online" and "WeChat bound" stay two independent states.
   */
  ensureStarted(options: { allowManualRestart?: boolean } = {}): Promise<MacWechatRuntimeSnapshot> {
    if (this.startInFlight) return this.startInFlight

    const startPromise = this.ensureStartedOnce(options)
    this.startInFlight = startPromise
    void startPromise.then(
      () => {
        if (this.startInFlight === startPromise) this.startInFlight = null
      },
      () => {
        if (this.startInFlight === startPromise) this.startInFlight = null
      }
    )
    return startPromise
  }

  protected async ensureStartedOnce(options: {
    allowManualRestart?: boolean
  }): Promise<MacWechatRuntimeSnapshot> {
    if (this.manuallyStopped && !options.allowManualRestart) return this.getSnapshot()
    if (options.allowManualRestart) this.manuallyStopped = false
    if (isMacNativeRuntimeUnavailable()) {
      this.manifest = null
      this.lifecycle = 'stopped'
      this.lastError = '当前环境不包含微信发送能力'
      return this.getSnapshot()
    }
    if (this.lifecycle === 'starting') {
      return this.getSnapshot()
    }

    const runtimeDir = this.resolveRuntimeDir()
    if (!runtimeDir) {
      this.lifecycle = 'stopped'
      this.lastError = '暂无发送能力'
      return this.getSnapshot()
    }
    try {
      this.manifest = this.manifestCache.read(runtimeDir)
      appLogger.write({
        level: 'info',
        scope: 'mac-wechat-runtime',
        message: 'runtime_artifact_validated',
        details: {
          runtime: this.manifest.runtime,
          version: this.manifest.version,
          protocolVersion: this.manifest.protocolVersion,
          agentSha256: this.manifest.tmSendSourceSha256,
          addressProfileSha256: this.manifest.addressProfileSha256
        }
      })
    } catch (error) {
      this.manifest = null
      const detail = error instanceof Error ? error.message : String(error)
      appLogger.write({
        level: 'warn',
        scope: 'mac-wechat-runtime',
        message: 'runtime_artifact_unavailable',
        details: { detail }
      })
      this.lastError = '暂无发送能力'
      this.lifecycle = 'stopped'
      return this.getSnapshot()
    }

    if (this.lifecycle === 'online') {
      await this.refreshBinding().catch(() => undefined)
      if (
        this.lastBinding &&
        this.manifest &&
        bindingMatchesRuntimeManifest(this.lastBinding, this.manifest)
      ) {
        return this.getSnapshot()
      }
      this.lifecycle = 'stopped'
      this.lastError = '运行中的 host 与 runtime manifest 不一致'
      return this.getSnapshot()
    }

    /*
     * Adopt-first: the host is designed to OUTLIVE TraceMemo ("keep the send
     * capability process"), so a previous app session may have left it running
     * with a live, bound session. If something is already answering on our
     * port, adopt it instead of spawning a second one (which would just die on
     * the occupied port). Adopting is pure HTTP — the running host keeps its
     * frida session, so the app is immediately ready with NO re-bind, exactly
     * the "keep the send capability process" behaviour the user asked to carry over.
     */
    if (await this.adoptRunningHost()) {
      this.lifecycle = 'online'
      this.child = null
      this.wechatRestartRequired = false
      await this.refreshBinding().catch(() => undefined)
      if (
        !this.lastBinding ||
        !this.manifest ||
        !bindingMatchesRuntimeManifest(this.lastBinding, this.manifest)
      ) {
        this.lifecycle = 'stopped'
        this.lastError =
          '检测到无法确认身份的微信发送 host。请先退出旧 host，再重新启动 TraceMemo。'
        return this.getSnapshot()
      }
      return this.getSnapshot()
    }
    if (this.lifecycle === 'crashed_bound' || this.wechatRestartRequired) {
      // Restarting the host is safe (it does not touch WeChat), but binding is
      // not: the orphaned agent from the previous session is still inside the
      // current WeChat process. Start anyway so the UI can show live status.
      appLogger.write({
        level: 'warn',
        scope: 'mac-wechat-runtime',
        message: 'restart_host_after_bound_crash',
        details: { note: 'bind stays blocked until WeChat restarts' }
      })
    }

    const hostPath = this.resolveHostPath()
    if (!existsSync(hostPath)) {
      this.lastError = `runtime host missing: ${hostPath}`
      this.lifecycle = 'stopped'
      return this.getSnapshot()
    }
    try {
      chmodSync(hostPath, 0o755)
    } catch {
      /* best effort — dev checkouts usually keep the exec bit */
    }
    try {
      if (!app.isPackaged) {
        execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', hostPath])
      }
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', hostPath])
    } catch (error) {
      this.lifecycle = 'stopped'
      this.lastError =
        '无法验证发送 Host 签名：' + (error instanceof Error ? error.message : String(error))
      appLogger.write({
        level: 'error',
        scope: 'mac-wechat-runtime',
        message: 'host_signature_invalid',
        details: { detail: this.lastError }
      })
      return this.getSnapshot()
    }

    const manifestPath = join(runtimeDir, 'runtime-manifest.json')
    /* stderr 保持管道以便启动失败时取诊断；运行日志走 hostLogFile。 */
    const hostLogFile = join(app.getPath('logs'), 'tm-wechat-host.log')
    const candidates = this.candidatePorts()
    const failures: Array<{ port: number; detail: string; portConflict: boolean }> = []

    for (const port of candidates) {
      this.activePort = port
      this.lifecycle = 'starting'
      this.lastError = null

      let child: ChildProcess
      try {
        child = spawn(
          hostPath,
          ['--port', String(port), '--manifest', manifestPath, '--log-level', 'info'],
          {
            cwd: runtimeDir,
            stdio: ['ignore', 'ignore', 'pipe'],
            detached: false,
            env: { ...process.env, TM_WECHAT_LOG_FILE: hostLogFile }
          }
        )
      } catch (error) {
        this.lifecycle = 'stopped'
        this.lastError = String(error)
        return this.getSnapshot()
      }
      this.child = child

      let startupDiagnostic = ''
      let exitedDuringStartup = false
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        startupDiagnostic = (startupDiagnostic + chunk).slice(-2_000)
      })
      child.on('exit', () => {
        exitedDuringStartup = true
        if (this.child === child) this.child = null
      })
      child.on('error', (error) => {
        exitedDuringStartup = true
        startupDiagnostic += `\nspawn error: ${error.message}`
        if (this.child === child) this.child = null
      })

      /* Host 退出就结束等待，不必耗满 healthz 超时。 */
      let reachable = false
      const deadline = Date.now() + START_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (await this.ping()) {
          reachable = true
          break
        }
        if (exitedDuringStartup) break
        await new Promise((resolve) => setTimeout(resolve, 300))
      }

      if (reachable) {
        this.lifecycle = 'online'
        this.portFallbackFrom = port === DEFAULT_PORT ? null : DEFAULT_PORT
        this.attachChildLifecycleHandlers(child, startupDiagnostic)
        if (this.portFallbackFrom !== null) {
          appLogger.write({
            level: 'warn',
            scope: 'mac-wechat-runtime',
            message: 'host_port_fallback',
            details: { preferredPort: DEFAULT_PORT, activePort: port }
          })
        }
        await this.refreshBinding().catch(() => undefined)
        if (
          !this.lastBinding ||
          !this.manifest ||
          !bindingMatchesRuntimeManifest(this.lastBinding, this.manifest)
        ) {
          this.lifecycle = 'crashed_unbound'
          this.lastError = '运行中的 host 与 runtime manifest 不一致'
          return this.getSnapshot()
        }
        return this.getSnapshot()
      }

      const portConflict = isPortConflictDiagnostic(startupDiagnostic)
      failures.push({
        port,
        detail: exitedDuringStartup
          ? formatMacWechatHostStartupFailure(child.exitCode, startupDiagnostic)
          : '发送运行时未在超时内响应 /healthz',
        portConflict
      })
      appLogger.write({
        level: 'warn',
        scope: 'mac-wechat-runtime',
        message: 'host_port_attempt_failed',
        details: { port, portConflict }
      })
      /* 其他启动失败换端口也不会好，直接停。 */
      if (!portConflict) break
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 进程可能已在状态检查后退出。 */
        }
      }
    }

    this.lifecycle = 'crashed_unbound'
    this.lastError = await this.formatPortRotationFailure(failures)
    return this.getSnapshot()
  }

  /* Always retry the preferred port first so it is reused once available. */
  private candidatePorts(): number[] {
    const ports = [DEFAULT_PORT, this.activePort]
    for (let offset = 1; offset <= PORT_FALLBACK_SPAN; offset++) ports.push(DEFAULT_PORT + offset)
    return ports.filter(
      (port, index) =>
        Number.isSafeInteger(port) && port > 0 && port < 65_536 && ports.indexOf(port) === index
    )
  }

  /* Reuse an existing Host on any supported port before spawning another one. */
  private async adoptRunningHost(): Promise<boolean> {
    for (const port of this.candidatePorts()) {
      const previous = this.activePort
      this.activePort = port
      if (await this.ping()) {
        this.portFallbackFrom = port === DEFAULT_PORT ? null : DEFAULT_PORT
        return true
      }
      this.activePort = previous
    }
    return false
  }

  private attachChildLifecycleHandlers(child: ChildProcess, startupDiagnostic: string): void {
    child.on('exit', (code) => {
      const wasBound =
        this.lastBinding?.bound === true ||
        this.lastBinding?.sessionAttached === true ||
        this.lastBinding?.bindingState === 'binding'
      const orphanPid = this.lastBinding?.boundWechatPid || this.lastBinding?.wechatPid || 0
      if (this.child === child) this.child = null
      this.lastBinding = null
      if (this.lifecycle === 'stopped') return // deliberate shutdown

      if (wasBound) {
        this.lifecycle = 'crashed_bound'
        this.wechatRestartRequired = true
        this.orphanWechatPid = orphanPid
        appLogger.write({
          level: 'error',
          scope: 'mac-wechat-runtime',
          message: 'host_died_while_bound',
          details: { code: code ?? null, orphanWechatPid: orphanPid }
        })
        return
      }
      this.lifecycle = 'crashed_unbound'
      this.lastError = formatMacWechatHostStartupFailure(code, startupDiagnostic)
      appLogger.write({
        level: 'warn',
        scope: 'mac-wechat-runtime',
        message: 'host_died_while_unbound_auto_restart',
        details: { code: code ?? null }
      })
      if (this.restartTimer) clearTimeout(this.restartTimer)
      this.restartTimer = setTimeout(() => {
        void this.ensureStarted()
      }, CRASH_RESTART_DELAY_MS)
    })
    child.on('error', (error) => {
      if (this.lifecycle === 'stopped') return
      if (this.child === child) this.child = null
      this.lifecycle = 'crashed_unbound'
      this.lastError = '无法启动发送 Host：' + error.message
      appLogger.write({
        level: 'error',
        scope: 'mac-wechat-runtime',
        message: 'host_spawn_failed',
        details: { detail: error.message }
      })
    })
  }

  private async formatPortRotationFailure(
    failures: Array<{ port: number; detail: string; portConflict: boolean }>
  ): Promise<string> {
    const last = failures[failures.length - 1]
    if (!last) return '发送运行时启动失败'
    if (!failures.some((failure) => failure.portConflict)) return last.detail
    const holder = await describePortHolder(last.port)
    const holderText = holder ? `，占用者 ${holder}` : ''
    if (failures.length === 1) return `${last.detail}${holderText}`
    return `端口 ${failures.map((failure) => failure.port).join('、')} 均被占用${holderText}。请重启系统释放端口，或用 TM_WECHAT_HOST_PORT 指定其他端口。`
  }

  private request(
    method: string,
    path: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
    body?: string
  ): Promise<{ status: number | null; body: string }> {
    return new Promise((resolve) => {
      const payload = body !== undefined ? Buffer.from(body, 'utf8') : undefined
      // GET keeps using `get()` (auto-end); POST goes through `request()` so we
      // can attach a JSON body. Both funnel into the same resolve contract.
      const transport = method === 'GET' || method === 'HEAD' ? get : httpRequest
      const req = transport(
        {
          host: HOST,
          port: this.activePort,
          path,
          method,
          timeout: timeoutMs,
          headers: payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': payload.length
              }
            : undefined
        },
        (response) => {
          let body = ''
          response.on('data', (chunk) => {
            body += chunk
          })
          response.on('end', () => {
            resolve({ status: response.statusCode ?? null, body })
          })
        }
      )
      req.on('timeout', () => {
        req.destroy()
        resolve({ status: null, body: '' })
      })
      req.on('error', () => {
        resolve({ status: null, body: '' })
      })
      if (payload) req.write(payload)
      req.end()
    })
  }

  async ping(): Promise<boolean> {
    const { status } = await this.request('GET', '/healthz', 3_000)
    if (status === 200) return true

    /*
     * Adopted hosts have no child handle, so their death is only observable
     * through failed probes. Classify here: dying while bound means WeChat
     * keeps an orphaned agent (restart required); dying while unbound is
     * auto-recoverable.
     */
    if (this.lifecycle === 'online') {
      const wasBound =
        this.lastBinding?.bound === true ||
        this.lastBinding?.sessionAttached === true ||
        this.lastBinding?.bindingState === 'binding'
      const orphanPid = this.lastBinding?.boundWechatPid || this.lastBinding?.wechatPid || 0
      this.lastBinding = null
      if (wasBound) {
        this.lifecycle = 'crashed_bound'
        this.wechatRestartRequired = true
        this.orphanWechatPid = orphanPid
        appLogger.write({
          level: 'error',
          scope: 'mac-wechat-runtime',
          message: 'adopted_host_died_while_bound',
          details: { note: 'WeChat restart required', orphanWechatPid: orphanPid }
        })
      } else {
        this.lifecycle = 'crashed_unbound'
      }
    }
    return false
  }

  /** Pull /bindingStatus and cache it for crash classification. */
  async refreshBinding(): Promise<MacWechatBindingStatus | null> {
    const { status, body } = await this.request('GET', '/bindingStatus')
    if (status !== 200) return null
    try {
      const binding = JSON.parse(body) as MacWechatBindingStatus & {
        supportedVersions?: string
      }
      delete binding.supportedVersions
      this.lastBinding = binding
      /*
       * A 20s bind timeout is NOT proof of the orphan-agent wall: in the
       * stale-rebind path the host worker waits up to 45s for the old session
       * teardown before attaching, so the HTTP response times out while the
       * attach quietly succeeds afterwards. When the binding is later observed
       * alive and matching, the restart-required verdict was a false positive
       * and must be withdrawn — otherwise the manager keeps rejecting every
       * further bind locally while WeChat is actually bound and working.
       */
      if (
        this.wechatRestartRequired &&
        (this.lastBinding.bound === true || this.lastBinding.bindingState === 'ready') &&
        this.lastBinding.boundWechatPid === this.lastBinding.wechatPid
      ) {
        this.wechatRestartRequired = false
        appLogger.write({
          level: 'warn',
          scope: 'mac-wechat-runtime',
          message: 'restart_required_withdrawn',
          details: { note: 'binding observed alive after bind timeout' }
        })
      }
      return this.lastBinding
    } catch {
      return null
    }
  }

  async getBindingStatus(): Promise<MacWechatBindingStatus | null> {
    if (this.lifecycle !== 'online') return this.lastBinding
    await this.refreshBinding().catch(() => null)
    return this.lastBinding
  }

  async getSendMechanism(): Promise<string | undefined> {
    return resolveMacWechatSendMechanism(await this.getBindingStatus(), this.manifest)
  }

  // GET reads the local snapshot; POST runs one real online check.
  // Neither touches the WeChat binding.

  /** Local snapshot. Never attaches to WeChat, never forces a network refresh.
   *  404 means the host predates these endpoints — not "unlicensed". */
  async getMacLicenseStatus(): Promise<MacLicenseStatus> {
    const availability = this.getSendRuntimeAvailability()
    if (availability.state === 'unavailable') {
      return offlineMacLicenseStatus('platform_unsupported', '当前构建不包含 Mac 发送能力')
    }
    if (availability.state !== 'available') {
      return offlineMacLicenseStatus('runtime_missing', availability.message)
    }
    if (this.manuallyStopped) {
      return offlineMacLicenseStatus(
        'runtime_missing',
        'Mac 发送组件已停止，请在发送页点击“绑定微信”重新启动。'
      )
    }
    if (this.lifecycle === 'stopped') await this.ensureStarted()
    const { status, body } = await this.request('GET', '/license/status', LICENSE_STATUS_TIMEOUT_MS)
    if (status === null) {
      return offlineMacLicenseStatus('runtime_missing', 'Mac 发送组件未运行，请先启动发送组件')
    }
    if (status === 404) {
      return offlineMacLicenseStatus(
        'unsupported',
        '当前发送组件版本较旧，不支持授权检测。请升级或重启发送组件后再试。'
      )
    }
    if (status !== 200) {
      return offlineMacLicenseStatus('runtime_missing', `授权状态查询失败（HTTP ${status}）`)
    }
    try {
      return parseMacLicenseStatus(JSON.parse(body))
    } catch {
      return offlineMacLicenseStatus('runtime_missing', '授权状态响应无法解析')
    }
  }

  /**
   * One real online check; re-entrant calls return the current snapshot instead
   * of minting a duplicate challenge. Network failure maps to server_unavailable,
   * never to revoked.
   */
  async refreshMacLicense(): Promise<MacLicenseStatus> {
    const availability = this.getSendRuntimeAvailability()
    if (availability.state === 'unavailable') {
      return offlineMacLicenseStatus('platform_unsupported', '当前构建不包含 Mac 发送能力')
    }
    if (availability.state !== 'available') {
      return offlineMacLicenseStatus('runtime_missing', availability.message)
    }
    if (this.manuallyStopped) {
      return offlineMacLicenseStatus(
        'runtime_missing',
        'Mac 发送组件已停止，请在发送页点击“绑定微信”重新启动。'
      )
    }
    if (this.lifecycle === 'stopped') await this.ensureStarted()
    if (this.licenseRefreshInFlight) {
      // A refresh is already running; answer from the local snapshot so the
      // button click is a no-op instead of stacking a second online check.
      return this.getMacLicenseStatus()
    }
    this.licenseRefreshInFlight = true
    try {
      const { status, body } = await this.request(
        'POST',
        '/license/refresh',
        LICENSE_REFRESH_TIMEOUT_MS,
        '{}'
      )
      if (status === null) {
        const snapshot = await this.getMacLicenseStatus().catch(() => null)
        return resolveLicenseRefreshFailure(snapshot, '无法连接授权服务器，请检查网络后重试')
      }
      if (status === 404) {
        return offlineMacLicenseStatus(
          'unsupported',
          '当前发送组件版本较旧，不支持授权检测。请升级或重启发送组件后再试。'
        )
      }
      let envelope: Record<string, unknown>
      try {
        envelope = JSON.parse(body) as Record<string, unknown>
      } catch {
        return offlineMacLicenseStatus('runtime_missing', '授权刷新响应无法解析')
      }
      // The host wraps the result: { ok, code, message, status: MacLicenseStatus }
      const nested = envelope.status ?? envelope
      const parsed = parseMacLicenseStatus(nested)
      if (typeof envelope.errorCode === 'number' && parsed.errorCode == null) {
        parsed.errorCode = envelope.errorCode
      }
      return parsed
    } finally {
      this.licenseRefreshInFlight = false
    }
  }

  private licenseRefreshInFlight = false

  /*
   * Build the legacy PersonalWechatSenderStatus contract from the live mac
   * runtime state. Lives here (not in the capability service) so BOTH the
   * capability mapping and the send path report the same facts without a
   * circular import.
   */
  buildSenderStatus(): Promise<PersonalWechatSenderStatus> {
    if (this.senderStatusInFlight) return this.senderStatusInFlight
    const statusPromise = this.buildSenderStatusOnce()
    this.senderStatusInFlight = statusPromise
    void statusPromise.then(
      () => {
        if (this.senderStatusInFlight === statusPromise) this.senderStatusInFlight = null
      },
      () => {
        if (this.senderStatusInFlight === statusPromise) this.senderStatusInFlight = null
      }
    )
    return statusPromise
  }

  private async buildSenderStatusOnce(): Promise<PersonalWechatSenderStatus> {
    if (isMacNativeRuntimeUnavailable()) {
      const message = '当前环境不包含微信发送能力'
      return {
        state: 'runtime_missing',
        platform: 'darwin',
        arch: process.arch,
        sipDisabled: true,
        wechatRunning: false,
        endpoint: `http://${HOST}:${this.activePort}`,
        endpointReady: false,
        runtimeReady: false,
        attachReady: false,
        baseAddressReady: false,
        textHookInstalled: false,
        textHookReady: false,
        imageHookInstalled: false,
        imageHookReady: false,
        messageListenerReady: false,
        canSend: false,
        canSendText: false,
        canSendImage: false,
        canSendVoice: false,
        message,
        error: message
      }
    }
    /*
     * Lazy-start the host from status reads.
     *
     * Every UI surface discovers the runtime through this method, and the
     * setup guide renders "正在检查 发送运行时…" while runtimeReady is false —
     * where runtimeReady means lifecycle === 'online'. If nothing here brings a
     * stopped host up, opening the app (with WeChat already logged in, so no
     * send is ever attempted) leaves that step spinning forever: the check can
     * never succeed because the check itself is what should start the host.
     * Starting it never touches WeChat, so doing it from a read is safe.
     */
    if (this.lifecycle === 'stopped' && !this.manuallyStopped) {
      await this.ensureStarted().catch(() => undefined)
    }
    /* Self-heal the status card too: if WeChat was restarted, drop the stale
     * restartRequired before it is read into the UI as an error. */
    try {
      const runtimeDir = this.resolveRuntimeDir()
      if (!runtimeDir) throw new Error('runtime missing')
      this.manifest = this.manifestCache.read(runtimeDir)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      appLogger.write({
        level: 'warn',
        scope: 'mac-wechat-runtime',
        message: 'runtime_artifact_unavailable',
        details: { detail }
      })
      const message = '暂无发送能力'
      this.manifest = null
      this.lastError = message
      return {
        state: 'runtime_missing',
        platform: 'darwin',
        arch: process.arch,
        sipDisabled: true,
        wechatRunning: false,
        endpoint: `http://${HOST}:${this.activePort}`,
        endpointReady: false,
        runtimeReady: false,
        attachReady: false,
        baseAddressReady: false,
        textHookInstalled: false,
        textHookReady: false,
        imageHookInstalled: false,
        imageHookReady: false,
        messageListenerReady: false,
        canSend: false,
        canSendText: false,
        canSendImage: false,
        canSendVoice: false,
        message,
        error: message
      }
    }
    await this.clearRestartRequiredIfWechatRestarted()
    const snapshot = this.getSnapshot()
    const binding = await this.getBindingStatus()
    return deriveMacWechatSenderStatus({ snapshot, binding, manifest: this.manifest })
  }

  /*
   * The orphan agent lives inside ONE specific WeChat process. If the WeChat
   * pid we recorded when restartRequired was raised no longer matches the
   * WeChat pid the host currently sees, WeChat has been restarted and the
   * orphan is gone — the flag must clear or every later bind is rejected
   * forever even though the user DID restart WeChat (the reported bug).
   */
  private async clearRestartRequiredIfWechatRestarted(): Promise<void> {
    if (!this.wechatRestartRequired) return
    await this.refreshBinding().catch(() => null)
    const currentPid = this.lastBinding?.wechatPid ?? 0
    if (shouldClearWechatRestartRequired(this.orphanWechatPid, currentPid)) {
      this.wechatRestartRequired = false
      this.orphanWechatPid = 0
      if (this.lifecycle === 'crashed_bound') this.lifecycle = 'online'
      appLogger.write({
        level: 'info',
        scope: 'mac-wechat-runtime',
        message: 'restart_required_cleared_wechat_restarted',
        details: { currentWechatPid: currentPid }
      })
    }
  }

  /**
   * Explicit user action only. Idempotent on the host side: binding the same
   * live WeChat pid again returns attached=false and never double-attaches.
   */
  async bind(): Promise<MacWechatBindResult> {
    const availability = this.getSendRuntimeAvailability()
    if (availability.state === 'unavailable') {
      return {
        ok: false,
        attached: false,
        state: 'runtime_offline',
        message: '当前环境不包含微信发送能力'
      }
    }
    if (availability.state !== 'available') {
      return { ok: false, attached: false, state: 'runtime_offline', message: availability.message }
    }
    if (this.lifecycle !== 'online') {
      const snapshot = await this.ensureStarted({ allowManualRestart: true })
      if (snapshot.lifecycle !== 'online') {
        return {
          ok: false,
          attached: false,
          state: 'runtime_offline',
          message: snapshot.error ?? 'Runtime 未在线，无法绑定'
        }
      }
    }

    /* Auto-clear if WeChat was restarted since the flag was raised —
     * otherwise this branch rejects every bind forever (the reported bug). */
    await this.clearRestartRequiredIfWechatRestarted()

    if (this.wechatRestartRequired) {
      return {
        ok: false,
        attached: false,
        state: 'wechat_restart_required',
        message:
          'Previous WeChat send session was not fully released. ' + 'Restart WeChat and bind again.'
      }
    }

    const license = await this.getMacLicenseStatus()
    const licenseAllowed = hasValidWechatLicense(license)
    if (!licenseAllowed) {
      const tokenExpiresAt = license.tokenExpiresAt
        ? Date.parse(license.tokenExpiresAt)
        : Number.NaN
      const message =
        license.state === 'revoked'
          ? 'LICENSE_REVOKED: 微信发送授权已撤销'
          : license.state === 'expired' ||
              (Number.isFinite(tokenExpiresAt) && tokenExpiresAt <= Date.now())
            ? 'LICENSE_EXPIRED: 微信发送授权已过期'
            : license.state === 'device_mismatch'
              ? 'LICENSE_DEVICE_MISMATCH: 授权与当前设备不匹配'
              : license.state === 'identity_error'
                ? 'LICENSE_IDENTITY_ERROR: 设备身份异常'
                : license.authorized && !license.features.includes('wechat')
                  ? 'LICENSE_FEATURE_DENIED: 未开通微信发送'
                  : 'LICENSE_REQUIRED: 需要有效的微信发送授权'
      return { ok: false, attached: false, state: 'host_error', message }
    }

    const { status, body } = await this.request('POST', '/bindWeChat')
    await this.refreshBinding().catch(() => null)

    if (status !== 200) {
      return {
        ok: false,
        attached: false,
        state: 'host_error',
        message: `host 返回 HTTP ${status ?? '无响应'}`
      }
    }
    try {
      const parsed = JSON.parse(body) as MacWechatBindResult
      if (!parsed.ok && parsed.message?.includes('not fully released')) {
        this.wechatRestartRequired = true
        this.orphanWechatPid = this.lastBinding?.boundWechatPid || this.lastBinding?.wechatPid || 0
        appLogger.write({
          level: 'error',
          scope: 'mac-wechat-runtime',
          message: 'bind_hit_orphan_agent_wall',
          details: { note: 'WeChat restart required', orphanWechatPid: this.orphanWechatPid }
        })
      }
      return parsed
    } catch {
      return { ok: false, attached: false, state: 'bad_response', message: body.slice(0, 200) }
    }
  }

  /*
   * 重新加载发送组件：优雅停掉当前 host 进程，再启动一个新实例。
   * 用于：更新二进制后换新代码；或 host 卡死时的手动恢复。
   * 注意：若当前 host 已绑定微信，此操作会让微信里留下孤儿 agent，
   * 需要重启微信后重新绑定（UI 会提示）。
   */
  async reload(): Promise<MacWechatRuntimeSnapshot> {
    await this.shutdown().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    return this.ensureStarted({ allowManualRestart: true })
  }

  private isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * Graceful stop only. A bound host must never be force-killed: doing so can
   * leave its injected agent inside WeChat and make the next attach hang.
   */
  async shutdown(): Promise<void> {
    if (isMacNativeRuntimeUnavailable()) return
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }

    if (this.lifecycle === 'stopped' && this.child === null) return

    const reachable = await this.ping()
    if (!reachable && this.child === null) {
      this.lifecycle = 'stopped'
      this.lastBinding = null
      return
    }

    await this.refreshBinding().catch(() => null)
    const child = this.child
    const hostPid = this.lastBinding?.hostPid ?? 0
    this.lifecycle = 'stopped'
    this.lastError = null

    const response = await this.request('POST', '/shutdown', 5_000)
    if (response.status !== 200) {
      this.lifecycle = 'online'
      this.lastError = 'Native Runtime 未确认退出请求，已保留 host 以避免微信残留会话。'
      throw new Error(this.lastError)
    }

    const deadline = Date.now() + 55_000
    let transportClosedAt = 0
    while (Date.now() < deadline) {
      const childExited = child !== null && child.exitCode !== null
      const pidExited = hostPid > 0 && !this.isProcessAlive(hostPid)
      if (childExited || pidExited) {
        this.child = null
        this.lastBinding = null
        return
      }
      if (child === null && hostPid === 0) {
        const transportOpen = await this.ping()
        if (!transportOpen) {
          if (transportClosedAt === 0) transportClosedAt = Date.now()
          /* Compatibility with a pre-hostPid runtime during one upgrade:
           * its teardown waits at most 45s after closing the listen socket. */
          if (Date.now() - transportClosedAt >= 46_000) {
            this.lastBinding = null
            return
          }
        } else {
          transportClosedAt = 0
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    this.lastError = 'Native Runtime 安全退出超时；未强制结束绑定态 host，请先退出微信后再重试。'
    throw new Error(this.lastError)
  }
}

export const macWechatRuntimeManager = new MacWechatRuntimeManager()
