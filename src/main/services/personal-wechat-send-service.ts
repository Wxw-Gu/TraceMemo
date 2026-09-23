import { execFile } from 'child_process'
import { createHash, randomBytes, randomUUID } from 'crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { homedir, tmpdir } from 'os'
import { delimiter, dirname, extname, join, sep } from 'path'
import ffmpegStaticPath from 'ffmpeg-static'
import { promisify } from 'util'
import type {
  PersonalWechatSendRequest,
  PersonalWechatSendResult,
  PersonalWechatSenderStatus,
  PersonalWechatVoiceDiagnostic
} from '../../shared/personal-wechat'
import { loadSettings } from './settings-store'
import { SilkAudioDecoder, SilkAudioEncoder } from '../voice-pipeline/audio-decoder'
import { appLogger } from '../app-logger'
import { readLocalAccountIdentity } from './local-account-identity'
import { macWechatRuntimeManager } from './mac-wechat-runtime-manager'

const execFileAsync = promisify(execFile)
const WINDOWS_LOOPBACK_HOST = '127.0.0.1'
const REQUEST_TIMEOUT_MS = 20_000
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_VOICE_BYTES = 20 * 1024 * 1024
// 语音编码由 native runtime 内的 SILK 实现完成，不再是外部编码器进程。
const VOICE_ENCODER_NAME = 'silk'
const VOICE_ENCODER_VERSION = 'tm-wechat-native'
let latestVoiceDiagnostic: PersonalWechatVoiceDiagnostic | null = null
const WECHAT_FILES_ROOT = join(
  homedir(),
  'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files'
)

const ASCII_PATH_PATTERN = /^[\x20-\x7e]+$/

function isAsciiPath(value: string): boolean {
  return ASCII_PATH_PATTERN.test(value)
}

export function normalizeWindowsWechatPort(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (!/^\d{1,5}$/.test(text)) return null
  const port = Number(text)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  return String(port)
}

function windowsHookHost(port?: unknown): string | null {
  const configuredPort =
    port === undefined
      ? normalizeWindowsWechatPort(loadSettings().windowsWechatPort)
      : normalizeWindowsWechatPort(port)
  return configuredPort ? `${WINDOWS_LOOPBACK_HOST}:${configuredPort}` : null
}

export function buildPersonalWechatRuntimePath(): string {
  const existing = String(process.env['PATH'] || '')
  const bundledFfmpeg = String(ffmpegStaticPath || '')
    .replace('app.asar', 'app.asar.unpacked')
    .trim()
  if (!bundledFfmpeg || !existsSync(bundledFfmpeg)) return existing
  return [dirname(bundledFfmpeg), existing].filter(Boolean).join(delimiter)
}

/**
 * Build the environment used by TraceMemo's local voice encoding helpers.
 * Keep this in one place so environment checks cannot accidentally inspect a
 * different ffmpeg than the sender process.
 */
export function buildPersonalWechatRuntimeEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: buildPersonalWechatRuntimePath()
  }
}

const VOICE_DIAGNOSTIC_KEYS = new Set([
  'input_bytes',
  'normalized_input_bytes',
  'pcm_size',
  'sample_rate',
  'channels',
  'input_duration_ms',
  'upload_result',
  'upload_data_len',
  'silk_duration_ms',
  'send_result',
  'voice_send_mode',
  'failure_phase',
  'error'
])

