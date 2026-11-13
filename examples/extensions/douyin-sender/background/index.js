'use strict'

/**
 * 抖音视频搬运 —— 后台入口。
 *
 * 链路：`message.received` → 纯函数判定 → 解析并下载脚本 →
 * 经宿主 `wechat.send` 的 video 通道发回原会话。
 *
 * 这个文件跑在宿主的扩展子进程里，**只**用 `tm` 暴露的能力：
 * 没有 socket、没有 dylib、没有直接读写微信数据目录。
 */

const os = require('node:os')
const path = require('node:path')
const fsSync = require('node:fs')
const fs = require('node:fs/promises')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const {
  normalizeConfig,
  extractDouyinUrl,
  parseDownloadedResult,
  shouldHandle,
  isFileTooLarge
} = require('../lib/douyin')

const execFileAsync = promisify(execFile)

const CONFIG_KEY = 'config'
const STATS_KEY = 'stats'
const PROGRESS_KEY = 'progress'
const TEST_RESULT_KEY = 'testResult'
const CONFIG_TTL_MS = 1000

/** 配置页「测试发送」的轮询间隔；页面只负责写请求、读结果。 */

/** 阶段名只用于展示与日志，不参与判断。 */
const STAGE_LABELS = {
  accepted: '已接收',
  resolve: '解析',
  resolveDownload: '解析并下载',
  download: '下载',
  send: '发送',
  caption: '补发文案',
  done: '完成',
  failed: '失败'
}

/** 脚本内部等待抖音接口的秒数，解析与下载共用。 */
const SCRIPT_WAIT_SECONDS = '40'
const DOWNLOAD_AND_RESOLVE_TIMEOUT_MS = 420_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** 宿主限制：同一扩展两次发送之间至少 2 秒，这里留 200ms 余量。 */
const SEND_GAP_MS = 2200

const KEEP_RECENT_FILES = 20
const MAX_FILE_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_JOB_HISTORY = 20
const COOLDOWN_MAP_LIMIT = 500

let tm = null
let cachedConfig = null
let cachedAt = 0
let cachedStats = null
let cachedProgress = null

/** 会话 → 冷却截止时间（epoch 毫秒）。 */
const cooldownUntil = new Map()
/** 正在处理的会话：同一会话同时只跑一个任务。 */
const activeConversations = new Set()
/** 正在处理的 `会话|链接`：避免同一条消息被重复投递时跑两遍。 */
const activeJobs = new Set()

function safeLog(level, message) {
  try {
    const writer = tm && tm.log && tm.log[level]
    if (typeof writer === 'function') writer.call(tm.log, String(message))
  } catch {
    // 日志通道本身不可用时不能影响发送流程。
  }
}

/** 错误类型化：日志只保留阶段与错误码，不写 URL、路径、标题。 */
function errorType(error) {
  if (!error) return 'UNKNOWN'
  if (error.killed || error.signal) return 'TIMEOUT'
  // 数字退出码单独标成 EXIT_n，避免统计里只看到一个「2」。
  if (typeof error.code === 'number') return `EXIT_${error.code}`
  if (typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)) return error.code
  if (error.name === 'Error') return 'ERROR'
  return String(error.name || 'ERROR')
}

/** 去掉换行、链接与路径，只留 ≤60 字的短原因。 */
function shortReason(input) {
  let text = String(input === null || input === undefined ? '' : input)
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s"'）)]+)+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  text = text.replace(/^[：:，,。;；-]+/, '').trim()
  text = text.replace(/title=[^,，)）]+/gi, 'title=已隐藏')
  if (!text) return '未知原因'
  return text.slice(0, 60)
}

function parseFailure(cause, type) {
  return { ok: false, message: `解析失败：${shortReason(cause)}`, errorType: type || 'PARSE' }
}

function tooLargeMessage(sizeBytes) {
  const megabytes = Math.max(1, Math.ceil(Number(sizeBytes) / (1024 * 1024)))
  return `视频过大（${megabytes}MB），已跳过`
}

function expandHome(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/') || raw.startsWith('~' + path.sep)) {
    return path.join(os.homedir(), raw.slice(2))
  }
  return raw
}

