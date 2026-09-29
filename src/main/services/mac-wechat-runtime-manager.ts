import { spawn, type ChildProcess } from 'child_process'
import { chmodSync, existsSync } from 'fs'
import { get } from 'http'
import { join } from 'path'

import { app } from 'electron'

import { appLogger } from '../app-logger'
import { isPackagedRuntime } from '../runtime-mode'
import type {
  MacWechatBindResult,
  MacWechatBindingStatus,
  MacWechatRuntimeManifest,
  MacWechatRuntimeLifecycle,
  MacWechatRuntimeSnapshot
} from '../../shared/personal-wechat-mac-runtime'
import type { PersonalWechatSenderStatus } from '../../shared/personal-wechat'
import {
  bindingMatchesRuntimeManifest,
  readMacWechatRuntimeManifest
} from './mac-wechat-runtime-artifact'

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

const PORT = 4290
const HOST = '127.0.0.1'
const START_TIMEOUT_MS = 15_000
const REQUEST_TIMEOUT_MS = 30_000
const CRASH_RESTART_DELAY_MS = 1_500

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

export function deriveMacWechatSenderStatus({
  snapshot,
  binding,
  manifest,
  arch = process.arch
}: MacWechatSenderStatusInput): PersonalWechatSenderStatus {
  const identityMatches = binding !== null && bindingMatchesRuntimeManifest(binding, manifest)
  const stale = binding?.bindingState === 'stale'

  let state: PersonalWechatSenderStatus['state'] = 'stopped'
  let message = '正在初始化微信发送能力'
  if (snapshot.wechatRestartRequired) {
    state = 'error'
    message = '微信发送组件异常退出。由于当前微信进程中可能残留上一发送会话，请重启微信后重新绑定。'
  } else if (binding && !identityMatches) {
    state = 'error'
    message = '运行中的微信发送 host 与当前 Native Runtime 不一致，请退出旧 host 后重启 TraceMemo。'
  } else if (binding && !binding.wechatRunning) {
    state = 'wechat_not_running'
    message = '微信未运行'
  } else if (binding?.bindingState === 'ready') {
    state = 'online'
    message = '个人微信已准备好发送日报'
  } else if (binding?.bindingState === 'bound' || binding?.bindingState === 'binding') {
    state = 'hook_not_ready'
    message = '已绑定，等待捕获微信发送上下文'
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
  const bindingReady = identityMatches && state === 'online' && binding?.sendContextReady === true
  const canSendText =
    bindingReady && runtimeCapabilities.has('text') && binding?.canSendText === true
  const canSendImage =
    bindingReady && runtimeCapabilities.has('image') && binding?.canSendImage === true
  const canSendVoice =
    bindingReady && runtimeCapabilities.has('voice') && binding?.canSendVoice === true
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
    canSend: canSendText || canSendImage || canSendVoice,
    canSendText,
    canSendImage,
    canSendVoice,
    message,
    error: state === 'error' ? message : undefined
  }
}

class MacWechatRuntimeManager {
  private child: ChildProcess | null = null
  private lifecycle: MacWechatRuntimeLifecycle = 'stopped'
  private wechatRestartRequired = false
  /* The WeChat pid that was bound when the host died / bind hit the orphan
   * wall. The orphan agent lives INSIDE that process; once WeChat is restarted
   * the pid changes and the orphan is gone, so the flag must auto-clear. */
  private orphanWechatPid = 0
  private lastBinding: MacWechatBindingStatus | null = null
  private manifest: MacWechatRuntimeManifest | null = null
  private lastError: string | null = null
  private restartTimer: NodeJS.Timeout | null = null

  getPort(): number {
    return PORT
  }

  getSnapshot(): MacWechatRuntimeSnapshot {
    return {
      lifecycle: this.lifecycle,
      wechatRestartRequired: this.wechatRestartRequired,
      endpoint: `http://${HOST}:${PORT}`,
      port: PORT,
      runtimeDir: this.resolveRuntimeDir(),
      manifest: this.manifest ?? undefined,
      error: this.lastError ?? undefined,
      binding: this.lastBinding ?? undefined
    }
  }