function redactVoiceDiagnosticDetails(details: Record<string, unknown>): Record<string, unknown> {
  const allowedDetails = Object.fromEntries(
    Object.entries(details).filter(([key]) => VOICE_DIAGNOSTIC_KEYS.has(key))
  )
  if (allowedDetails.error !== undefined) {
    const rawError = String(allowedDetails.error).trim()
    allowedDetails.error = rawError
      .replace(
        /(["']?(?:aesKey|cdnKey|token|cookie|authorization|access_token|secret|apiKey)["']?\s*[:=]\s*["']?)([^"',;\]}\s]+)(["']?)/gi,
        '$1[redacted]$3'
      )
      .replace(/Bearer\s+[^\s,;\]}"']+/gi, 'Bearer [redacted]')
      .slice(0, 1_000)
  }
  return allowedDetails
}

export function buildPersonalWechatVoiceDiagnostic(
  requestId: string,
  phase: PersonalWechatVoiceDiagnostic['phase'],
  details: Record<string, unknown>,
  previous: PersonalWechatVoiceDiagnostic | null = null
): PersonalWechatVoiceDiagnostic {
  const allowedDetails = redactVoiceDiagnosticDetails(details)
  return {
    ...(previous?.request_id === requestId ? previous : {}),
    request_id: requestId,
    voice_id: requestId,
    phase,
    encoder_name: VOICE_ENCODER_NAME,
    encoder_version: VOICE_ENCODER_VERSION,
    ...allowedDetails
  }
}

function logVoiceAttempt(
  requestId: string,
  phase: PersonalWechatVoiceDiagnostic['phase'],
  details: Record<string, unknown> = {}
): void {
  latestVoiceDiagnostic = buildPersonalWechatVoiceDiagnostic(
    requestId,
    phase,
    details,
    latestVoiceDiagnostic
  )
  const allowedDetails = redactVoiceDiagnosticDetails(details)
  appLogger.write({
    level: phase === 'failed' ? 'error' : 'info',
    scope: 'personal-wechat-voice',
    message: `voice_${phase}`,
    details: {
      request_id: requestId,
      voice_id: requestId,
      encoder_name: VOICE_ENCODER_NAME,
      encoder_version: VOICE_ENCODER_VERSION,
      ...allowedDetails
    }
  })
}

async function detectVoiceDurationMs(filePath: string): Promise<number | undefined> {
  const data = readFileSync(filePath)
  if (data.subarray(0, 10).equals(Buffer.from('\x02#!SILK_V3'))) {
    const decoded = await new SilkAudioDecoder().decode({
      data,
      codec: 'silk',
      sourceHash: createHash('sha256').update(data).digest('hex')
    })
    const samples = decoded.channels > 0 ? decoded.pcm.length / 2 / decoded.channels : 0
    if (samples > 0 && decoded.sampleRate > 0) {
      return Math.round((samples / decoded.sampleRate) * 1000)
    }
  }

  const ffmpegPath = String(ffmpegStaticPath || '').replace('app.asar', 'app.asar.unpacked')
  if (!ffmpegPath || !existsSync(ffmpegPath)) return undefined
  let output = ''
  try {
    const result = await execFileAsync(ffmpegPath, ['-i', filePath, '-f', 'null', '-'], {
      maxBuffer: 2 * 1024 * 1024
    })
    output = `${result.stdout || ''}\n${result.stderr || ''}`
  } catch (error) {
    output = `${(error as { stdout?: string }).stdout || ''}\n${(error as { stderr?: string }).stderr || ''}`
  }
  const match = output.match(/Duration:\s*(\d+):(\d{2}):(\d+(?:\.\d+)?)/i)
  if (match) {
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000)
  }
  return undefined
}

async function prepareWindowsVoiceFile(filePath: string): Promise<{
  filePath: string
  durationMs?: number
  temporary: boolean
}> {
  const source = readFileSync(filePath)
  if (source.subarray(0, 10).equals(Buffer.from('\x02#!SILK_V3'))) {
    return { filePath, durationMs: await detectVoiceDurationMs(filePath), temporary: false }
  }

  const ffmpegPath = String(ffmpegStaticPath || '').replace('app.asar', 'app.asar.unpacked')
  if (!ffmpegPath || !existsSync(ffmpegPath)) {
    throw new Error('Windows 语音发送需要可用的 FFmpeg 才能转换为 SILK')
  }
  const result = await execFileAsync(
    ffmpegPath,
    ['-v', 'error', '-i', filePath, '-ar', '24000', '-ac', '1', '-f', 's16le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: MAX_VOICE_BYTES }
  )
  const pcm = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '')
  if (!pcm.length) throw new Error('语音转换失败：没有得到 PCM 音频数据')
  const encoded = await new SilkAudioEncoder().encode(pcm, 24_000)
  if (!encoded.data.length) throw new Error('语音转换失败：没有得到 SILK 数据')
  const convertedPath = join(tmpdir(), `tracememo-voice-${randomBytes(8).toString('hex')}.silk`)
  writeFileSync(convertedPath, encoded.data)
  return {
    filePath: convertedPath,
    ...(encoded.durationMs > 0 ? { durationMs: encoded.durationMs } : {}),
    temporary: true
  }
}

function windowsImageTempRoot(): string {
  const candidates = [
    process.platform === 'win32' && process.env['PUBLIC']
      ? join(process.env['PUBLIC'], 'TraceMemo', 'temp')
      : undefined,
    process.platform === 'win32' && process.env['ProgramData']
      ? join(process.env['ProgramData'], 'TraceMemo', 'temp')
      : undefined,
    process.platform === 'win32' ? join('C:', 'Users', 'Public', 'TraceMemo', 'temp') : undefined,
    tmpdir(),
    process.env['TEMP'],
    process.env['TMP']
  ]
  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim()
    if (!normalized || !isAsciiPath(normalized)) continue
    try {
      mkdirSync(normalized, { recursive: true })
      return normalized
    } catch {
      //
    }
  }
  throw new Error('无法创建 Windows 图片临时目录')
}

