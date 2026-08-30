import { app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { createConnection } from 'net'
import { homedir, tmpdir } from 'os'
import { delimiter, dirname, join, sep } from 'path'
import ffmpegStaticPath from 'ffmpeg-static'
import { promisify } from 'util'
import type {
  PersonalWechatSendRequest,
  PersonalWechatSendResult,
  PersonalWechatSenderStatus,
  PersonalWechatVoiceDiagnostic
} from '../../shared/personal-wechat'
import { isPackagedRuntime } from '../runtime-mode'
import { loadSettings, updateSettings } from './settings-store'
import { SilkAudioDecoder, SilkAudioEncoder } from '../voice-pipeline/audio-decoder'
import {
  validateVoicePcm,
  validateVoiceSilkMetadata,
  VOICE_FRAME_BYTES,
  type VoicePcmMetadata
} from '../voice-pipeline/voice-quality'
import { appLogger } from '../app-logger'

const execFileAsync = promisify(execFile)
const DEFAULT_HOST = '127.0.0.1:58080'
const WINDOWS_LOOPBACK_HOST = '127.0.0.1'
const START_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 3_000
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_VOICE_BYTES = 20 * 1024 * 1024
const MAX_PCM_BYTES = 64 * 1024 * 1024
const VOICE_ENCODER_NAME = 'go-silk'
const VOICE_ENCODER_VERSION = 'wechat_chatter-v0.0.18'
let latestVoiceDiagnostic: PersonalWechatVoiceDiagnostic | null = null
const WECHAT_APP_PATH = '/Applications/WeChat.app'
const WECHAT_FILES_ROOT = join(
  homedir(),
  'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files'
)

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

export interface RuntimeLayout {
  root: string
  executable: string
  workingDirectory: string
  configDirectory: string
  logPath: string
}

export type PersonalWechatHookReadiness = 'unknown' | 'initializing' | 'ready' | 'failed'

export function parsePersonalWechatHookLog(log: string): {
  readiness: PersonalWechatHookReadiness
  attached: boolean
  baseAddress?: string
  textHookInstalled: boolean
  textHookReady: boolean
  imageHookInstalled: boolean
  imageHookReady: boolean
  messageListenerReady: boolean
  boundWechatPid?: number
  error?: string
} {
  let readiness: PersonalWechatHookReadiness = 'unknown'
  let attached = false
  let baseAddress: string | undefined
  let textHookInstalled = false
  let textHookReady = false
  let imageHookInstalled = false
  let imageHookReady = false
  let messageListenerReady = false
  let boundWechatPid: number | undefined
  let error: string | undefined
  for (const line of log.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as {
        payload?: string
        err?: string
        message?: string
        PID?: number
        type?: string
        result?: string | number
      }
      const text = `${entry.payload || ''} ${entry.err || ''} ${entry.message || ''}`
      // wechat_chatter writes the task receipt and its result as two separate
      // JSON log records: the first has type=send_image, while the next has
      // the result and the Chinese result message but no type field.
      if (
        (entry.type === 'send_image' || text.includes('发送图片任务执行结果')) &&
        String(entry.result) === '1'
      ) {
        imageHookInstalled = true
        imageHookReady = true
      }
      if (
        (entry.type === 'image' || text.includes('上传图片任务执行结果')) &&
        String(entry.result) === '0'
      ) {
        imageHookInstalled = true
      }
      if (text.includes('使用指定的微信进程 PID')) {
        readiness = 'unknown'
        attached = false
        baseAddress = undefined
        textHookInstalled = false
        textHookReady = false
        imageHookInstalled = false
        imageHookReady = false
        messageListenerReady = false
        boundWechatPid = Number(entry.PID) || undefined
        error = undefined
      } else if (
        text.includes("Cannot find 'req2buf' keyword") ||
        text.includes('Attach 失败') ||
        text.includes('unable to intercept function')
      ) {
        readiness = 'failed'
        error = entry.err || entry.message
      } else if (text.includes('成功 Attach 微信进程')) {
        attached = true
        boundWechatPid = Number(entry.PID) || boundWechatPid
      } else if (text.includes('Base address from range:')) {
        baseAddress = text.match(/Base address from range:\s*(0x[0-9a-f]+)/i)?.[1]
      } else if (text.includes('WeChat core module base:')) {
        baseAddress = text.match(/WeChat core module base:\s*(0x[0-9a-f]+)/i)?.[1]
      } else if (text.includes('triggerX0 或 triggerX1Payload 尚未初始化')) {
        readiness = 'initializing'
        error = '微信发送能力尚未就绪，消息没有发出'
      } else if (text.includes('捕获到 StartTask 调用')) {
        readiness = 'ready'
        textHookReady = true
        error = undefined
      } else if (text.includes('Dynamic Text Message Setup Complete')) {
        textHookInstalled = true
        if (readiness === 'unknown') readiness = 'initializing'
      } else if (text.includes('捕获到图片上传上下文')) {
        imageHookReady = true
      } else if (text.includes('图片上传 Hook Setup Complete')) {
        imageHookInstalled = true
      } else if (text.includes('HTTP 服务启动在')) {
        messageListenerReady = true
      } else if (text.includes('发送数据')) {
        messageListenerReady = true
      }
    } catch {
      // Ignore non-JSON or partially written log lines.
    }
  }
  return {
    readiness,
    attached,
    ...(baseAddress ? { baseAddress } : {}),
    textHookInstalled,
    textHookReady,
    imageHookInstalled,
    imageHookReady,
    messageListenerReady,
    ...(boundWechatPid ? { boundWechatPid } : {}),
    ...(error ? { error } : {})
  }
}

