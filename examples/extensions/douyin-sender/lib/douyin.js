'use strict'

/**
 * 抖音分享链接解析的纯函数层。
 *
 * 这一层不碰文件系统、不启子进程、不读时钟：所有输入都从参数进来，
 * 所有输出都可序列化，便于在 `node:test` 里离线断言。
 *
 * 单位约定：
 * - 时间一律 epoch 毫秒；
 * - 文件大小一律字节，配置里的上限单位是 MB（1 MB = 1024 * 1024 B）。
 */

/** 宿主发送通道的硬上限：单个媒体文件 100 MB，配置不允许突破。 */
const HOST_MAX_FILE_MB = 100

/** 解析脚本的默认位置（相对于扩展目录，支持自定义绝对路径或 `~/`）。 */
const DEFAULT_SCRIPT_PATH = 'scripts/douyin.py'

/** 画质白名单；空串表示「最高」，不传 `-q` 给脚本。 */
const QUALITY_VALUES = ['', '1080', '720', '540']

const DEFAULT_CONFIG = {
  configVersion: 1,
  enabled: false,
  pythonPath: 'python3',
  scriptPath: DEFAULT_SCRIPT_PATH,
  quality: '720',
  /** 排障开关：显示浏览器窗口以观察实际页面状态。 */
  showUi: false,
  /** 命中后先回一句，避免用户不知道是否收到；空串表示不回复。 */
  ackText: '收到，正在解析，请稍候…',
  sendCaption: false,
  captionTemplate: '{author}：{title}',
  errorReply: true,
  includeDirect: false,
  groups: [],
  cooldownSeconds: 60,
  maxFileMB: HOST_MAX_FILE_MB
}

/** 分享链接只认这三种形态；短链的 id 是字母数字，长链只认数字作品 id。 */
const DOUYIN_URL_PATTERN =
  /https?:\/\/(?:v\.douyin\.com\/[A-Za-z0-9_-]{1,64}|(?:www\.)?douyin\.com\/(?:video|note)\/\d{1,32})/i

/** 中文文案里链接后面常跟这些符号，属于分隔符不属于链接。 */
const TRAILING_PUNCTUATION = /[)\]}>,.;:!?'"`。，、；：！？…）】》〉」』”’]+$/

const CAPTION_MAX_LENGTH = 200
const GROUP_MAX_COUNT = 200

function clampInt(value, min, max, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  const rounded = Math.trunc(numeric)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

function normalizeQuality(value) {
  if (value === null || value === undefined) return DEFAULT_CONFIG.quality
  const text = String(value).trim()
  // 数值型画质（720）与字符串画质（'720'）同义；`''` 表示最高。
  if (text === '') return ''
  return QUALITY_VALUES.includes(text) ? text : DEFAULT_CONFIG.quality
}

function normalizeGroups(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : []
  const result = []
  for (const item of list) {
    const id = String(item === null || item === undefined ? '' : item).trim()
    if (!id) continue
    if (result.includes(id)) continue
    result.push(id.slice(0, 128))
    if (result.length >= GROUP_MAX_COUNT) break
  }
  return result
}

function normalizeText(value, fallback, maxLength) {
  const text = typeof value === 'string' ? value.trim() : ''
  return (text || fallback).slice(0, maxLength)
}

/**
 * 把任意来源（存储、表单、旧版本）的配置收敛成可执行形态。
 *
 * 契约：**永不抛错**，字段缺失或非法时回落到默认值；返回对象永远是全新的，
 * 调用方可以直接持有并修改，不会污染 `DEFAULT_CONFIG`。
 */
function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    configVersion: 1,
    enabled: input.enabled === true,
    pythonPath: normalizeText(input.pythonPath, DEFAULT_CONFIG.pythonPath, 512),
    scriptPath: normalizeText(input.scriptPath, DEFAULT_SCRIPT_PATH, 512),
    quality: normalizeQuality(input.quality),
    showUi: input.showUi === true,
    ackText:
      input.ackText === undefined
        ? DEFAULT_CONFIG.ackText
        : String(input.ackText).trim().slice(0, 200),
    sendCaption: input.sendCaption === true,
    captionTemplate: normalizeText(input.captionTemplate, DEFAULT_CONFIG.captionTemplate, 200),
    errorReply: input.errorReply !== false,
    includeDirect: input.includeDirect === true,
    groups: normalizeGroups(input.groups),
    cooldownSeconds: clampInt(input.cooldownSeconds, 0, 3600, DEFAULT_CONFIG.cooldownSeconds),
    maxFileMB: clampInt(input.maxFileMB, 1, HOST_MAX_FILE_MB, DEFAULT_CONFIG.maxFileMB)
  }
}