export function prepareWindowsImageFile(filePath: string): {
  filePath: string
  temporary: boolean
} {
  const normalized = String(filePath || '').trim()
  if (isAsciiPath(normalized)) return { filePath: normalized, temporary: false }

  const extension = extname(normalized).toLowerCase()
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.png'
  const temporaryPath = join(
    windowsImageTempRoot(),
    `tm-img-${randomBytes(8).toString('hex')}${safeExtension}`
  )
  if (!isAsciiPath(temporaryPath)) throw new Error('Windows 图片临时路径必须只包含 ASCII 字符')
  try {
    copyFileSync(normalized, temporaryPath)
  } catch (error) {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // A partially copied file is best-effort cleanup only.
    }
    throw error
  }
  return { filePath: temporaryPath, temporary: true }
}

function prepareMacWechatImageFile(filePath: string): { filePath: string; md5: string } {
  /* Stage the image in WeChat's temporary image directory using the
   * filename/hash layout required by the macOS native send path:
   * - stage inside the active account's ImageTemp tree selected by
   *   findWechatImagePath(), not an arbitrary readable sandbox directory;
   * - append a per-send salt before calculating MD5, so the staged image and
   *   the MD5 passed to the CDN task describe the same unique byte stream. */
  const temporaryRoot = findWechatImagePath()
  if (!temporaryRoot) throw new Error('无法定位当前微信账号的图片临时目录')
  mkdirSync(temporaryRoot, { recursive: true })
  const extension = extname(filePath).toLowerCase()
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension.slice(1) : 'png'
  const source = readFileSync(filePath)
  const salt = Buffer.from(
    `\n#md5_salt_${process.hrtime.bigint()}_${Math.floor(Math.random() * 10_000)}#`,
    'utf8'
  )
  const staged = Buffer.concat([source, salt])
  const temporaryPath = join(
    temporaryRoot,
    `${randomBytes(8).toString('hex')}_${Math.floor(Date.now() / 1000)}.${safeExtension}`
  )
  writeFileSync(temporaryPath, staged, { mode: 0o644 })
  return {
    filePath: temporaryPath,
    md5: createHash('md5').update(staged).digest('hex')
  }
}

/** Locate the current account's temporary image directory consumed by the image send path. */
export function findWechatImagePath(
  root = WECHAT_FILES_ROOT,
  now = new Date()
): string | undefined {
  try {
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const candidates: Array<{ path: string; mtime: number }> = []
    const fallbacks: Array<{ path: string; mtime: number }> = []
    for (const account of readdirSync(root)) {
      const tempRoot = join(root, account, 'temp')
      if (!existsSync(tempRoot)) continue
      fallbacks.push({
        path: join(tempRoot, 'ImageTemp', month),
        mtime: statSync(tempRoot).mtimeMs
      })
      const imageTempPath = join(tempRoot, 'ImageTemp', month)
      if (existsSync(imageTempPath)) {
        candidates.push({ path: imageTempPath, mtime: statSync(imageTempPath).mtimeMs })
      }
      for (const tempId of readdirSync(tempRoot)) {
        const imagePath = join(tempRoot, tempId, month, 'Img')
        if (existsSync(imagePath)) {
          candidates.push({ path: imagePath, mtime: statSync(imagePath).mtimeMs })
        }
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    fallbacks.sort((a, b) => b.mtime - a.mtime)
    const selected = candidates[0]?.path || fallbacks[0]?.path
    return selected ? `${selected}${sep}` : undefined
  } catch {
    return undefined
  }
}

async function requestWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 2_000
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

type WindowsHookResponse = Record<string, unknown>

export class WindowsHookHttpError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string
  ) {
    const detail = responseBody.trim()
    super(detail ? `HTTP ${status}: ${detail.slice(0, 1_000)}` : `HTTP ${status}`)
    this.name = 'WindowsHookHttpError'
  }
}