interface PreflightResult {
  status: PersonalWechatSenderStatus
  runtime?: RuntimeLayout
}

function toConfigFileName(version: string): string {
  return `${version.replace(/\./g, '_')}_mac.json`
}

function runtimeCandidates(): string[] {
  const override = String(process.env['WECHAT_CHATTER_RUNTIME_DIR'] || '').trim()
  const relative = ['connectors', 'wechat-personal', `${process.platform}-${process.arch}`]
  const downloaded = join(app.getPath('userData'), ...relative)
  const packaged = join(process.resourcesPath, 'resources', ...relative)
  const development = join(app.getAppPath(), 'resources', ...relative)
  const ordered = isPackagedRuntime()
    ? [downloaded, packaged, development]
    : [downloaded, development, packaged]
  return override ? [override, ...ordered] : ordered
}

export function findPersonalWechatRuntime(candidates = runtimeCandidates()): RuntimeLayout | null {
  for (const root of candidates) {
    const nestedExecutable = join(root, 'onebot', 'onebot')
    const flatExecutable = join(root, 'onebot')
    if (existsSync(nestedExecutable) && existsSync(join(root, 'onebot', 'script.js'))) {
      return {
        root,
        executable: nestedExecutable,
        workingDirectory: join(root, 'onebot'),
        configDirectory: join(root, 'wechat_version'),
        logPath: join(root, 'onebot', 'log', 'macos.log')
      }
    }
    if (existsSync(flatExecutable) && existsSync(join(root, 'script.js'))) {
      return {
        root,
        executable: flatExecutable,
        workingDirectory: root,
        configDirectory: join(root, 'wechat_version'),
        logPath: join(root, 'log', 'macos.log')
      }
    }
  }
  return null
}

export function buildPersonalWechatOneBotRequest(
  request: PersonalWechatSendRequest,
  fileBase64?: string
): {
  endpoint: string
  body: Record<string, unknown>
} {
  const target = request.to.trim()
  const isGroup = request.isGroup || target.endsWith('@chatroom')
  const message =
    request.type === 'text'
      ? [{ type: 'text', data: { text: request.text.trim() } }]
      : [
          {
            type: request.type === 'voice' ? 'record' : 'image',
            data: { file: `base64://${fileBase64 || ''}` }
          }
        ]
  return {
    endpoint: isGroup ? '/send_group_msg' : '/send_private_msg',
    body: {
      ...(isGroup ? { group_id: target } : { user_id: target }),
      message
    }
  }
}

function buildRuntimePath(): string {
  const existing = String(process.env['PATH'] || '')
  const bundledFfmpeg = String(ffmpegStaticPath || '')
    .replace('app.asar', 'app.asar.unpacked')
    .trim()
  if (!bundledFfmpeg || !existsSync(bundledFfmpeg)) return existing
  return [dirname(bundledFfmpeg), existing].filter(Boolean).join(delimiter)
}

function buildRuntimePythonPath(runtimeRoot: string): string {
  return [join(runtimeRoot, 'python'), String(process.env['PYTHONPATH'] || '')]
    .filter(Boolean)
    .join(delimiter)
}

function bundledFfmpegExecutable(): string {
  const bundledFfmpeg = String(ffmpegStaticPath || '')
    .replace('app.asar', 'app.asar.unpacked')
    .trim()
  return bundledFfmpeg && existsSync(bundledFfmpeg) ? bundledFfmpeg : 'ffmpeg'
}

