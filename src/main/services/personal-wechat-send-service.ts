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
import { delimiter, dirname, extname, join, sep, basename } from 'path'
import { resolveBundledFfmpegPath } from '../ffmpeg-path'
import { isReadOnlyMode, logReadOnlySkip } from './read-only-mode'
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
import {
  accountDirectoryBelongsToIdentity,
  readLocalAccountIdentity
} from './local-account-identity'
import { macWechatRuntimeManager } from './mac-wechat-runtime-manager'

const execFileAsync = promisify(execFile)
const WINDOWS_LOOPBACK_HOST = '127.0.0.1'
const REQUEST_TIMEOUT_MS = 20_000
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_VOICE_BYTES = 20 * 1024 * 1024
/** 视频与扩展发送通道的上限保持一致。 */
const MAX_VIDEO_BYTES = 100 * 1024 * 1024
const MAX_FILE_BYTES = 100 * 1024 * 1024
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
  const bundledFfmpeg = resolveBundledFfmpegPath()
  if (!bundledFfmpeg || !existsSync(bundledFfmpeg)) return existing
  return [dirname(bundledFfmpeg), existing].filter(Boolean).join(delimiter)
}

/** Build the environment used by TraceMemo's local voice encoding helpers.。 */
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

  const ffmpegPath = resolveBundledFfmpegPath()
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

  const ffmpegPath = resolveBundledFfmpegPath()
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
  const pcmDurationMs = Math.round((pcm.length / 2 / 24_000) * 1000)
  const encoded = await new SilkAudioEncoder().encode(pcm, 24_000)
  if (!encoded.data.length) throw new Error('语音转换失败：没有得到 SILK 数据')
  const durationMs = encoded.durationMs >= 1000 ? encoded.durationMs : pcmDurationMs
  const convertedPath = join(tmpdir(), `tracememo-voice-${randomBytes(8).toString('hex')}.silk`)
  writeFileSync(convertedPath, encoded.data)
  return {
    filePath: convertedPath,
    ...(durationMs > 0 ? { durationMs } : {}),
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

/** hook 侧用 ANSI API 判文件存在，非 ASCII 路径一律判成不存在，先拷一份 ASCII 副本。 */
export function prepareWindowsMediaFile(
  filePath: string,
  options: { prefix: string; fallbackExtension: string }
): {
  filePath: string
  temporary: boolean
} {
  const normalized = String(filePath || '').trim()
  if (isAsciiPath(normalized)) return { filePath: normalized, temporary: false }

  const extension = extname(normalized).toLowerCase()
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : options.fallbackExtension
  const temporaryPath = join(
    windowsImageTempRoot(),
    `${options.prefix}${randomBytes(8).toString('hex')}${safeExtension}`
  )
  if (!isAsciiPath(temporaryPath)) throw new Error('Windows 媒体临时路径必须只包含 ASCII 字符')
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

export function prepareWindowsImageFile(filePath: string): {
  filePath: string
  temporary: boolean
} {
  return prepareWindowsMediaFile(filePath, { prefix: 'tm-img-', fallbackExtension: '.png' })
}

/** Windows 文件名里不允许出现的字符（控制字符由后面的 ASCII 过滤统一剔除）。 */
const WINDOWS_INVALID_FILE_NAME_CHARS = /[<>:"/\\|?*]/g
/** 单段路径上限 255，给随机后缀与扩展名留出余量。 */
const WINDOWS_TEMP_FILE_STEM_LIMIT = 80

/** 发送组件只认路径 basename 当显示名，改名或非 ASCII 路径都要走副本。 */
export function prepareWindowsFileForSend(
  filePath: string,
  fileName?: string
): { filePath: string; temporary: boolean } {
  const normalized = String(filePath || '').trim()
  const sourceName = basename(normalized)
  const requestedName = basename(String(fileName || '').trim() || sourceName)
  if (isAsciiPath(normalized) && requestedName === sourceName) {
    return { filePath: normalized, temporary: false }
  }

  const extension = extname(requestedName).toLowerCase()
  const safeExtension = /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ''
  const asciiStem = basename(requestedName, extname(requestedName))
    .replace(WINDOWS_INVALID_FILE_NAME_CHARS, '_')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/^[.\s_]+|[.\s_]+$/g, '')
    .slice(0, WINDOWS_TEMP_FILE_STEM_LIMIT)

  const root = windowsImageTempRoot()
  // 同名副本不覆盖：上一笔发送可能还在读文件。
  let temporaryPath = join(root, `${asciiStem || 'tm-file'}${safeExtension}`)
  if (!asciiStem || existsSync(temporaryPath)) {
    temporaryPath = join(
      root,
      `${asciiStem || 'tm-file'}-${randomBytes(4).toString('hex')}${safeExtension}`
    )
  }
  if (!isAsciiPath(temporaryPath)) throw new Error('Windows 文件临时路径必须只包含 ASCII 字符')
  try {
    copyFileSync(normalized, temporaryPath)
  } catch (error) {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // 半拷贝残留只做尽力清理。
    }
    throw error
  }
  return { filePath: temporaryPath, temporary: true }
}

function prepareMacWechatImageFile(
  filePath: string,
  senderWxid: string,
  wechatFilesRoot = WECHAT_FILES_ROOT
): { filePath: string; md5: string } {
  /** Stage the image in WeChat's temporary image directory using the。 */
  const temporaryRoot = findWechatImagePath(wechatFilesRoot, new Date(), senderWxid)
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

const MAC_IMAGE_STAGE_PREFIX = 'tm-'
const MAC_IMAGE_STAGE_RETENTION_MS = 10 * 60 * 1000

function stageMacWechatImageForMessageSourceSend(
  filePath: string,
  senderWxid: string,
  wechatFilesRoot = WECHAT_FILES_ROOT
): string {
  const temporaryRoot = findWechatImagePath(wechatFilesRoot, new Date(), senderWxid)
  if (!temporaryRoot) throw new Error('无法定位当前微信账号的图片临时目录')
  mkdirSync(temporaryRoot, { recursive: true })

  /*
   * 暂存图**不能**在 /sendMsg 返回后立即删除：`ok: true` 只代表 Host 已接受请求，
   * 微信侧是异步读取这个文件的，删早了消息会静默丢失（API 仍回 sent）。
   * 改为按保留期回收，顺手清理超过 10 分钟的历史暂存图，防止异常退出残留。
   */
  const now = Date.now()
  try {
    for (const entry of readdirSync(temporaryRoot)) {
      if (!entry.startsWith(MAC_IMAGE_STAGE_PREFIX)) continue
      const candidate = join(temporaryRoot, entry)
      try {
        if (now - statSync(candidate).mtimeMs > MAC_IMAGE_STAGE_RETENTION_MS) {
          unlinkSync(candidate)
        }
      } catch {
        // Best-effort stale image cleanup.
      }
    }
  } catch {
    // Ignore directory listing errors.
  }

  const extension = extname(filePath).toLowerCase()
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.png'
  const stagedPath = join(
    temporaryRoot,
    `tm-${randomBytes(8).toString('hex')}-${Math.floor(Date.now() / 1000)}${safeExtension}`
  )
  copyFileSync(filePath, stagedPath)
  return stagedPath
}

/**
 * 延迟回收暂存图：微信在 `/sendMsg` 返回后才异步读取该文件，
 * 立即删除会让消息静默丢失；与视频/文件暂存保持同样的「延迟清理」策略。
 */
function scheduleStagedImageCleanup(stagedPath: string): void {
  const timer = setTimeout(() => {
    try {
      unlinkSync(stagedPath)
    } catch {
      // Best-effort delayed cleanup after WeChat finishes asynchronous image upload.
    }
  }, 120_000)
  timer.unref?.()
}

const MAC_VIDEO_STAGE_PREFIX = 'tm-video-'
const MAC_VIDEO_STAGE_RETENTION_MS = 10 * 60 * 1000

/** macOS WeChat 运行在 App Sandbox 容器中，注入在微信进程内的 `libtmwechat.dylib`。 */
export function stageMacWechatVideoForSend(
  filePath: string,
  wechatFilesRoot = WECHAT_FILES_ROOT
): { stagedPath: string; cleanup: () => void } {
  const normalized = String(filePath || '').trim()
  const containerDataRoot = dirname(dirname(wechatFilesRoot))
  if (
    containerDataRoot.includes('com.tencent.xinWeChat') &&
    normalized.startsWith(`${containerDataRoot}${sep}`)
  ) {
    return { stagedPath: normalized, cleanup: () => {} }
  }

  const documentsDir = dirname(wechatFilesRoot)
  const stageDir = existsSync(documentsDir) ? documentsDir : wechatFilesRoot
  mkdirSync(stageDir, { recursive: true })

  // 顺手清理超过 10 分钟的历史暂存视频，防止异常退出残留。
  const now = Date.now()
  try {
    for (const entry of readdirSync(stageDir)) {
      if (!entry.startsWith(MAC_VIDEO_STAGE_PREFIX)) continue
      const candidate = join(stageDir, entry)
      try {
        if (now - statSync(candidate).mtimeMs > MAC_VIDEO_STAGE_RETENTION_MS) {
          unlinkSync(candidate)
        }
      } catch {
        // Best-effort stale file cleanup.
      }
    }
  } catch {
    // Ignore directory listing errors.
  }

  const extension = extname(normalized).toLowerCase()
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.mp4'
  const stagedPath = join(
    stageDir,
    `${MAC_VIDEO_STAGE_PREFIX}${randomBytes(6).toString('hex')}-${now}${safeExtension}`
  )
  copyFileSync(normalized, stagedPath)

  return {
    stagedPath,
    cleanup: () => {
      const timer = setTimeout(() => {
        try {
          unlinkSync(stagedPath)
        } catch {
          // Best-effort delayed cleanup after WeChat finishes asynchronous video upload.
        }
      }, 120_000)
      timer.unref?.()
    }
  }
}

const MAC_FILE_STAGE_PREFIX = 'tm-file-'
const MAC_FILE_STAGE_RETENTION_MS = 10 * 60 * 1000

export function stageMacWechatFileForSend(
  filePath: string,
  wechatFilesRoot = WECHAT_FILES_ROOT
): { stagedPath: string; cleanup: () => void } {
  const normalized = String(filePath || '').trim()
  const containerDataRoot = dirname(dirname(wechatFilesRoot))
  if (
    containerDataRoot.includes('com.tencent.xinWeChat') &&
    normalized.startsWith(`${containerDataRoot}${sep}`)
  ) {
    return { stagedPath: normalized, cleanup: () => {} }
  }

  const documentsDir = dirname(wechatFilesRoot)
  const stageDir = existsSync(documentsDir) ? documentsDir : wechatFilesRoot
  mkdirSync(stageDir, { recursive: true })

  const now = Date.now()
  try {
    for (const entry of readdirSync(stageDir)) {
      if (!entry.startsWith(MAC_FILE_STAGE_PREFIX)) continue
      const candidate = join(stageDir, entry)
      try {
        if (now - statSync(candidate).mtimeMs > MAC_FILE_STAGE_RETENTION_MS) {
          unlinkSync(candidate)
        }
      } catch {
        // Best-effort stale file cleanup.
      }
    }
  } catch {
    // Ignore directory listing errors.
  }

  const extension = extname(normalized).toLowerCase()
  const safeExtension = /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '.bin'
  const stagedPath = join(
    stageDir,
    `${MAC_FILE_STAGE_PREFIX}${randomBytes(6).toString('hex')}-${now}${safeExtension}`
  )
  copyFileSync(normalized, stagedPath)

  return {
    stagedPath,
    cleanup: () => {
      const timer = setTimeout(() => {
        try {
          unlinkSync(stagedPath)
        } catch {
          // Best-effort delayed cleanup after WeChat finishes asynchronous upload.
        }
      }, 300_000)
      timer.unref?.()
    }
  }
}

/** Locate the current account's temporary image directory consumed by the image send path. */
export function findWechatImagePath(
  root = WECHAT_FILES_ROOT,
  now = new Date(),
  senderWxid?: string
): string | undefined {
  try {
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const candidates: Array<{ path: string; mtime: number }> = []
    const fallbacks: Array<{ path: string; mtime: number }> = []
    for (const account of readdirSync(root)) {
      if (senderWxid && !accountDirectoryBelongsToIdentity(account, senderWxid)) continue
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
  if (request.type === 'video') {
    return {
      endpoint: '/SendMsg',
      body: { toWxid: target, type: 'video', msg: String(request.filePath || '').trim() }
    }
  }

  if (request.type === 'file') {
    return {
      endpoint: '/SendMsg',
      body: { toWxid: target, type: 'file', msg: String(request.filePath || '').trim() }
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
    canSendVideo: false,
    canSendFile: false,
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

function isDefinitiveImageSourcePreparationFailure(message: string): boolean {
  return message.trim() === 'IMAGE_PREPARATION_FAILED:0'
}

/** 发送链路诊断日志（排查「hook 报成功、群里却没有消息」时用）。 */
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

/** 能力轮询会反复打这些端点，成功时不计入发送诊断，否则日志被探测刷满。 */
const WINDOWS_PROBE_ENDPOINTS = new Set(['/getLoginInfo'])

/** 发送完成后**保留**图片临时文件的时长（毫秒）。默认 `0` = 立刻删除（现行行为）。 */
const WINDOWS_TEMP_IMAGE_GRACE_MS = 0

/** 视频上传在 send_message 返回后才开始，删早了接收端只能拿到空文件。 */
const WINDOWS_TEMP_VIDEO_GRACE_MS = 10 * 60 * 1000

/** 文件副本保留窗口：`/SendMsg` 返回时微信还在读，删早了接收端拿到空文件。 */
const WINDOWS_TEMP_FILE_GRACE_MS = 10 * 60 * 1000

// unref: 不让清理定时器拖住进程退出
function scheduleTempFileCleanup(target: string, delayMs: number): void {
  const timer = setTimeout(() => {
    try {
      unlinkSync(target)
    } catch {
      // best effort
    }
  }, delayMs)
  timer.unref?.()
}

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
  const isProbe = WINDOWS_PROBE_ENDPOINTS.has(endpoint)
  if (!isProbe) {
    logSendDiagnostic('hook-request', {
      endpoint,
      method,
      // 只报 payload 里有没有内容，不报内容本身。
      hasPayload: method !== 'GET' ? init.body !== undefined : false
    })
  }
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
  if (!isProbe) {
    logSendDiagnostic('hook-response', {
      endpoint,
      httpStatus: response.status,
      ok: true,
      ret: typeof parsed.ret === 'number' ? parsed.ret : null,
      retMessageLength: String(parsed.retmsg ?? parsed.msg ?? '').length,
      elapsedMs: Date.now() - startedAt
    })
  }
  return parsed
}

export class PersonalWechatSendService {
  constructor(private readonly wechatFilesRoot = WECHAT_FILES_ROOT) {}

  async getStatus(): Promise<PersonalWechatSenderStatus> {
    if (process.platform === 'darwin') {
      const configuredPort = normalizeWindowsWechatPort(loadSettings().windowsWechatPort)
      if (!configuredPort) {
        const base = windowsStatusBase('')
        return {
          ...base,
          platform: 'darwin',
          arch: process.arch,
          state: 'error',
          message: '尚未配置微信发送能力端口',
          error: '请先输入端口并检测后保存'
        }
      }
      return this.getMacPortStatus(configuredPort)
    }
    return this.getWindowsStatus()
  }

  async checkWindowsStatus(port?: string): Promise<PersonalWechatSenderStatus> {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return this.getStatus()
    const normalizedPort = normalizeWindowsWechatPort(port)
    if (!normalizedPort) {
      const base = windowsStatusBase()
      return {
        ...base,
        platform: process.platform,
        arch: process.arch,
        state: 'error',
        message: '请输入 1 到 65535 之间的微信发送能力端口',
        error: '端口格式无效或为空'
      }
    }
    if (process.platform === 'darwin') return this.getMacPortStatus(normalizedPort)
    return this.getWindowsStatus(normalizedPort)
  }

  getLatestVoiceDiagnostic(): PersonalWechatVoiceDiagnostic | null {
    return latestVoiceDiagnostic ? { ...latestVoiceDiagnostic } : null
  }

  async send(request: PersonalWechatSendRequest): Promise<PersonalWechatSendResult> {
    if (isReadOnlyMode()) {
      logReadOnlySkip('个人微信发送')
      return {
        success: false,
        status: await this.getStatus(),
        error: '只读测试模式：不发送任何微信消息'
      }
    }
    if (process.platform === 'win32') return this.sendWindows(request)
    if (process.platform === 'darwin') {
      if (request.type === 'text') return this.sendMacText(request)
      if (request.type === 'image') return this.sendMacImage(request)
      if (request.type === 'voice') return this.sendMacVoice(request)
      if (request.type === 'video') return this.sendMacVideo(request)
      if (request.type === 'file') return this.sendMacFile(request)
    }
    return {
      success: false,
      status: await this.getStatus(),
      error: '当前系统暂不支持个人微信发送'
    }
  }

  async rebind(): Promise<PersonalWechatSenderStatus> {
    return this.getStatus()
  }

  private resolveMacHostPort(): number {
    const configured = normalizeWindowsWechatPort(loadSettings().windowsWechatPort)
    if (configured) return Number(configured)
    return macWechatRuntimeManager.getPort()
  }

  private async ensureMacSenderReady(): Promise<PersonalWechatSenderStatus> {
    const configured = normalizeWindowsWechatPort(loadSettings().windowsWechatPort)
    if (configured) {
      return this.getMacPortStatus(configured)
    }
    await macWechatRuntimeManager.ensureStarted()
    return macWechatRuntimeManager.buildSenderStatus()
  }

  private async resolveMacCurrentStatus(): Promise<PersonalWechatSenderStatus> {
    const configured = normalizeWindowsWechatPort(loadSettings().windowsWechatPort)
    if (configured) {
      return this.getMacPortStatus(configured)
    }
    return macWechatRuntimeManager.buildSenderStatus()
  }

  private async resolveMacSendMechanism(versionHint?: string): Promise<string | undefined> {
    const configured = normalizeWindowsWechatPort(loadSettings().windowsWechatPort)
    if (!configured) {
      return macWechatRuntimeManager.getSendMechanism()
    }
    const ver = String(versionHint || '').trim()
    if (ver.startsWith('4.1.11.')) return 'legacy-req2buf'
    if (ver.startsWith('4.1.13.')) return 'native-msg-object'
    return 'tm-message-source-send'
  }

  private async getMacPortStatus(port?: string): Promise<PersonalWechatSenderStatus> {
    const host = windowsHookHost(port)
    const base: PersonalWechatSenderStatus = {
      ...windowsStatusBase(host || ''),
      platform: 'darwin',
      arch: process.arch
    }
    if (!host) {
      return {
        ...base,
        state: 'error',
        message: '尚未配置微信发送能力端口',
        error: '请先输入端口并检测后保存'
      }
    }
    try {
      const result = await requestWindowsHook('/getLoginInfo', {}, 15_000, 'GET', host)
      const loggedIn = parseWindowsLoginStatus(result)
      const pid = typeof result.pid === 'number' && result.pid > 0 ? result.pid : 1
      const wechatVersion = typeof result.version === 'string' ? result.version : '4.1.15.55'
      const connected = {
        wechatRunning: true,
        wechatPid: pid,
        boundWechatPid: pid,
        wechatVersion,
        runtimeReady: true,
        endpointReady: true,
        attachReady: true,
        baseAddressReady: true,
        textHookInstalled: true,
        textHookReady: loggedIn,
        imageHookInstalled: loggedIn,
        imageHookReady: loggedIn,
        messageListenerReady: loggedIn
      }
      if (!loggedIn) {
        const msg =
          typeof result.message === 'string' && result.message.trim()
            ? result.message.trim()
            : '微信发送能力已连接，但微信尚未登录或尚未完成绑定'
        return {
          ...base,
          ...connected,
          state: 'hook_not_ready',
          message: msg,
          error: typeof result.error === 'string' && result.error.trim() ? result.error.trim() : msg
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
        canSendVideo: true,
        canSendFile: true,
        message: '微信发送能力已连接，可以发送消息'
      }
    } catch (error) {
      return {
        ...base,
        state: 'wechat_not_running',
        message: '未检测到微信发送能力，请先通过授权管理器注入并启动微信',
        error: error instanceof Error ? error.message : String(error)
      }
    }
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
        canSendVideo: true,
        canSendFile: true,
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

  /** macOS native runtime 的文字发送：HTTP POST /sendText 到 tm-wechat-host。 */
  private async sendMacText(
    request: Extract<PersonalWechatSendRequest, { type: 'text' }>
  ): Promise<PersonalWechatSendResult> {
    const initialStatus = await this.ensureMacSenderReady()
    if (!initialStatus.canSendText) {
      return {
        success: false,
        status: initialStatus,
        error: initialStatus.message || '微信发送能力未就绪'
      }
    }
    const sendMechanism = await this.resolveMacSendMechanism(initialStatus.wechatVersion)
    if (request.at && sendMechanism !== 'tm-message-source-send') {
      return {
        success: false,
        status: initialStatus,
        error: '当前微信发送组件不支持原生群聊 @，请升级微信与发送组件'
      }
    }
    if (sendMechanism === 'tm-message-source-send') {
      const result = await this.postMacHost(
        '/sendMsg',
        {
          type: 'text',
          to: request.to,
          text: request.text,
          is_group: Boolean(request.isGroup),
          ...(request.at ? { at: request.at } : {})
        },
        50_000
      )
      const status = await this.resolveMacCurrentStatus()
      if (!result?.ok) {
        return { success: false, status, error: result?.message || '文字发送失败' }
      }
      return { success: true, status }
    }

    const payload = JSON.stringify({
      to: request.to,
      text: request.text,
      isGroup: Boolean(request.isGroup)
    })
    const response = await fetch(`http://127.0.0.1:${this.resolveMacHostPort()}/sendText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(40_000)
    }).catch(() => null)

    if (response === null || !response.ok) {
      const status = await this.resolveMacCurrentStatus()
      return {
        success: false,
        status,
        error: `发送请求失败（HTTP ${response?.status ?? '无响应'}）`
      }
    }

    const result = (await response.json()) as { code: number; ok: boolean; message: string }
    const resultStatus = await this.resolveMacCurrentStatus()
    if (!result.ok) {
      return { success: false, status: resultStatus, error: result.message || '发送失败' }
    }
    return { success: true, status: resultStatus }
  }

  /** Resolve the bound account's own wxid from the local WeChat data root.。 */
  private async resolveMacSenderWxid(): Promise<string> {
    const identity = readLocalAccountIdentity(this.wechatFilesRoot)
    return identity?.wxid ?? ''
  }

  private async postMacHost(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number
  ): Promise<{ code: number; ok: boolean; message: string } | null> {
    const response = await fetch(`http://127.0.0.1:${this.resolveMacHostPort()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    }).catch(() => null)
    if (response === null || !response.ok) return null
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!payload) return null
    /** 不同 Host 路由的响应形状不一致：`/sendText` 等返回 `{ok}`。 */
    const explicitFailure = payload.ok === false || payload.status === false
    const ok =
      !explicitFailure &&
      (payload.ok === true || payload.status === true || payload.ret === 0 || payload.code === 0)
    return {
      code: Number(payload.code ?? payload.ret ?? (ok ? 0 : 1)),
      ok,
      message: String(payload.message ?? payload.msg ?? '')
    }
  }

  /** macOS 视频发送：`POST /SendMsg`，body 为 `{toWxid, type:'video', msg:<绝对路径>}`。 */
  private async sendMacVideo(
    request: Extract<PersonalWechatSendRequest, { type: 'video' }>
  ): Promise<PersonalWechatSendResult> {
    const status = await this.ensureMacSenderReady()
    if (!status.canSendVideo) {
      return {
        success: false,
        status,
        error: status.message || '当前微信发送组件不支持视频，请升级后重试'
      }
    }
    const filePath = String(request.filePath || '').trim()
    if (!filePath || !existsSync(filePath)) {
      return { success: false, status, error: '请选择有效的视频文件' }
    }
    const size = statSync(filePath).size
    if (size <= 0 || size > MAX_VIDEO_BYTES) {
      return { success: false, status, error: '视频必须小于 100 MB' }
    }

    let staged: { stagedPath: string; cleanup: () => void } | null = null
    try {
      staged = stageMacWechatVideoForSend(filePath, this.wechatFilesRoot)
    } catch (error) {
      const latest = await this.resolveMacCurrentStatus()
      return {
        success: false,
        status: latest,
        error: error instanceof Error ? error.message : '无法将视频暂存到微信沙盒目录'
      }
    }

    try {
      const result = await this.postMacHost(
        '/SendMsg',
        { toWxid: request.to, type: 'video', msg: staged.stagedPath },
        180_000
      )
      const latest = await this.resolveMacCurrentStatus()
      if (!result?.ok) {
        return { success: false, status: latest, error: result?.message || '视频发送失败' }
      }
      return { success: true, status: latest }
    } finally {
      staged.cleanup()
    }
  }

  private async sendMacFile(
    request: Extract<PersonalWechatSendRequest, { type: 'file' }>
  ): Promise<PersonalWechatSendResult> {
    const status = await this.ensureMacSenderReady()
    if (!status.canSendFile) {
      return {
        success: false,
        status,
        error: status.message || '当前微信发送组件不支持文件，请升级后重试'
      }
    }
    const filePath = String(request.filePath || '').trim()
    if (!filePath || !existsSync(filePath)) {
      return { success: false, status, error: '请选择有效的文件' }
    }
    const size = statSync(filePath).size
    if (size <= 0 || size > MAX_FILE_BYTES) {
      return { success: false, status, error: '文件必须小于 100 MB' }
    }
    const fileName = String(request.fileName || '').trim() || basename(filePath)

    let staged: { stagedPath: string; cleanup: () => void } | null = null
    try {
      staged = stageMacWechatFileForSend(filePath, this.wechatFilesRoot)
    } catch (error) {
      const latest = await this.resolveMacCurrentStatus()
      return {
        success: false,
        status: latest,
        error: error instanceof Error ? error.message : '无法将文件暂存到微信沙盒目录'
      }
    }

    try {
      const result = await this.postMacHost(
        '/sendMsg',
        { to: request.to, type: 'file', path: staged.stagedPath, name: fileName },
        180_000
      )
      const latest = await this.resolveMacCurrentStatus()
      if (!result?.ok) {
        return { success: false, status: latest, error: result?.message || '文件发送失败' }
      }
      return { success: true, status: latest }
    } finally {
      staged.cleanup()
    }
  }

  private async sendMacImage(
    request: Extract<PersonalWechatSendRequest, { type: 'image' }>
  ): Promise<PersonalWechatSendResult> {
    const initialStatus = await this.ensureMacSenderReady()
    const fail = async (error: string): Promise<PersonalWechatSendResult> => {
      const status = await this.resolveMacCurrentStatus()
      return { success: false, status, error }
    }
    if (!initialStatus.canSendImage) {
      return fail('微信发送能力未就绪')
    }
    const filePath = String(request.filePath || '').trim()
    if (!filePath || !existsSync(filePath)) return fail('请选择有效的图片文件')
    const sendMechanism = await this.resolveMacSendMechanism(initialStatus.wechatVersion)
    const sender = await this.resolveMacSenderWxid()
    if (!sender) return fail('无法识别当前微信账号 wxid')
    if (sendMechanism === 'tm-message-source-send') {
      let stagedPath = ''
      let sourceError = ''
      try {
        stagedPath = stageMacWechatImageForMessageSourceSend(filePath, sender, this.wechatFilesRoot)
        const sent = await this.postMacHost(
          '/sendMsg',
          { type: 'image', to: request.to, path: stagedPath },
          55_000
        )
        const status = await this.resolveMacCurrentStatus()
        if (!sent?.ok) {
          sourceError = sent?.message || '图片发送失败'
        } else {
          /*
           * 不能在这里 unlink：微信在 /sendMsg 返回后仍会异步读取该文件，
           * 删早了消息会静默丢失，而 API 已经返回 success。
           * 改为延迟回收（2 分钟）+ 下次发送时清扫过期文件。
           */
          if (stagedPath) scheduleStagedImageCleanup(stagedPath)
          return { success: true, status }
        }
      } catch (error) {
        sourceError = error instanceof Error ? error.message : String(error)
      }
      if (!isDefinitiveImageSourcePreparationFailure(sourceError)) return fail(sourceError)
    }

    let uploadPath = ''
    try {
      const prepared = prepareMacWechatImageFile(filePath, sender, this.wechatFilesRoot)
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
      const status = await this.resolveMacCurrentStatus()
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
    const initialStatus = await this.ensureMacSenderReady()
    const fail = async (
      error: string,
      failurePhase = 'preflight'
    ): Promise<PersonalWechatSendResult> => {
      logVoiceAttempt(requestId, 'failed', { failure_phase: failurePhase, error })
      const status = await this.resolveMacCurrentStatus()
      return { success: false, status, error }
    }
    if (!initialStatus.canSendVoice) {
      return fail('微信发送能力未就绪')
    }
    const filePath = String(request.filePath || '').trim()
    if (!filePath || !existsSync(filePath)) return fail('请选择有效的语音文件')
    const sendMechanism = await this.resolveMacSendMechanism(initialStatus.wechatVersion)
    let sender = ''
    if (sendMechanism !== 'tm-message-source-send') {
      sender = await this.resolveMacSenderWxid()
      if (!sender) return fail('无法识别当前微信账号 wxid')
    }

    /** Reuse the Windows SILK preparation: it already normalizes any input to。 */
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
      if (sendMechanism === 'tm-message-source-send') {
        if (durationMs < 1000) return fail('原生语音发送要求时长至少 1 秒', 'duration')
        const sent = await this.postMacHost(
          '/sendMsg',
          {
            type: 'voice',
            to: request.to,
            voice_hex: silkData.toString('hex'),
            duration_ms: durationMs
          },
          55_000
        )
        if (!sent?.ok) {
          return fail(sent?.message || '语音发送失败', 'send')
        }
        const status = await this.resolveMacCurrentStatus()
        logVoiceAttempt(requestId, 'completed', { send_result: '0' })
        return { success: true, status }
      }

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
      const status = await this.resolveMacCurrentStatus()
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
      const label =
        request.type === 'voice'
          ? '语音'
          : request.type === 'video'
            ? '视频'
            : request.type === 'file'
              ? '文件'
              : '图片'
      const limit =
        request.type === 'voice'
          ? MAX_VOICE_BYTES
          : request.type === 'video'
            ? MAX_VIDEO_BYTES
            : request.type === 'file'
              ? MAX_FILE_BYTES
              : MAX_IMAGE_BYTES
      if (!filePath || !existsSync(filePath)) {
        const status = await this.getWindowsStatus()
        return { success: false, status, error: `请选择有效的${label}文件` }
      }
      const size = statSync(filePath).size
      if (size <= 0 || size > limit) {
        const status = await this.getWindowsStatus()
        return {
          success: false,
          status,
          error: `${label}必须小于 ${Math.round(limit / (1024 * 1024))} MB`
        }
      }
      request = { ...request, to, filePath }
    }

    const status = await this.getWindowsStatus()
    if (!status.canSend) return { success: false, status, error: status.error || status.message }

    let temporaryImagePath: string | undefined
    let temporaryVideoPath: string | undefined
    let temporaryVoicePath: string | undefined
    let temporaryFilePath: string | undefined
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
      } else if (request.type === 'video') {
        const preparedVideo = prepareWindowsMediaFile(request.filePath, {
          prefix: 'tm-video-',
          fallbackExtension: '.mp4'
        })
        temporaryVideoPath = preparedVideo.temporary ? preparedVideo.filePath : undefined
        logSendDiagnostic('video-prepared', {
          sourceBytes: safeFileSize(request.filePath),
          usedTempCopy: preparedVideo.temporary,
          copiedBytes: safeFileSize(preparedVideo.filePath)
        })
        const windowsRequest = buildWindowsWechatRequest({
          ...request,
          filePath: preparedVideo.filePath
        })
        await requestWindowsHook(windowsRequest.endpoint, windowsRequest.body, 180_000)
      } else if (request.type === 'file') {
        const preparedFile = prepareWindowsFileForSend(request.filePath, request.fileName)
        temporaryFilePath = preparedFile.temporary ? preparedFile.filePath : undefined
        logSendDiagnostic('file-prepared', {
          sourceBytes: safeFileSize(request.filePath),
          usedTempCopy: preparedFile.temporary,
          copiedBytes: safeFileSize(preparedFile.filePath)
        })
        const windowsRequest = buildWindowsWechatRequest({
          ...request,
          filePath: preparedFile.filePath
        })
        // 文件构造 appmsg 后还要走 CDN 上传，超时阈值按视频档给。
        await requestWindowsHook(windowsRequest.endpoint, windowsRequest.body, 180_000)
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
      const raw = error instanceof Error ? error.message : String(error)
      // 老版发送组件不认 type=file，只会回校验错误 → 换成可操作的文案。
      const message =
        request.type === 'file' && /type must be/i.test(raw)
          ? '当前微信发送组件不支持文件发送，请升级发送组件后重试'
          : raw
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
      if (temporaryVideoPath) {
        scheduleTempFileCleanup(temporaryVideoPath, WINDOWS_TEMP_VIDEO_GRACE_MS)
      }
      if (temporaryFilePath) {
        scheduleTempFileCleanup(temporaryFilePath, WINDOWS_TEMP_FILE_GRACE_MS)
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