  private resolveRuntimeDir(): string {
    const base = isPackagedRuntime() ? process.resourcesPath : app.getAppPath()
    return join(base, 'resources', 'runtime', 'darwin-arm64')
  }

  private resolveHostPath(): string {
    return join(this.resolveRuntimeDir(), 'tm-wechat-host')
  }

  /** Runtime binaries present and executable? Cheap check for the settings UI. */
  isRuntimePresent(): boolean {
    try {
      this.manifest = readMacWechatRuntimeManifest(this.resolveRuntimeDir())
      return true
    } catch {
      return false
    }
  }

  /**
   * Start the host if it is not already running. Deliberately lazy: the host
   * comes up WITHOUT touching WeChat (lazy init inside the host), so "runtime
   * online" and "WeChat bound" stay two independent states.
   */
  async ensureStarted(): Promise<MacWechatRuntimeSnapshot> {
    if (this.lifecycle === 'starting') {
      return this.getSnapshot()
    }

    const runtimeDir = this.resolveRuntimeDir()
    try {
      this.manifest = readMacWechatRuntimeManifest(runtimeDir)
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
    if (await this.ping()) {
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

    this.lifecycle = 'starting'
    this.lastError = null

    try {
      /* Host stderr goes to /dev/null (stdio ignored, see note above), so the
       * host writes its own log file via TM_WECHAT_LOG_FILE. Without this the
       * agent's stage beacons (send-enter / cdn-enter / …) are invisible and a
       * media/CDN stall is undiagnosable. info level so stage beacons show. */
      const hostLogFile = join(app.getPath('logs'), 'tm-wechat-host.log')
      this.child = spawn(
        hostPath,
        [
          '--port',
          String(PORT),
          '--manifest',
          join(runtimeDir, 'runtime-manifest.json'),
          '--log-level',
          'info'
        ],
        {
          cwd: runtimeDir,
          stdio: 'ignore',
          detached: false,
          env: { ...process.env, TM_WECHAT_LOG_FILE: hostLogFile }
        }
      )
    } catch (error) {
      this.lifecycle = 'stopped'
      this.lastError = String(error)
      return this.getSnapshot()
    }

    this.child.on('exit', (code) => {
      const wasBound =
        this.lastBinding?.bound === true ||
        this.lastBinding?.sessionAttached === true ||
        this.lastBinding?.bindingState === 'binding'
      const orphanPid = this.lastBinding?.boundWechatPid || this.lastBinding?.wechatPid || 0
      this.child = null
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
      } else {
        this.lifecycle = 'crashed_unbound'
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
      }
    })

    // Wait for /healthz
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await this.ping()) {
        this.lifecycle = 'online'
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
      if (this.child === null) break // died during startup
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    if (this.lifecycle === 'starting') {
      this.lifecycle = 'crashed_unbound'
      this.lastError = 'host did not answer /healthz in time'
    }
    return this.getSnapshot()
  }

  private request(
    method: string,
    path: string,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<{ status: number | null; body: string }> {
    return new Promise((resolve) => {
      const request = get(
        { host: HOST, port: PORT, path, method, timeout: timeoutMs },
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
      request.on('timeout', () => {
        request.destroy()
        resolve({ status: null, body: '' })
      })
      request.on('error', () => {
        resolve({ status: null, body: '' })
      })
      request.end()
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
      this.lastBinding = JSON.parse(body) as MacWechatBindingStatus
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

  /*
   * Build the legacy PersonalWechatSenderStatus contract from the live mac
   * runtime state. Lives here (not in the capability service) so BOTH the
   * capability mapping and the send path report the same facts without a
   * circular import.
   */
  async buildSenderStatus(): Promise<PersonalWechatSenderStatus> {
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
    if (this.lifecycle === 'stopped') {
      await this.ensureStarted().catch(() => undefined)
    }
    /* Self-heal the status card too: if WeChat was restarted, drop the stale
     * restartRequired before it is read into the UI as an error. */
    try {
      this.manifest = readMacWechatRuntimeManifest(this.resolveRuntimeDir())
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
        endpoint: `http://${HOST}:${PORT}`,
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
    if (this.lifecycle !== 'online') {
      const snapshot = await this.ensureStarted()
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
    return this.ensureStarted()
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