async function convertAudioToPcm(audioData: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bundledFfmpegExecutable(),
      ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'],
      {
        env: { ...process.env, PATH: buildRuntimePath() },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
    const chunks: Buffer[] = []
    let total = 0
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_PCM_BYTES) {
        child.kill()
        reject(new Error('转换后的语音 PCM 过大'))
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, 2_000)
    })
    child.once('error', (error) => reject(new Error(`ffmpeg 转换失败：${error.message}`)))
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg 转换失败${stderr ? `：${stderr.trim()}` : ''}`))
        return
      }
      resolve(Buffer.concat(chunks))
    })
    child.stdin.end(audioData)
  })
}

async function runtimeVoiceLogSnapshot(): Promise<{ path: string; offset: number } | undefined> {
  const runtime = findPersonalWechatRuntime()
  const runningOneBot = await readOneBotProcessInfo()
  // Prefer the runtime discovered by TraceMemo itself. Its path may contain
  // spaces (for example, "Application Support"), so parsing `ps` output with
  // a whitespace-delimited regex can produce a non-existent log path.
  const executable =
    runtime?.executable &&
    runningOneBot &&
    (runningOneBot.command === runtime.executable ||
      runningOneBot.command.startsWith(`${runtime.executable} `))
      ? runtime.executable
      : runningOneBot?.command.match(/^(.*\/onebot(?:\/onebot)?)(?:\s|$)/)?.[1]
  const processLogPath = executable ? join(dirname(executable), 'log', 'macos.log') : undefined
  const logPath = processLogPath && existsSync(processLogPath) ? processLogPath : runtime?.logPath
  if (!logPath || !existsSync(logPath)) return undefined
  try {
    return { path: logPath, offset: statSync(logPath).size }
  } catch {
    return undefined
  }
}

function readVoiceRuntimeEvidence(snapshot?: { path: string; offset: number }): {
  uploadResult?: string
  uploadDataLen?: number
  durationMs?: number
  sendResult?: string
} {
  if (!snapshot || !existsSync(snapshot.path)) return {}
  try {
    const data = readFileSync(snapshot.path)
    const lines = data
      .subarray(Math.min(snapshot.offset, data.length))
      .toString('utf8')
      .split(/\r?\n/)
    const evidence: {
      uploadResult?: string
      uploadDataLen?: number
      durationMs?: number
      sendResult?: string
    } = {}
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        const message = `${String(entry.msg || '')} ${String(entry.message || '')}`
        if (message.includes('上传语音任务执行结果')) {
          if (entry.result !== undefined) evidence.uploadResult = String(entry.result)
          if (entry.silk_len !== undefined) evidence.uploadDataLen = Number(entry.silk_len)
          if (entry.duration_ms !== undefined) evidence.durationMs = Number(entry.duration_ms)
        }
        if (message.includes('发送语音任务执行结果') && entry.result !== undefined) {
          evidence.sendResult = String(entry.result)
        }
      } catch {
        // Ignore a partially-written runtime log line.
      }
    }
    return evidence
  } catch {
    return {}
  }
}

async function waitForVoiceRuntimeEvidence(
  snapshot: { path: string; offset: number } | undefined,
  timeoutMs = 6_000
): Promise<{
  uploadResult?: string
  uploadDataLen?: number
  durationMs?: number
  sendResult?: string
}> {
  if (!snapshot) return {}
  const startedAt = Date.now()
  let evidence = readVoiceRuntimeEvidence(snapshot)
  while (Date.now() - startedAt < timeoutMs) {
    // The OneBot HTTP handler acknowledges the task before its worker writes
    // the upload/send callbacks to disk. Poll the request's log suffix so a
    // successful asynchronous send is not reported as a validation failure.
    if (
      evidence.uploadResult !== undefined &&
      (evidence.uploadResult !== '0' || evidence.sendResult !== undefined)
    ) {
      return evidence
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    evidence = readVoiceRuntimeEvidence(snapshot)
  }
  return evidence
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

function createWavBuffer(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

async function prepareVoiceFile(filePath: string): Promise<Buffer> {
  const data = readFileSync(filePath)
  if (!data.subarray(0, 10).equals(Buffer.from('\x02#!SILK_V3'))) return data
  const decoded = await new SilkAudioDecoder().decode({
    data,
    codec: 'silk',
    sourceHash: createHash('sha256').update(data).digest('hex')
  })
  return createWavBuffer(decoded.pcm, decoded.sampleRate, decoded.channels)
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

async function readWechatVersion(): Promise<string> {
  const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :WeChatBundleVersion',
    join(WECHAT_APP_PATH, 'Contents', 'Info.plist')
  ])
  return stdout.trim()
}

async function readWechatPid(): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/pgrep', ['-x', 'WeChat'])
    const pid = Number(stdout.trim().split(/\s+/)[0])
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** Locate the current account's temporary image directory required by the upstream hook. */
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

async function isSipDisabled(): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync('/usr/bin/csrutil', ['status'])
    return `${stdout}\n${stderr}`.toLowerCase().includes('disabled')
  } catch {
    return false
  }
}

interface OneBotProcessInfo {
  pid: number
  boundWechatPid?: number
  imagePath?: string
  command: string
}

async function readOneBotProcessInfo(): Promise<OneBotProcessInfo | undefined> {
  try {
    const { stdout } = await execFileAsync('/usr/sbin/lsof', [
      '-nP',
      '-t',
      `-iTCP:${DEFAULT_HOST.split(':')[1]}`,
      '-sTCP:LISTEN'
    ])
    const pid = Number(stdout.trim().split(/\s+/)[0])
    if (!Number.isInteger(pid) || pid <= 0) return undefined
    const { stdout: commandOutput } = await execFileAsync('/bin/ps', [
      '-p',
      String(pid),
      '-o',
      'command='
    ])
    const command = commandOutput.trim()
    if (!/(^|\/)onebot(?:\s|$)/.test(command)) return undefined
    const boundWechatPid = Number(command.match(/-wechat_pid=(\d+)/)?.[1]) || undefined
    const imagePath = command.match(/-image_path=(\S+)/)?.[1]
    return {
      pid,
      ...(boundWechatPid ? { boundWechatPid } : {}),
      ...(imagePath ? { imagePath } : {}),
      command
    }
  } catch {
    return undefined
  }
}

async function terminateOneBot(info: OneBotProcessInfo): Promise<void> {
  if (!/(^|\/)onebot(?:\s|$)/.test(info.command)) return
  await terminateProcess(info.pid)
}

async function terminateProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const startedAt = Date.now()
  while (Date.now() - startedAt < STOP_TIMEOUT_MS) {
    try {
      process.kill(pid, 0)
      await new Promise((resolve) => setTimeout(resolve, 100))
    } catch {
      return
    }
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // The process exited between the last liveness check and the forced stop.
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

async function requestWindowsHook(
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
  method: 'GET' | 'POST' = 'POST',
  host = windowsHookHost()
): Promise<WindowsHookResponse> {
  if (!host) throw new Error('尚未配置微信发送能力端口')
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' }
  }
  if (method !== 'GET') init.body = JSON.stringify(body)
  const response = await requestWithTimeout(`http://${host}${endpoint}`, init, timeoutMs)
  const responseText = await response.text()
  if (!response.ok) throw new Error(responseText || `HTTP ${response.status}`)
  return parseWindowsHookResponse(responseText, method === 'POST')
}