export function parseWindowsHookResponse(
  responseText: string,
  requireSuccessRet = false
): WindowsHookResponse {
  const normalized = responseText.trim()
  if (!normalized) throw new Error('Windows 微信发送能力返回空响应')

  let parsed: unknown
  try {
    parsed = JSON.parse(normalized)
  } catch {
    throw new Error(`Windows 微信发送能力返回无效 JSON：${normalized.slice(0, 200)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Windows 微信发送能力返回格式无效')
  }

  const response = parsed as WindowsHookResponse
  if (requireSuccessRet && response.ret !== 0) {
    const detail = response.retmsg ?? response.msg
    throw new Error(
      detail ? String(detail) : `Windows 微信发送能力返回失败：ret=${String(response.ret)}`
    )
  }
  return response
}

export function parseWindowsLoginStatus(response: WindowsHookResponse): boolean {
  return response.status === true
}

export function buildWindowsWechatRequest(
  request: PersonalWechatSendRequest,
  options: { filePath?: string; durationMs?: number } = {}
): {
  endpoint: string
  body: Record<string, unknown>
} {
  const target = String(request.to || '').trim()
  if (request.type === 'text') {
    return {
      endpoint: '/SendMsg',
      body: { toWxid: target, type: 'text', msg: request.text.trim() }
    }
  }
  if (request.type === 'image') {
    return {
      endpoint: '/SendMsg',
      body: { toWxid: target, type: 'image', msg: String(request.filePath || '').trim() }
    }
  }

  const fromId = String(request.fromId || '').trim()
  const filePath = String(options.filePath || request.filePath || '').trim()
  const durationMs = options.durationMs ?? request.durationMs
  return {
    endpoint: '/SendMsg',
    body: {
      toWxid: target,
      type: 'voice',
      msg: filePath,
      ...(fromId ? { fromWxid: fromId } : {}),
      ...(durationMs !== undefined ? { duration: durationMs } : {})
    }
  }
}

function windowsStatusBase(host = windowsHookHost() || ''): PersonalWechatSenderStatus {
  return {
    state: 'checking',
    platform: process.platform,
    arch: process.arch,
    sipDisabled: true,
    wechatRunning: false,
    runtimeReady: false,
    endpoint: host,
    endpointReady: false,
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
    message: '正在检查 Windows 微信消息接口'
  }
}

/** 文件字节数；读不到时返回 `-1`（**不是** 0 —— 0 会被误读成「空文件」）。 */
function safeFileSize(target: string): number {
  try {
    return statSync(target).size
  } catch {
    return -1
  }
}

/**
 * 发送链路诊断日志（排查「hook 报成功、群里却没有消息」时用）。
 *
 * 只有在设置里打开「调试模式」时才输出，所以正常使用不会刷屏。
 *
 * **隐私约束**：只允许输出类型、字节数、HTTP 状态码、hook 的 `ret` 这类结构性字段。
 * 文件名、完整路径、wxid、群名、消息正文不进日志。
 */
function logSendDiagnostic(
  stage: string,
  detail: Record<string, string | number | boolean | null>
): void {
  try {
    if (!loadSettings().debugEnabled) return
  } catch {
    return
  }
  console.log(`[SendDiag] ${stage} ${JSON.stringify(detail)}`)
}

/**
 * 发送完成后**保留**图片临时文件的时长（毫秒）。默认 `0` = 立刻删除（现行行为）。
 *
 * 为什么留这个开关：`finally` 里的删除发生在 **hook 返回之后**，这隐含假设
 * 「hook 返回时发送已经完成」。如果 hook 其实是「先回 200、后台再读文件」，
 * 文件就可能在它读到之前已经被删掉 —— 现象正好是「hook 报成功、微信里没有消息」。
 *
 * 置为非 0 时可分辨两类失败：保留期间图片到了 ⇒ 删除时机问题（修法与 hook 约定文件生命周期）；
 * 仍然没到 ⇒ 与文件生命周期无关。
 */
const WINDOWS_TEMP_IMAGE_GRACE_MS = 0

async function requestWindowsHook(
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
  method: 'GET' | 'POST' = 'POST',
  host = windowsHookHost()
): Promise<WindowsHookResponse> {
  if (!host) throw new Error('尚未配置微信发送能力端口')
  const startedAt = Date.now()
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' }
  }
  if (method !== 'GET') init.body = JSON.stringify(body)
  logSendDiagnostic('hook-request', {
    endpoint,
    method,
    // 只报 payload 里有没有内容，不报内容本身。
    hasPayload: method !== 'GET' ? init.body !== undefined : false
  })
  const response = await requestWithTimeout(`http://${host}${endpoint}`, init, timeoutMs)
  const responseText = await response.text()
  if (!response.ok) {
    // HTTP 层失败：状态码不是隐私，正文可能是（hook 有时会把请求原样回显）。
    logSendDiagnostic('hook-response', {
      endpoint,
      httpStatus: response.status,
      ok: false,
      bodyLength: responseText.length,
      elapsedMs: Date.now() - startedAt
    })
    throw new WindowsHookHttpError(response.status, responseText)
  }
  const parsed = parseWindowsHookResponse(responseText, method === 'POST')
  logSendDiagnostic('hook-response', {
    endpoint,
    httpStatus: response.status,
    ok: true,
    ret: typeof parsed.ret === 'number' ? parsed.ret : null,
    retMessageLength: String(parsed.retmsg ?? parsed.msg ?? '').length,
    elapsedMs: Date.now() - startedAt
  })
  return parsed
}

export class PersonalWechatSendService {
  async getStatus(): Promise<PersonalWechatSenderStatus> {
    // macOS 发送能力完全由 native runtime（tm-wechat-host）提供，
    // 这里保持同源，避免出现第二套状态判断。
    if (process.platform === 'darwin') return macWechatRuntimeManager.buildSenderStatus()
    return this.getWindowsStatus()
  }

  async checkWindowsStatus(port?: string): Promise<PersonalWechatSenderStatus> {
    if (process.platform !== 'win32') return this.getStatus()
    const normalizedPort = normalizeWindowsWechatPort(port)
    if (!normalizedPort) {
      const base = windowsStatusBase()
      return {
        ...base,
        state: 'error',
        message: '请输入 1 到 65535 之间的微信发送能力端口',
        error: '端口格式无效或为空'
      }
    }
    return this.getWindowsStatus(normalizedPort)
  }

  getLatestVoiceDiagnostic(): PersonalWechatVoiceDiagnostic | null {
    return latestVoiceDiagnostic ? { ...latestVoiceDiagnostic } : null
  }

  async send(request: PersonalWechatSendRequest): Promise<PersonalWechatSendResult> {
    if (process.platform === 'win32') return this.sendWindows(request)
    if (process.platform === 'darwin') {
      if (request.type === 'text') return this.sendMacText(request)
      if (request.type === 'image') return this.sendMacImage(request)
      if (request.type === 'voice') return this.sendMacVoice(request)
    }
    return {
      success: false,
      status: await this.getStatus(),
      error: '当前系统暂不支持个人微信发送'
    }
  }

  async rebind(): Promise<PersonalWechatSenderStatus> {
    return this.getWindowsStatus()
  }

  private async getWindowsStatus(port?: string): Promise<PersonalWechatSenderStatus> {
    const host = windowsHookHost(port)
    const base = windowsStatusBase(host || '')
    if (!host) {
      return {
        ...base,
        state: 'error',
        message: '尚未配置微信发送能力端口',
        error: '请先输入端口并检测后保存'
      }
    }
    try {
      const result = await requestWindowsHook('/getLoginInfo', {}, 3_000, 'GET', host)
      const loggedIn = parseWindowsLoginStatus(result)
      const connected = {
        wechatRunning: true,
        runtimeReady: true,
        endpointReady: true,
        attachReady: true,
        baseAddressReady: true,
        textHookInstalled: false,
        textHookReady: false,
        imageHookInstalled: false,
        imageHookReady: false,
        messageListenerReady: false
      }
      if (!loggedIn) {
        return {
          ...base,
          ...connected,
          state: 'hook_not_ready',
          message: 'Windows 微信发送能力已连接，但微信尚未登录',
          error: 'getLoginInfo 返回 status=false，登录后才能发送消息'
        }
      }

      return {
        ...base,
        ...connected,
        state: 'online' as const,
        canSend: true,
        canSendText: true,
        canSendImage: true,
        canSendVoice: true,
        message: 'Windows 微信发送能力已连接，可以发送消息'
      }
    } catch (error) {
      return {
        ...base,
        state: 'wechat_not_running',
        message: '未检测到 Windows 微信发送能力，请先启动并登录微信',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /*
   * macOS native runtime 的文字发送：HTTP POST /sendText 到 tm-wechat-host。
   * 绑定状态由 host 侧保证；未绑定/未就绪时返回与旧契约一致的结果结构。
   */
  private async sendMacText(
    request: Extract<PersonalWechatSendRequest, { type: 'text' }>
  ): Promise<PersonalWechatSendResult> {
    await macWechatRuntimeManager.ensureStarted()
    const initialStatus = await macWechatRuntimeManager.buildSenderStatus()
    if (!initialStatus.canSendText) {
      return {
        success: false,
        status: initialStatus,
        error: initialStatus.message || '微信发送能力未就绪'
      }
    }

    const payload = JSON.stringify({
      to: request.to,
      text: request.text,
      isGroup: Boolean(request.isGroup)
    })
    const response = await fetch(`http://127.0.0.1:${macWechatRuntimeManager.getPort()}/sendText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(40_000)
    }).catch(() => null)

    if (response === null || !response.ok) {
      const status = await macWechatRuntimeManager.buildSenderStatus()
      return {
        success: false,
        status,
        error: `发送请求失败（HTTP ${response?.status ?? '无响应'}）`
      }
    }

    const result = (await response.json()) as { code: number; ok: boolean; message: string }
    const resultStatus = await macWechatRuntimeManager.buildSenderStatus()
    if (!result.ok) {
      return { success: false, status: resultStatus, error: result.message || '发送失败' }
    }
    return { success: true, status: resultStatus }
  }

  /*
   * Resolve the bound account's own wxid from the local WeChat data root.
   * The media proto embeds the sender, and the mac runtime does not learn it
   * from inbound traffic, so it is read from
   * the on-disk account identity instead.
   */
  private async resolveMacSenderWxid(): Promise<string> {
    const identity = readLocalAccountIdentity(WECHAT_FILES_ROOT)
    return identity?.wxid ?? ''
  }

  private async postMacHost(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number
  ): Promise<{ code: number; ok: boolean; message: string } | null> {
    const response = await fetch(`http://127.0.0.1:${macWechatRuntimeManager.getPort()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    }).catch(() => null)
    if (response === null || !response.ok) return null
    return (await response.json().catch(() => null)) as {
      code: number
      ok: boolean
      message: string
    } | null
  }

  private async sendMacImage(
    request: Extract<PersonalWechatSendRequest, { type: 'image' }>
  ): Promise<PersonalWechatSendResult> {
    await macWechatRuntimeManager.ensureStarted()
    const initialStatus = await macWechatRuntimeManager.buildSenderStatus()
    const fail = async (error: string): Promise<PersonalWechatSendResult> => {
      const status = await macWechatRuntimeManager.buildSenderStatus()
      return { success: false, status, error }
    }
    if (!initialStatus.canSendImage) {
      return fail('微信发送能力未就绪')
    }
    const filePath = String(request.filePath || '').trim()
    if (!filePath || !existsSync(filePath)) return fail('请选择有效的图片文件')

    const sender = await this.resolveMacSenderWxid()
    if (!sender) return fail('无法识别当前微信账号 wxid')

    let uploadPath = ''
    try {
      const prepared = prepareMacWechatImageFile(filePath)
      uploadPath = prepared.filePath
      const upload = await this.postMacHost(
        '/uploadImage',
        { to: request.to, md5: prepared.md5, filePath: uploadPath },
        20_000
      )
      if (!upload || !upload.ok) {
        return fail(upload?.message || '图片上传失败')
      }
      const sent = await this.postMacHost('/sendImage', { sender, to: request.to }, 50_000)
      if (!sent || !sent.ok) {
        return fail(sent?.message || '图片发送失败')
      }
      const status = await macWechatRuntimeManager.buildSenderStatus()
      return { success: true, status }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    } finally {
      if (uploadPath) {
        try {
          unlinkSync(uploadPath)
        } catch {
          // Upload staging cleanup is best effort.
        }
      }
    }
  }

  private async sendMacVoice(
    request: Extract<PersonalWechatSendRequest, { type: 'voice' }>
  ): Promise<PersonalWechatSendResult> {
    const requestId = randomUUID()
    await macWechatRuntimeManager.ensureStarted()
    const initialStatus = await macWechatRuntimeManager.buildSenderStatus()
    const fail = async (
      error: string,
      failurePhase = 'preflight'
    ): Promise<PersonalWechatSendResult> => {
      logVoiceAttempt(requestId, 'failed', { failure_phase: failurePhase, error })
      const status = await macWechatRuntimeManager.buildSenderStatus()
      return { success: false, status, error }
    }
    if (!initialStatus.canSendVoice) {
      return fail('微信发送能力未就绪')
    }
    const filePath = String(request.filePath || '').trim()
    if (!filePath || !existsSync(filePath)) return fail('请选择有效的语音文件')

    const sender = await this.resolveMacSenderWxid()
    if (!sender) return fail('无法识别当前微信账号 wxid')

    /* Reuse the Windows SILK preparation: it already normalizes any input to
     * SILK and reports the duration. */
    let temporaryVoicePath: string | undefined
    try {
      const prepared = await prepareWindowsVoiceFile(filePath)
      temporaryVoicePath = prepared.temporary ? prepared.filePath : undefined
      const silkData = readFileSync(prepared.filePath)
      const requestedDuration = Number(request.durationMs)
      const rawDuration =
        Number.isFinite(requestedDuration) && requestedDuration > 0
          ? requestedDuration
          : prepared.durationMs
      if (!rawDuration || !Number.isFinite(rawDuration)) {
        return fail('无法计算语音时长', 'duration')
      }
      const durationMs = Math.max(1, Math.min(60_000, Math.round(rawDuration)))
      logVoiceAttempt(requestId, 'prepared', {
        input_bytes: statSync(filePath).size,
        normalized_input_bytes: silkData.length,
        silk_duration_ms: durationMs
      })

      const upload = await this.postMacHost(
        '/uploadVoice',
        {
          to: request.to,
          filePath: prepared.filePath,
          audioDataHex: silkData.toString('hex'),
          voiceDurationMs: durationMs
        },
        30_000
      )
      if (!upload || !upload.ok) {
        return fail(upload?.message || '语音上传失败', 'upload')
      }
      const sent = await this.postMacHost('/sendVoice', { sender, to: request.to }, 50_000)
      if (!sent || !sent.ok) {
        return fail(sent?.message || '语音发送失败', 'send')
      }
      const status = await macWechatRuntimeManager.buildSenderStatus()
      logVoiceAttempt(requestId, 'completed', { send_result: '0' })
      return { success: true, status }
    } finally {
      if (temporaryVoicePath) {
        try {
          unlinkSync(temporaryVoicePath)
        } catch {
          // 临时语音只做尽力清理，清理失败不应覆盖真实发送结果。
        }
      }
    }
  }

  private async sendWindows(request: PersonalWechatSendRequest): Promise<PersonalWechatSendResult> {
    const to = String(request?.to || '').trim()
    if (!to) {
      const status = await this.getWindowsStatus()
      return { success: false, status, error: '接收者不能为空' }
    }
    if (request.type === 'text') {
      const text = String(request.text || '').trim()
      if (!text) {
        const status = await this.getWindowsStatus()
        return { success: false, status, error: '文字内容不能为空' }
      }
      if (text.length > 2_000) {
        const status = await this.getWindowsStatus()
        return { success: false, status, error: '文字内容不能超过 2000 个字符' }
      }
      request = { ...request, to, text }
    } else {
      const filePath = String(request.filePath || '').trim()
      if (!filePath || !existsSync(filePath)) {
        const status = await this.getWindowsStatus()
        return {
          success: false,
          status,
          error: `请选择有效的${request.type === 'voice' ? '语音' : '图片'}文件`
        }
      }
      const size = statSync(filePath).size
      if (size <= 0 || size > (request.type === 'voice' ? MAX_VOICE_BYTES : MAX_IMAGE_BYTES)) {
        const status = await this.getWindowsStatus()
        return {
          success: false,
          status,
          error: `${request.type === 'voice' ? '语音' : '图片'}必须小于 20 MB`
        }
      }
      request = { ...request, to, filePath }
    }

    const status = await this.getWindowsStatus()
    if (!status.canSend) return { success: false, status, error: status.error || status.message }

    let temporaryImagePath: string | undefined
    let temporaryVoicePath: string | undefined
    try {
      if (request.type === 'text') {
        const windowsRequest = buildWindowsWechatRequest(request)
        await requestWindowsHook(windowsRequest.endpoint, windowsRequest.body)
      } else if (request.type === 'image') {
        const preparedImage = prepareWindowsImageFile(request.filePath)
        temporaryImagePath = preparedImage.temporary ? preparedImage.filePath : undefined
        // 关键证据：源文件有多大、是否走了临时副本、副本拷出来多大。
        // `copiedBytes < sourceBytes` ⇒ 截断的拷贝：拷贝中途失败不会抛错，
        // 只看「有没有文件」会漏掉这种情况。
        logSendDiagnostic('image-prepared', {
          sourceBytes: safeFileSize(request.filePath),
          usedTempCopy: preparedImage.temporary,
          copiedBytes: safeFileSize(preparedImage.filePath)
        })
        const windowsRequest = buildWindowsWechatRequest({
          ...request,
          filePath: preparedImage.filePath
        })
        await requestWindowsHook(windowsRequest.endpoint, windowsRequest.body, 60_000)
      } else if (request.type === 'voice') {
        const fromId = String(request.fromId || '').trim()
        if (!fromId) throw new Error('无法识别当前微信账号 wxid，无法发送语音')
        const preparedVoice = await prepareWindowsVoiceFile(request.filePath)
        temporaryVoicePath = preparedVoice.temporary ? preparedVoice.filePath : undefined
        const requestedDuration = Number(request.durationMs)
        const rawDuration =
          Number.isFinite(requestedDuration) && requestedDuration > 0
            ? requestedDuration
            : preparedVoice.durationMs
        if (!rawDuration || !Number.isFinite(rawDuration)) {
          throw new Error('无法计算语音时长，请重新生成或选择有效的 SILK 文件')
        }
        const durationMs = Math.max(1, Math.min(60_000, Math.round(rawDuration)))
        const windowsRequest = buildWindowsWechatRequest(request, {
          filePath: preparedVoice.filePath,
          durationMs
        })
        await requestWindowsHook(windowsRequest.endpoint, windowsRequest.body, 60_000)
      } else {
        const windowsRequest = buildWindowsWechatRequest(request)
        await requestWindowsHook(windowsRequest.endpoint, windowsRequest.body, 60_000)
      }
      return { success: true, status: await this.getWindowsStatus() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        status: { ...(await this.getWindowsStatus()), state: 'error', error: message },
        error: `发送失败：${message}`
      }
    } finally {
      if (temporaryImagePath) {
        if (WINDOWS_TEMP_IMAGE_GRACE_MS > 0) {
          // 诊断模式：先不删，等一段时间再删（见常量注释）。
          const pending = temporaryImagePath
          setTimeout(() => {
            try {
              unlinkSync(pending)
            } catch {
              // best effort
            }
          }, WINDOWS_TEMP_IMAGE_GRACE_MS).unref?.()
        } else {
          try {
            unlinkSync(temporaryImagePath)
          } catch {
            // Temporary files are best-effort cleanup only.
          }
        }
      }
      if (temporaryVoicePath) {
        try {
          unlinkSync(temporaryVoicePath)
        } catch {
          // Temporary files are best-effort cleanup only.
        }
      }
    }
  }
}

export const personalWechatSendService = new PersonalWechatSendService()