/**
 * 从一段文本里取第一个抖音分享链接。
 *
 * 输入可能是裸链接，也可能是「复制打开抖音…」整段文案；返回值已去掉尾随标点，
 * 查询串与 fragment 一并丢弃（短链换长链由脚本完成，扩展不参与）。
 *
 * 返回 `null` 表示没有可识别的抖音作品链接；`javascript:` / `ftp:` / 非抖音域名
 * 一律不匹配。
 */
function extractDouyinUrl(text) {
  const source = typeof text === 'string' ? text : ''
  if (!source) return null
  const matched = DOUYIN_URL_PATTERN.exec(source)
  if (!matched) return null
  const cleaned = matched[0].replace(TRAILING_PUNCTUATION, '')
  return cleaned || null
}

/** 从 `start` 处的 `[` 找到配对的 `]`，跳过字符串字面量与转义；失败返回 -1。 */
function findArrayEnd(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '[') {
      depth += 1
      continue
    }
    if (char === ']') {
      depth -= 1
      if (depth === 0) return index
      if (depth < 0) return -1
    }
  }
  return -1
}

function isResolveResultList(value) {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every(
    (item) =>
      item &&
      typeof item === 'object' &&
      typeof item.url === 'string' &&
      typeof item.ok === 'boolean'
  )
}

/**
 * 从 stdout 中取第一个结构合法的结果数组。
 *
 * 按结构判定（非空数组、每项含 `url:string` 与 `ok:boolean`），跳过进度行里的
 * `[1]` 与嵌套的 `quality_options`；空数组与非法 JSON 返回 `null`。
 */
function parseResolveJson(stdout) {
  const text = typeof stdout === 'string' ? stdout : ''
  if (!text) return null
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '[') continue
    const end = findArrayEnd(text, start)
    if (end < 0) continue
    try {
      const value = JSON.parse(text.slice(start, end + 1))
      if (isResolveResultList(value)) return value
    } catch {
      // 这个 `[` 不是数组起点（可能在字符串里），继续向后找。
    }
  }
  return null
}

/**
 * 从下载输出里取最后一个 `✅` 后面的绝对路径。
 *
 * 脚本对视频打印 `  ✅ /abs/xxx.mp4`，对图集打印目录后面再跟一段「（N 个文件）」。
 * 路径里可能含空格（作者名与标题），所以只按行首标记切分，不按空白切分。
 *
 * 返回 `null` 表示没有可用的绝对路径。
 */
function parseSavedPath(stdout) {
  const text = typeof stdout === 'string' ? stdout : ''
  if (!text) return null
  const lines = text.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const marker = lines[index].indexOf('✅')
    if (marker < 0) continue
    let rest = lines[index].slice(marker + 1).trim()
    // 去掉尾部的「（N 个文件）」之类附注，它不属于路径。
    rest = rest.replace(/\s*[（(][^（()）]*[)）]\s*$/, '').trim()
    if (!rest) continue
    if (rest[0] !== '/') continue
    return rest
  }
  return null
}

function parseDownloadedResult(stdout) {
  const results = parseResolveJson(stdout)
  const video = pickVideoResult(results)
  if (video) {
    const saved = Array.isArray(video.saved)
      ? video.saved.find((value) => typeof value === 'string' && value.startsWith('/'))
      : null
    if (saved) return { ok: true, meta: video, path: saved }
    if (video.error) return { ok: false, message: video.error, errorType: 'DOWNLOAD_FAILED' }
    return null
  }

  const image = results && results.find((item) => item && item.ok === true && item.type === 'image')
  if (image) return { ok: false, message: '暂不支持图集', errorType: 'IMAGE_SET' }

  const failure = results && results.find((item) => item && item.ok === false)
  if (failure && failure.error) {
    return {
      ok: false,
      message: failure.error,
      errorType: failure.aweme_id ? 'DOWNLOAD_FAILED' : 'RESOLVE_FAILED'
    }
  }
  return null
}