export class PersonalWechatSendService {
  private child: ChildProcess | null = null
  private startPromise: Promise<PersonalWechatSenderStatus> | null = null
  private lastError = ''
  private voiceSendTail: Promise<void> = Promise.resolve()
  private keepOneBotProcess = Boolean(loadSettings().keepPersonalWechatProcess)

  getKeepOneBotProcess(): boolean {
    return this.keepOneBotProcess
  }

  setKeepOneBotProcess(keep: boolean): boolean {
    this.keepOneBotProcess = keep
    updateSettings({ keepPersonalWechatProcess: keep })
    return this.keepOneBotProcess
  }

  async getStatus(): Promise<PersonalWechatSenderStatus> {
    if (process.platform === 'win32') return this.getWindowsStatus()
    const preflight = await this.preflight()
    const [endpointReady, oneBot] = await Promise.all([
      this.isEndpointOnline(),
      readOneBotProcessInfo()
    ])
    const hook = this.readHookReadiness(preflight.runtime)
    const boundWechatPid = oneBot?.boundWechatPid || hook.boundWechatPid
    const boundToCurrentWechat = Boolean(
      preflight.status.wechatPid && boundWechatPid === preflight.status.wechatPid
    )
    const common = {
      ...preflight.status,
      endpointReady,
      ...(oneBot?.pid ? { oneBotPid: oneBot.pid } : {}),
      ...(boundWechatPid ? { boundWechatPid } : {}),
      attachReady: hook.attached,
      ...(hook.baseAddress ? { baseAddress: hook.baseAddress } : {}),
      baseAddressReady: Boolean(hook.baseAddress),
      textHookInstalled: hook.textHookInstalled,
      textHookReady: hook.textHookReady,
      imageHookInstalled: hook.imageHookInstalled,
      imageHookReady: hook.imageHookReady,
      messageListenerReady: hook.messageListenerReady
    }
    if (!endpointReady) return common
    if (!boundToCurrentWechat) {
      return {
        ...common,
        state: 'hook_not_ready',
        canSend: false,
        canSendText: false,
        canSendImage: false,
        message: 'OneBot 仍绑定旧微信进程，请点击“绑定微信”'
      }
    }
    if (hook.readiness === 'failed') {
      return {
        ...common,
        state: 'error',
        canSend: false,
        canSendText: false,
        canSendImage: false,
        message: '微信发送能力初始化失败，请尝试重新绑定',
        ...(hook.error ? { error: hook.error } : {})
      }
    }
    const baseReady = hook.attached && Boolean(hook.baseAddress) && hook.textHookInstalled
    const canSendText = baseReady && hook.textHookReady
    const imagePathBound = Boolean(oneBot?.imagePath)
    const canSendImage = baseReady && hook.imageHookReady && imagePathBound
    const canSendVoice = baseReady && hook.imageHookReady
    return {
      ...common,
      state: canSendText || canSendImage || canSendVoice ? 'online' : 'hook_not_ready',
      canSend: canSendText || canSendImage || canSendVoice,
      canSendText,
      canSendImage,
      canSendVoice,
      message:
        hook.imageHookReady && preflight.status.imagePath && !imagePathBound
          ? 'OneBot 尚未绑定微信图片目录，请点击“绑定微信”'
          : canSendText || canSendImage || canSendVoice
            ? '个人微信已绑定，可使用已初始化的消息类型'
            : '个人微信已绑定，发送前请先在微信中手动初始化对应消息类型',
      ...(hook.error ? { error: hook.error } : {})
    }
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
    const requestId = randomUUID()
    if (request.type !== 'voice') return this.sendInternal(request, requestId)

    // OneBot's voice upload/callback bridge still uses process-wide Frida
    // fields. Serialize voice requests here so duration, Silk length and CDN
    // callback data cannot cross between two concurrent sends.
    const previous = this.voiceSendTail
    let release!: () => void
    this.voiceSendTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await this.sendInternal(request, requestId)
    } finally {
      release()
    }
  }

  private async sendInternal(
    request: PersonalWechatSendRequest,
    requestId: string
  ): Promise<PersonalWechatSendResult> {
    const to = String(request?.to || '').trim()
    if (!to) {
      const status = await this.getStatus()
      return { success: false, status, error: '接收者不能为空' }
    }
    let fileBase64: string | undefined
    let voicePcm: VoicePcmMetadata | undefined
    let runtimeSnapshot: { path: string; offset: number } | undefined
    if (request.type === 'text') {
      const text = String(request.text || '').trim()
      if (!text) {
        const status = await this.getStatus()
        return { success: false, status, error: '文字内容不能为空' }
      }
      if (text.length > 2_000) {
        const status = await this.getStatus()
        return { success: false, status, error: '消息不能超过 2000 个字符' }
      }
      request = { ...request, to, text }
    } else {
      const filePath = String(request.filePath || '').trim()
      if (!filePath || !existsSync(filePath)) {
        const status = await this.getStatus()
        return {
          success: false,
          status,
          error: `请选择有效的${request.type === 'voice' ? '语音' : '图片'}文件`
        }
      }
      const size = statSync(filePath).size
      const maxBytes = request.type === 'voice' ? MAX_VOICE_BYTES : MAX_IMAGE_BYTES
      if (size <= 0 || size > maxBytes) {
        const status = await this.getStatus()
        return {
          success: false,
          status,
          error: `${request.type === 'voice' ? '语音' : '图片'}必须小于 20 MB`
        }
      }
      let fileData: Buffer
      try {
        fileData =
          request.type === 'voice' ? await prepareVoiceFile(filePath) : readFileSync(filePath)
        const useLegacyVoicePath = request.type === 'voice' && request.voiceSendMode === 'legacy'
        if (request.type === 'voice' && !useLegacyVoicePath) {
          const sourceInputBytes = fileData.length
          const pcm = await convertAudioToPcm(fileData)
          const alignedPcmBytes = Math.floor(pcm.length / VOICE_FRAME_BYTES) * VOICE_FRAME_BYTES
          const alignedPcm = pcm.subarray(0, alignedPcmBytes)
          voicePcm = validateVoicePcm(alignedPcm)
          // The bundled Go encoder consumes 20ms frames. Sending an aligned
          // WAV makes the duration in the eventual protobuf match its output.
          fileData = createWavBuffer(alignedPcm, voicePcm.sampleRate, voicePcm.channels)
          logVoiceAttempt(requestId, 'prepared', {
            input_bytes: sourceInputBytes,
            normalized_input_bytes: fileData.length,
            pcm_size: voicePcm.pcmSize,
            sample_rate: voicePcm.sampleRate,
            channels: voicePcm.channels,
            input_duration_ms: voicePcm.durationMs,
            voice_send_mode: 'normalized'
          })
        } else if (request.type === 'voice') {
          logVoiceAttempt(requestId, 'prepared', {
            input_bytes: fileData.length,
            normalized_input_bytes: fileData.length,
            voice_send_mode: 'legacy'
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (request.type === 'voice') {
          logVoiceAttempt(requestId, 'failed', { failure_phase: 'pcm_validation', error: message })
        }
        const status = await this.getStatus()
        return { success: false, status, error: message }
      }
      fileBase64 = fileData.toString('base64')
      request = { ...request, to, filePath }
    }

    const status = await this.ensureRunning()
    const typeReady =
      request.type === 'text'
        ? status.canSendText
        : request.type === 'voice'
          ? status.canSendVoice
          : status.canSendImage
    if (!typeReady) {
      const guidance =
        request.type === 'text'
          ? '请先在微信中给任意好友手动发送一条文字，再重新检测'
          : request.type === 'voice'
            ? '语音复用媒体上传能力，请先在微信中手动发送一张普通图片，再重新检测'
            : '请先在微信中给任意好友手动发送一张普通图片，再重新检测'
      return { success: false, status, error: status.error || guidance }
    }

    const oneBot = buildPersonalWechatOneBotRequest(request, fileBase64)
    if (request.type === 'voice') runtimeSnapshot = await runtimeVoiceLogSnapshot()
    try {
      const response = await requestWithTimeout(
        `http://${DEFAULT_HOST}${oneBot.endpoint}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(oneBot.body)
        },
        request.type === 'voice' ? 60_000 : REQUEST_TIMEOUT_MS
      )
      const responseText = await response.text()
      if (!response.ok) throw new Error(responseText || `HTTP ${response.status}`)
      const parsed = responseText ? (JSON.parse(responseText) as { status?: string }) : {}
      if (parsed.status && parsed.status !== 'ok') throw new Error(responseText)
      if (request.type === 'voice') {
        const evidence = await waitForVoiceRuntimeEvidence(runtimeSnapshot)
        try {
          if (evidence.uploadResult !== '0') throw new Error('未确认微信语音上传结果')
          if (evidence.sendResult !== '1') throw new Error('未确认微信语音发送结果')
          if (evidence.uploadDataLen === undefined || evidence.durationMs === undefined) {
            throw new Error('未获取到微信 Silk 音频元数据')
          }
          validateVoiceSilkMetadata(evidence.uploadDataLen, evidence.durationMs)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logVoiceAttempt(requestId, 'failed', {
            failure_phase: 'silk_validation',
            upload_result: evidence.uploadResult,
            upload_data_len: evidence.uploadDataLen,
            silk_duration_ms: evidence.durationMs,
            send_result: evidence.sendResult,
            error: message
          })
          const failedStatus = await this.getStatus()
          return {
            success: false,
            status: { ...failedStatus, state: 'error', error: message },
            error: message
          }
        }
        logVoiceAttempt(requestId, 'completed', {
          pcm_size: voicePcm?.pcmSize,
          input_duration_ms: voicePcm?.durationMs,
          upload_result: evidence.uploadResult,
          upload_data_len: evidence.uploadDataLen,
          silk_duration_ms: evidence.durationMs,
          send_result: evidence.sendResult
        })
      }
      return { success: true, status: await this.getStatus() }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      if (request.type === 'voice') {
        const evidence = await waitForVoiceRuntimeEvidence(runtimeSnapshot, 1_000)
        // OneBot may finish the asynchronous upload/send after its HTTP
        // request has timed out. If the runtime log proves that this voice was
        // uploaded and sent successfully, do not report a false failure.
        const runtimeSendSucceeded =
          evidence.uploadResult === '0' &&
          evidence.sendResult === '1' &&
          evidence.uploadDataLen !== undefined &&
          evidence.durationMs !== undefined
        if (runtimeSendSucceeded) {
          try {
            validateVoiceSilkMetadata(evidence.uploadDataLen!, evidence.durationMs!)
            this.lastError = ''
            logVoiceAttempt(requestId, 'completed', {
              pcm_size: voicePcm?.pcmSize,
              input_duration_ms: voicePcm?.durationMs,
              upload_result: evidence.uploadResult,
              upload_data_len: evidence.uploadDataLen,
              silk_duration_ms: evidence.durationMs,
              send_result: evidence.sendResult
            })
            return { success: true, status: await this.getStatus() }
          } catch {
            // Keep the transport error below when the runtime metadata is
            // present but fails the same Silk validation as the normal path.
          }
        }
        logVoiceAttempt(requestId, 'failed', {
          failure_phase: 'http_send',
          pcm_size: voicePcm?.pcmSize,
          input_duration_ms: voicePcm?.durationMs,
          upload_result: evidence.uploadResult,
          upload_data_len: evidence.uploadDataLen,
          silk_duration_ms: evidence.durationMs,
          send_result: evidence.sendResult,
          error: this.lastError
        })
      }
      const failedStatus = await this.getStatus()
      return {
        success: false,
        status: { ...failedStatus, state: 'error', error: this.lastError },
        error: `发送失败：${this.lastError}`
      }
    }
  }

  async rebind(): Promise<PersonalWechatSenderStatus> {
    if (process.platform === 'win32') return this.getWindowsStatus()
    const preflight = await this.preflight()
    if (!preflight.runtime || !preflight.status.configPath || !preflight.status.wechatPid) {
      return preflight.status
    }
    const currentStatus = await this.getStatus()
    const oneBot = await readOneBotProcessInfo()
    if (
      oneBot?.boundWechatPid === preflight.status.wechatPid &&
      currentStatus.attachReady &&
      currentStatus.baseAddressReady &&
      currentStatus.textHookInstalled &&
      currentStatus.imageHookInstalled &&
      (!preflight.status.imagePath || Boolean(oneBot.imagePath)) &&
      currentStatus.state !== 'error'
    ) {
      return {
        ...currentStatus,
        message: '当前 OneBot 已绑定此微信进程，无需重复注入'
      }
    }
    if (oneBot) await terminateOneBot(oneBot)
    this.child = null
    this.startPromise = null
    this.lastError = ''
    let status = await this.startRuntime()
    const retryableHookFailure =
      status.state === 'error' &&
      /unable to intercept function|cannot find ['"]req2buf|hook 初始化失败/i.test(
        `${status.error || ''} ${status.message || ''}`
      )
    if (!retryableHookFailure) return status
    const failedOneBot = await readOneBotProcessInfo()
    if (failedOneBot) await terminateOneBot(failedOneBot)
    this.child = null
    this.lastError = ''
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    status = await this.startRuntime()
    return status
  }

  async terminate(force = false): Promise<void> {
    if (process.platform === 'win32') return
    if (this.keepOneBotProcess && !force) {
      this.child = null
      this.startPromise = null
      this.lastError = ''
      return
    }
    const trackedPid = this.child?.pid
    const oneBot = await readOneBotProcessInfo()
    if (oneBot) await terminateOneBot(oneBot)
    if (trackedPid && trackedPid !== oneBot?.pid) await terminateProcess(trackedPid)
    this.child = null
    this.startPromise = null
    this.lastError = ''
  }

  private async ensureRunning(): Promise<PersonalWechatSenderStatus> {
    const currentStatus = await this.getStatus()
    if (currentStatus.state === 'online' || currentStatus.state === 'hook_not_ready') {
      return currentStatus
    }
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startRuntime().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
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

    let temporaryVoicePath: string | undefined
    try {
      if (request.type === 'text') {
        const windowsRequest = buildWindowsWechatRequest(request)
        await requestWindowsHook(windowsRequest.endpoint, windowsRequest.body)
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
      if (temporaryVoicePath) {
        try {
          unlinkSync(temporaryVoicePath)
        } catch {
        }
      }
    }
  }

  private async startRuntime(): Promise<PersonalWechatSenderStatus> {
    const preflight = await this.preflight()
    if (!preflight.runtime || !preflight.status.configPath) {
      return preflight.status
    }

    const pid = preflight.status.wechatPid
    const imagePath = findWechatImagePath()
    this.lastError = ''
    const child = spawn(
      preflight.runtime.executable,
      [
        '-type=local',
        `-receive_host=${DEFAULT_HOST}`,
        `-wechat_conf=${preflight.status.configPath}`,
        `-wechat_pid=${pid}`,
        ...(imagePath ? [`-image_path=${imagePath}`] : []),
        '-send_interval=1000',
        '-log_level=info'
      ],
      {
        cwd: preflight.runtime.workingDirectory,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          PATH: buildRuntimePath(),
          PYTHONPATH: buildRuntimePythonPath(preflight.runtime.root)
        }
      }
    )
    this.child = child
    child.unref()
    child.once('error', (error) => {
      this.lastError = error.message
    })
    child.once('exit', (code) => {
      if (this.child === child) this.child = null
      if (code && !this.lastError) this.lastError = `发送服务退出（code=${code}）`
    })

    const startedAt = Date.now()
    while (Date.now() - startedAt < START_TIMEOUT_MS) {
      const status = await this.getStatus()
      if (status.state === 'online') return status
      if (status.state === 'hook_not_ready' && status.attachReady && status.baseAddressReady) {
        return status
      }
      if (status.state === 'error') return status
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    const status = await this.preflight()
    return {
      ...status.status,
      state: 'error',
      canSend: false,
      message: '个人微信发送服务启动失败',
      error: this.lastError || '启动超时，请查看应用日志'
    }
  }

  private async preflight(): Promise<PreflightResult> {
    const base = {
      platform: process.platform,
      arch: process.arch,
      sipDisabled: false,
      wechatRunning: false,
      runtimeReady: false,
      endpoint: DEFAULT_HOST,
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
      canSendVoice: false
    }
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      return {
        status: {
          ...base,
          state: 'unsupported_platform',
          message: '个人微信发送当前仅支持 Apple Silicon Mac'
        }
      }
    }

    const [sipDisabled, wechatPid] = await Promise.all([isSipDisabled(), readWechatPid()])
    if (!wechatPid) {
      return {
        status: {
          ...base,
          sipDisabled,
          state: 'wechat_not_running',
          message: '请先启动并登录 macOS 微信'
        }
      }
    }
    if (!sipDisabled) {
      return {
        status: {
          ...base,
          wechatRunning: true,
          wechatPid,
          state: 'sip_enabled',
          message: '当前 SIP 未关闭，无法直接连接微信进程'
        }
      }
    }

    let wechatVersion = ''
    try {
      wechatVersion = await readWechatVersion()
    } catch (error) {
      return {
        status: {
          ...base,
          sipDisabled,
          wechatRunning: true,
          wechatPid,
          state: 'error',
          message: '无法读取微信精确版本',
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }

    const runtime = findPersonalWechatRuntime()
    if (!runtime) {
      return {
        status: {
          ...base,
          sipDisabled,
          wechatRunning: true,
          wechatPid,
          wechatVersion,
          state: 'runtime_missing',
          message: '个人微信发送组件尚未安装，请前往“设置 → 智能能力 → 微信发送”下载'
        }
      }
    }
    const configPath = join(runtime.configDirectory, toConfigFileName(wechatVersion))
    if (!existsSync(configPath)) {
      return {
        runtime,
        status: {
          ...base,
          sipDisabled,
          wechatRunning: true,
          wechatPid,
          wechatVersion,
          runtimeReady: true,
          executablePath: runtime.executable,
          state: 'unsupported_version',
          message: `当前微信版本 ${wechatVersion} 暂不支持，请前往微信发送设置查看支持的版本`,
          error: `缺少 ${configPath}`
        }
      }
    }

    const imagePath = findWechatImagePath()
    return {
      runtime,
      status: {
        ...base,
        sipDisabled,
        wechatRunning: true,
        wechatPid,
        wechatVersion,
        runtimeReady: true,
        executablePath: runtime.executable,
        configPath,
        ...(imagePath ? { imagePath } : {}),
        state: this.child && this.child.exitCode === null ? 'starting' : 'stopped',
        message: this.lastError || '尚未绑定当前微信，可点击“绑定微信”'
      }
    }
  }

  private async isEndpointOnline(): Promise<boolean> {
    try {
      const [host, portText] = DEFAULT_HOST.split(':')
      const port = Number(portText)
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host, port })
        const timer = setTimeout(() => {
          socket.destroy()
          reject(new Error('timeout'))
        }, 800)
        socket.once('connect', () => {
          clearTimeout(timer)
          socket.destroy()
          resolve()
        })
        socket.once('error', (error) => {
          clearTimeout(timer)
          socket.destroy()
          reject(error)
        })
      })
      return true
    } catch {
      return false
    }
  }

  private readHookReadiness(
    runtime?: RuntimeLayout
  ): ReturnType<typeof parsePersonalWechatHookLog> {
    if (!runtime || !existsSync(runtime.logPath)) {
      return {
        readiness: 'unknown',
        attached: false,
        textHookInstalled: false,
        textHookReady: false,
        imageHookInstalled: false,
        imageHookReady: false,
        messageListenerReady: false
      }
    }
    try {
      return parsePersonalWechatHookLog(readFileSync(runtime.logPath, 'utf8'))
    } catch {
      return {
        readiness: 'unknown',
        attached: false,
        textHookInstalled: false,
        textHookReady: false,
        imageHookInstalled: false,
        imageHookReady: false,
        messageListenerReady: false
      }
    }
  }
}

export const personalWechatSendService = new PersonalWechatSendService()