function downloadsDir() {
  return path.join(tm.extension.dataDir, 'downloads')
}

async function loadConfig() {
  if (cachedConfig && Date.now() - cachedAt < CONFIG_TTL_MS) return cachedConfig
  let stored = null
  try {
    stored = await tm.storage.get(CONFIG_KEY)
  } catch (error) {
    safeLog('warn', `读取配置失败：${errorType(error)}`)
  }
  cachedConfig = normalizeConfig(stored)
  cachedAt = Date.now()
  return cachedConfig
}

function dateKey(timestamp) {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function normalizeStats(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const lastJobs = Array.isArray(input.lastJobs)
    ? input.lastJobs
        .filter((job) => job && typeof job === 'object')
        .slice(0, MAX_JOB_HISTORY)
        .map((job) => ({
          at: Number(job.at) || 0,
          awemeId: String(job.awemeId || '').slice(0, 32),
          ok: job.ok === true,
          stage: String(job.stage || '').slice(0, 20),
          errorType: String(job.errorType || '').slice(0, 24)
        }))
    : []
  const total = Math.max(0, Math.trunc(Number(input.todayTotal ?? input.todayCount) || 0))
  return {
    dateKey: typeof input.dateKey === 'string' ? input.dateKey.slice(0, 10) : '',
    todayTotal: total,
    todaySuccess: Math.max(0, Math.trunc(Number(input.todaySuccess) || 0)),
    todayFailure: Math.max(0, Math.trunc(Number(input.todayFailure) || 0)),
    lastJobs
  }
}

async function loadStats() {
  if (cachedStats) return cachedStats
  let stored = null
  try {
    stored = await tm.storage.get(STATS_KEY)
  } catch (error) {
    safeLog('warn', `读取统计失败：${errorType(error)}`)
  }
  cachedStats = normalizeStats(stored)
  return cachedStats
}

/**
 * 追加一条任务记录。
 *
 * 统计里只允许出现 awemeId / 时间 / 阶段 / 成败 / 错误类型；URL、标题、作者、
 * 会话 id 都不写，避免把聊天内容沉淀成扩展数据。
 */
async function recordJob(job) {
  const now = Date.now()
  const current = await loadStats()
  const key = dateKey(now)
  const sameDay = current.dateKey === key
  const next = {
    dateKey: key,
    todayTotal: (sameDay ? current.todayTotal : 0) + 1,
    todaySuccess: (sameDay ? current.todaySuccess : 0) + (job.ok === true ? 1 : 0),
    todayFailure: (sameDay ? current.todayFailure : 0) + (job.ok === true ? 0 : 1),
    lastJobs: [
      {
        at: now,
        awemeId: String(job.awemeId || '').slice(0, 32),
        ok: job.ok === true,
        stage: String(job.stage || '').slice(0, 20),
        errorType: String(job.errorType || '').slice(0, 24)
      },
      ...current.lastJobs
    ].slice(0, MAX_JOB_HISTORY)
  }
  cachedStats = next
  try {
    await tm.storage.set(STATS_KEY, next)
  } catch (error) {
    safeLog('warn', `写入统计失败：${errorType(error)}`)
  }
}

/**
 * 写「当前任务」快照，供配置页展示进度。
 *
 * 只保留一条最近任务：jobId 用事件 id（不可逆哈希），不含会话与正文。
 * 写失败只 warn，不能因为展示层异常影响发送。
 */
async function setProgress(patch) {
  const now = Date.now()
  const next = {
    ...(cachedProgress || {}),
    ...patch,
    updatedAt: now
  }
  if (!next.startedAt) next.startedAt = now
  cachedProgress = next
  const label = STAGE_LABELS[next.stage] || next.stage || ''
  safeLog('info', `任务进度：${label}${next.awemeId ? `（${next.awemeId}）` : ''}`)
  try {
    await tm.storage.set(PROGRESS_KEY, next)
  } catch (error) {
    safeLog('warn', `写入进度失败：${errorType(error)}`)
  }
}

function markCooldown(conversationId, seconds) {
  if (!conversationId || !(seconds > 0)) return
  cooldownUntil.set(conversationId, Date.now() + seconds * 1000)
  if (cooldownUntil.size > COOLDOWN_MAP_LIMIT) {
    const now = Date.now()
    for (const [key, until] of cooldownUntil) {
      if (until <= now) cooldownUntil.delete(key)
    }
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * 在 Apple Silicon macOS 上，若宿主的默认 python3 是 x86_64（Rosetta 2），
 * 直接启动会把 P_TRANSLATED 标志遗传给子进程 Google Chrome，导致抖音页面卡在加载中。
 * 这里优先选用缓存 venv 的原生 Python，并通过 /usr/bin/arch -arm64 强制切换为原生 arm64。
 */
function resolvePythonInvocation(pythonPath, scriptPath, args) {
  if (process.platform !== 'darwin') {
    return { file: pythonPath, args: [scriptPath, ...args] }
  }
  let resolvedPython = pythonPath
  if (pythonPath === 'python3') {
    const venvPython = path.join(
      os.homedir(),
      'Library',
      'Caches',
      'douyin-video',
      'venv',
      'bin',
      'python'
    )
    try {
      if (fsSync.existsSync(venvPython)) resolvedPython = venvPython
    } catch {
      // 缓存 venv 不可读时退回配置里的 pythonPath。
    }
  }
  try {
    if (fsSync.existsSync('/usr/bin/arch')) {
      return {
        file: '/usr/bin/arch',
        args: ['-arm64', resolvedPython, scriptPath, ...args]
      }
    }
  } catch {
    // 非标准系统环境缺少 /usr/bin/arch 时直接调用解释器。
  }
  return { file: resolvedPython, args: [scriptPath, ...args] }
}

/**
 * 解析可用的抖音 Cookie：
 * 1. 优先使用调用方显式传入的 cookieHeader（测试发送 / 测试下载）；
 * 2. 尝试向宿主读取已保存的 Cookie（若宿主暴露接口）；
 * 3. 回退读取扩展私有目录或桌面上的 `douyin-cookie` 文件（供 @我自己 自动回复链路使用）。
 */
async function resolveCookieHeader(explicitHeader) {
  const direct = String(explicitHeader || '').trim()
  if (direct) return direct
  if (tm && tm.douyin && typeof tm.douyin.getCookie === 'function') {
    try {
      const fromHost = String((await tm.douyin.getCookie()) || '').trim()
      if (fromHost) return fromHost
    } catch {
      // 宿主未提供或读取失败时继续尝试本地文件。
    }
  }
  const candidates = [
    path.join(tm.extension.dataDir, 'douyin-cookie.txt'),
    path.join(os.homedir(), 'Desktop', 'douyin-cookie'),
    path.join(os.homedir(), 'Desktop', 'douyin-cookie.txt')
  ]
  for (const file of candidates) {
    try {
      const content = String(await fs.readFile(file, 'utf8')).trim()
      if (content) return content
    } catch {
      // 文件不存在或无权限时跳过。
    }
  }
  return ''
}

function resolveScriptPath(value) {
  const expanded = expandHome(value)
  if (!expanded) return path.resolve(__dirname, '..', 'scripts', 'douyin.py')
  if (path.isAbsolute(expanded)) return expanded
  return path.resolve(__dirname, '..', expanded)
}

/** 统一封装脚本调用：固定 cwd、超时、输出上限、UTF-8 与 macOS 原生 arm64 执行。 */
async function runPython(args, timeoutMs, config) {
  // 首次启用时 dataDir 可能还没被创建；execFile 的 cwd 不存在会直接 ENOENT。
  await fs.mkdir(tm.extension.dataDir, { recursive: true })
  const pythonPath = expandHome(config.pythonPath)
  const scriptPath = resolveScriptPath(config.scriptPath)
  const invocation = resolvePythonInvocation(pythonPath, scriptPath, args)
  return execFileAsync(invocation.file, invocation.args, {
    cwd: tm.extension.dataDir,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      DOUYIN_ARM64_READY: '1'
    },
    windowsHide: true
  })
}

function describeExecError(error) {
  if (!error) return '失败'
  if (error.code === 'ENOENT') return '找不到 Python 可执行文件，请检查 Python 路径'
  if (error.killed || error.signal) return '超时'
  if (typeof error.code === 'number') return `脚本退出码 ${error.code}`
  if (typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code)) {
    return `失败（${error.code}）`
  }
  return '失败'
}

async function resolveAndDownloadVideo(url, config, options = {}) {
  const dir = downloadsDir()
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch (error) {
    return parseFailure('下载目录不可用（' + errorType(error) + '）', errorType(error))
  }

  const args = [
    url,
    '-o',
    dir,
    '--wait',
    SCRIPT_WAIT_SECONDS,
    '--download-timeout',
    '90',
    '--json',
    '--debug',
    '--video-only',
    '--download'
  ]
  if (config.quality) args.push('-q', config.quality)
  if (config.showUi) args.push('--show-ui')
  const cookieHeader = await resolveCookieHeader(options.cookieHeader)
  let temporaryCookieFile = ''
  let stdout = ''
  try {
    if (cookieHeader) {
      await fs.mkdir(tm.extension.dataDir, { recursive: true })
      temporaryCookieFile = path.join(
        tm.extension.dataDir,
        `.douyin-cookie-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
      )
      await fs.writeFile(temporaryCookieFile, cookieHeader, { mode: 0o600, flag: 'wx' })
      await fs.chmod(temporaryCookieFile, 0o600)
      args.push('--cookie-file', temporaryCookieFile)
    }

    const result = await runPython(args, DOWNLOAD_AND_RESOLVE_TIMEOUT_MS, config)
    stdout = String(result.stdout || '')
  } catch (error) {
    stdout = String((error && error.stdout) || '')
    if (!stdout.trim()) {
      return parseFailure(
        temporaryCookieFile ? 'Cookie 文件不可用或解析超时' : describeExecError(error),
        temporaryCookieFile ? 'COOKIE_OR_TIMEOUT' : errorType(error)
      )
    }
  } finally {
    if (temporaryCookieFile) {
      try {
        await fs.unlink(temporaryCookieFile)
      } catch {
        // 解析结束后清除临时凭证文件。
      }
    }
  }

  const parsed = parseDownloadedResult(stdout)
  if (!parsed) {
    const failure = /✗\s*(?:失败[：:])?\s*(.+)/.exec(stdout)
    return parseFailure(failure ? failure[1] : '脚本输出无法识别', 'INVALID_OUTPUT')
  }
  if (!parsed.ok) return parseFailure(parsed.message, parsed.errorType)

  let stat = null
  try {
    stat = await fs.stat(parsed.path)
  } catch {
    return parseFailure('下载文件不存在', 'MISSING_FILE')
  }
  if (!stat.isFile()) return parseFailure('下载结果不是文件', 'NOT_A_FILE')
  if (isFileTooLarge(stat.size, config.maxFileMB)) {
    return { ok: false, message: tooLargeMessage(stat.size), errorType: 'TOO_LARGE' }
  }
  return { ok: true, path: parsed.path, size: stat.size, meta: parsed.meta }
}

let lastSendAt = 0

async function waitSendSlot() {
  const elapsed = Date.now() - lastSendAt
  if (lastSendAt > 0 && elapsed < SEND_GAP_MS) {
    await sleep(SEND_GAP_MS - elapsed)
  }
  lastSendAt = Date.now()
}

async function sendText(to, text, dedupeKey, stage) {
  try {
    await waitSendSlot()
    await tm.wechat.send({ to, text, dedupeKey })
    lastSendAt = Date.now()
    return true
  } catch (error) {
    safeLog('warn', `未完成：阶段=${stage || 'text'} 错误=${errorType(error)}`)
    return false
  }
}

/** 发视频：走宿主 video 通道，`dedupeKey` 保证同一条消息只发一次。 */
async function sendVideo(event, filePath) {
  try {
    await waitSendSlot()
    await tm.wechat.send({
      type: 'video',
      to: event.conversationId,
      path: filePath,
      dedupeKey: `${event.eventId}:video`
    })
    lastSendAt = Date.now()
    return true
  } catch (error) {
    safeLog('warn', `未完成：阶段=send 错误=${errorType(error)}`)
    return false
  }
}

async function reportFailure(event, config, message) {
  if (!config.errorReply) return
  await sendText(event.conversationId, message, `${event.eventId}:error`, 'reply')
}

/**
 * 一次完整任务。
 *
 * `stage` 记录失败发生的位置：`resolveDownload` / `send` / `done`。
 * 进度快照与统计都会落盘；失败原因只保留错误类型，不写 URL / 路径 / 标题。
 */
async function processLink(event, config, url, options = {}) {
  const jobId = event.eventId
  let awemeId = ''
  let stage = 'accepted'
  let ok = false
  let failureCode = ''
  let failureMessage = ''

  try {
    stage = 'resolveDownload'
    await setProgress({ jobId, awemeId, stage, status: 'running' })
    const downloaded = await resolveAndDownloadVideo(url, config, options)
    if (!downloaded.ok) {
      failureCode = downloaded.errorType || 'DOWNLOAD_FAILED'
      failureMessage = downloaded.message
      return
    }
    const meta = downloaded.meta
    awemeId = String(meta.aweme_id || '')

    stage = 'send'
    await setProgress({ jobId, awemeId, stage, status: 'running' })
    const sent = await sendVideo(event, downloaded.path)
    if (!sent) {
      failureCode = 'SEND_FAILED'
      failureMessage = '视频发送失败'
      return
    }

    ok = true
    stage = 'done'
    // 冷却只在视频真正发出去之后才写入，失败不占用下一次机会。
    markCooldown(event.conversationId, config.cooldownSeconds)
  } catch (error) {
    failureCode = errorType(error)
    failureMessage = '处理异常'
    safeLog('warn', `处理异常：阶段=${stage} 错误=${failureCode}`)
  } finally {
    if (ok) {
      await setProgress({ jobId, awemeId, stage: 'done', status: 'done', errorType: '' })
    } else {
      if (failureMessage && options.replyOnFailure !== false) {
        await reportFailure(event, config, failureMessage)
      }
      await setProgress({
        jobId,
        awemeId,
        stage: stage === 'accepted' ? 'resolve' : stage,
        status: 'failed',
        errorType: failureCode || 'FAILED',
        errorMessage: failureMessage ? shortReason(failureMessage) : ''
      })
      safeLog('warn', `未完成：阶段=${stage} 错误=${failureCode || 'FAILED'}`)
    }
    await recordJob({
      awemeId,
      ok,
      stage: ok ? 'done' : stage,
      errorType: ok ? '' : failureCode || 'FAILED'
    })
  }
}

async function handleEvent(event) {
  try {
    const config = await loadConfig()
    const decision = shouldHandle(event, config, cooldownUntil, Date.now())
    if (!decision.handle) return

    const conversationId = event.conversationId
    const jobKey = `${conversationId}|${decision.url}`
    if (activeConversations.has(conversationId) || activeJobs.has(jobKey)) return

    activeConversations.add(conversationId)
    activeJobs.add(jobKey)
    try {
      await setProgress({
        jobId: event.eventId,
        stage: 'accepted',
        status: 'running',
        startedAt: Date.now(),
        awemeId: '',
        errorType: '',
        errorMessage: ''
      })
      // 先回执再干活：解析/下载要十几秒，用户不该靠猜。
      if (config.ackText) {
        await sendText(conversationId, config.ackText, `${event.eventId}:ack`, 'ack')
      }
      await processLink(event, config, decision.url)
    } finally {
      activeConversations.delete(conversationId)
      activeJobs.delete(jobKey)
    }
  } catch (error) {
    safeLog('warn', `事件处理失败：${errorType(error)}`)
  }
}

let lastTestRequestId = ''
let testInFlight = false
let pendingTestRequest = null

async function writeTestResult(result) {
  try {
    await tm.storage.set(TEST_RESULT_KEY, result)
  } catch (error) {
    safeLog('warn', `写入测试结果失败：${errorType(error)}`)
  }
}

/**
 * 配置页「测试发送」。
 *
 * 测试请求通过宿主一次性送达，不落入扩展持久化存储。
 */
async function pollTestRequest() {
  if (testInFlight) return
  const request = pendingTestRequest
  pendingTestRequest = null
  if (!request || typeof request !== 'object') return
  const id = String(request.id || '').trim()
  if (!id || id === lastTestRequestId) return
  lastTestRequestId = id
  const to = String(request.to || '').trim()
  const text = String(request.text || '').trim()

  if (!to || !text) {
    await writeTestResult({
      id,
      status: 'failed',
      message: '测试请求缺少群聊或链接',
      at: Date.now()
    })
    return
  }
  if (activeConversations.has(to)) {
    await writeTestResult({
      id,
      status: 'failed',
      message: '该群正在执行其他任务，请稍后重试',
      at: Date.now()
    })
    return
  }
  const url = extractDouyinUrl(text)
  if (!url) {
    await writeTestResult({ id, status: 'failed', message: '没有识别到抖音链接', at: Date.now() })
    return
  }

  const config = await loadConfig()
  const cookieHeader = request.cookieHeader ? String(request.cookieHeader) : ''
  testInFlight = true
  activeConversations.add(to)
  try {
    await writeTestResult({ id, status: 'running', message: '已开始解析…', at: Date.now() })
    await setProgress({
      jobId: `test:${id}`,
      stage: 'accepted',
      status: 'running',
      startedAt: Date.now(),
      awemeId: '',
      errorType: '',
      errorMessage: ''
    })
    // 测试路径不发回执：结果直接显示在配置页，视频发到目标群。
    await processLink(
      {
        eventId: `test:${id}`,
        conversationId: to,
        isGroup: to.endsWith('@chatroom'),
        isSelf: false,
        type: 'text',
        text,
        mentionsMe: true
      },
      config,
      url,
      { replyOnFailure: false, cookieHeader }
    )
    const progress = cachedProgress || {}
    if (progress.status === 'done') {
      await writeTestResult({
        id,
        status: 'done',
        message: '测试发送完成：视频已发到该群',
        at: Date.now()
      })
    } else {
      const label = STAGE_LABELS[progress.stage] || progress.stage || '未知阶段'
      await writeTestResult({
        id,
        status: 'failed',
        message: `测试发送失败：${label}${progress.errorType ? `（${progress.errorType}）` : ''}${progress.errorMessage ? `：${progress.errorMessage}` : ''}`,
        at: Date.now()
      })
    }
  } catch (error) {
    await writeTestResult({
      id,
      status: 'failed',
      message: `测试发送异常：${errorType(error)}`,
      at: Date.now()
    })
  } finally {
    activeConversations.delete(to)
    testInFlight = false
  }
}

/**
 * 清理下载目录：只保留最近 20 个文件，并删除 7 天前的文件。
 *
 * 清理失败不影响发送能力，逐条 try/catch，最坏情况是目录继续变大。
 */
async function cleanupDownloads() {
  const dir = downloadsDir()
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = path.join(dir, entry.name)
    try {
      const stat = await fs.stat(full)
      files.push({ full, mtime: stat.mtimeMs })
    } catch {
      // 枚举期间被删除或无法访问，跳过即可。
    }
  }

  files.sort((left, right) => right.mtime - left.mtime)
  const now = Date.now()
  for (let index = 0; index < files.length; index += 1) {
    const fresh = now - files[index].mtime <= MAX_FILE_AGE_MS
    if (index < KEEP_RECENT_FILES && fresh) continue
    try {
      await fs.unlink(files[index].full)
    } catch {
      // 单个文件删不掉就留着，下一次启动再试。
    }
  }
}

module.exports = function activate(api) {
  tm = api
  // 宿主对 handler 有 10 秒超时；脚本可能要跑几分钟，所以这里只排队不等待。
  tm.events.on('message.received', (event) => {
    void handleEvent(event)
  })
  void cleanupDownloads()
  globalThis.__tmTestSend = async (request) => {
    pendingTestRequest = request
    await pollTestRequest()
    return { accepted: true }
  }
  tm.log.info('抖音搬运已加载')
}