/**
 * 按模板渲染文案。
 *
 * 已知变量 `{author}` / `{title}` / `{awemeId}` 会被替换；未知变量原样保留，
 * 让用户能看见自己写错了什么。结果 trim 后截断到 200 字。
 */
function renderCaption(template, meta) {
  const source = typeof template === 'string' ? template : ''
  const data = meta && typeof meta === 'object' ? meta : {}
  const values = {
    author: data.author === null || data.author === undefined ? '' : String(data.author),
    title: data.title === null || data.title === undefined ? '' : String(data.title),
    awemeId: data.awemeId === null || data.awemeId === undefined ? '' : String(data.awemeId)
  }
  // 已知变量即使取不到值也替换成空串：正文里留下 `{author}` 会被当成程序缺陷。
  const rendered = source.replace(/\{(author|title|awemeId)\}/g, (whole, name) => values[name])
  return rendered.trim().slice(0, CAPTION_MAX_LENGTH)
}

function inScope(event, config) {
  if (event.isGroup) {
    return config.groups.length === 0 || config.groups.includes(event.conversationId)
  }
  return config.includeDirect === true
}

function readCooldown(cooldownUntil, conversationId) {
  if (!cooldownUntil || !conversationId) return 0
  const value =
    typeof cooldownUntil.get === 'function'
      ? cooldownUntil.get(conversationId)
      : cooldownUntil[conversationId]
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0
}

/**
 * 判断一条事件是否该进入处理流程。
 *
 * 判定顺序固定：总开关 → 自己发的 → 非 text → 未 @我 → 提取链接 → 会话范围 → 冷却。
 * `reason` 的取值集合固定为
 * `disabled | self | type | mention | no_link | scope | cooldown | ok`。
 *
 * `url` 只要提取成功就会返回，即使后续被范围或冷却拦下，便于调用方写日志。
 */
function shouldHandle(event, config, cooldownUntil, now) {
  const settings = normalizeConfig(config)
  if (!settings.enabled) return { handle: false, url: null, reason: 'disabled' }
  if (!event || typeof event !== 'object') return { handle: false, url: null, reason: 'no_link' }
  if (event.isSelf) return { handle: false, url: null, reason: 'self' }
  if (event.type !== 'text') return { handle: false, url: null, reason: 'type' }
  if (!event.mentionsMe) return { handle: false, url: null, reason: 'mention' }

  const url = extractDouyinUrl(event.text)
  if (!url) return { handle: false, url: null, reason: 'no_link' }
  if (!inScope(event, settings)) return { handle: false, url, reason: 'scope' }

  const until = readCooldown(cooldownUntil, event.conversationId)
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  if (timestamp < until) return { handle: false, url, reason: 'cooldown' }

  return { handle: true, url, reason: 'ok' }
}

/**
 * 文件是否不该发送。
 *
 * 返回 true 的三种情况：超过配置上限、字节数非法、文件为空。
 * 上限本身被收敛到 1–100 MB，宿主 100 MB 的硬限制不会被配置绕过。
 */
function isFileTooLarge(sizeBytes, maxFileMB) {
  const limitMB = clampInt(maxFileMB, 1, HOST_MAX_FILE_MB, DEFAULT_CONFIG.maxFileMB)
  const size = Number(sizeBytes)
  if (!Number.isFinite(size) || size <= 0) return true
  return size > limitMB * 1024 * 1024
}

/**
 * 从解析结果里挑第一条可下载的视频。
 *
 * 图集（`type === 'image'`）与失败项都不算；没有视频时返回 `null`，
 * 由调用方决定回复「暂不支持图集」还是通用失败文案。
 */
function pickVideoResult(results) {
  if (!Array.isArray(results)) return null
  for (const item of results) {
    if (!item || typeof item !== 'object') continue
    if (item.ok !== true) continue
    if (item.type !== 'video') continue
    return item
  }
  return null
}

module.exports = {
  DEFAULT_CONFIG,
  normalizeConfig,
  extractDouyinUrl,
  parseResolveJson,
  parseSavedPath,
  parseDownloadedResult,
  renderCaption,
  shouldHandle,
  isFileTooLarge,
  pickVideoResult
}
