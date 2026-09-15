// src/shared/system-ocr.ts
//
// 本地系统 OCR（System OCR）共享契约。
//
// 架构边界（不要混淆）：
//   - System OCR 是**本地 Runtime**，不是 AI Provider，也不是 Vision Model。
//     它不占用 AIVisionRuntimeConfig.source，也不产生任何网络请求。
//   - 能力边界：只把图片里的文字读出来。它不等于「理解人物 / 理解场景 /
//     描述照片 / 理解表情包语义 / 视觉推理」——那些仍然属于 Vision Model。
//   - Windows 后端为 Windows.Media.Ocr.OcrEngine（经 @napi-rs/system-ocr 调用）。
//     macOS 本轮只保留架构位置，未实现；Linux 不支持。
//
// 数据边界（本轮不做）：
//   - 不做历史图片全量 OCR、不做 Knowledge 回填、不把 OCR 文字伪装成原始聊天文字。
//     原始消息始终是权威来源，OCR 文字只是派生内容（本轮仅存在于内存）。

/** System OCR 引擎标识。这是本地 Runtime，不是 provider id。 */
export const SYSTEM_OCR_ENGINE = 'windows-system-ocr'

/** 本地 OCR 结果在内存中的缓存时长。 */
export const SYSTEM_OCR_CACHE_TTL_MS = 10 * 60 * 1000

/**
 * 产品级错误码。用户可见文案由 error 字段承载，任何 native 堆栈 / HRESULT
 * 都不会直接透出到 Renderer。
 */
export type SystemOcrErrorCode =
  /** 运行时不可用（native binding 缺失 / 加载失败） */
  | 'SYSTEM_OCR_UNAVAILABLE'
  /** 当前平台不支持（Linux，或非 Windows 平台） */
  | 'UNSUPPORTED_PLATFORM'
  /** 图片格式不在支持范围内 */
  | 'UNSUPPORTED_IMAGE'
  /** 图片解码失败（格式可识别但内容损坏或无法转成 PNG） */
  | 'IMAGE_DECODE_FAILED'
  /** 当前 Windows 未安装对应的 OCR 语言支持 */
  | 'OCR_LANGUAGE_UNAVAILABLE'
  /** 引擎执行失败 */
  | 'OCR_FAILED'
  /** 识别成功执行，但图里没有文字 */
  | 'OCR_EMPTY_RESULT'

export type SystemOcrUnavailableReason =
  | 'UNSUPPORTED_PLATFORM'
  | 'NATIVE_MODULE_MISSING'
  | 'LANGUAGE_UNAVAILABLE'

/** 本机 System OCR 能力。UI 只用它决定是否展示「本地文字识别」入口。 */
export interface SystemOcrCapability {
  /** 本机当前是否真的可以识别图片文字 */
  available: boolean
  engine: typeof SYSTEM_OCR_ENGINE
  platform: NodeJS.Platform
  arch: string
  /** @napi-rs/system-ocr 运行时版本；无法读取时为 null */
  runtimeVersion: string | null
  /** 实际可用的 OCR 语言标签（对应 Windows 语言包）；null 表示走系统用户语言 */
  language: string | null
  reason?: SystemOcrUnavailableReason
  /** 面向用户的中文说明，可直接展示 */
  message: string
}

export interface SystemOcrBoundingBox {
  /** 归一化到 0..1，原点在左上角 */
  x: number
  y: number
  width: number
  height: number
}

export interface SystemOcrLine {
  text: string
  /** Windows 恒为 1.0 */
  confidence: number
  boundingBox: SystemOcrBoundingBox
}

/** 本地 OCR 结果。不包含任何 Windows handle / native 内部对象。 */
export interface SystemOcrResult {
  success: boolean
  /** 归一化后的文本（去掉 CJK 字符之间的引擎伪空格） */
  text: string
  lines: SystemOcrLine[]
  /** 实际使用的 OCR 语言标签；null 表示由系统用户语言决定 */
  language: string | null
  engine: typeof SYSTEM_OCR_ENGINE
  durationMs: number
  /** 命中内存缓存时为 true */
  fromCache?: boolean
  errorCode?: SystemOcrErrorCode
  error?: string
}

export interface SystemOcrRequest {
  /** data URL（data:image/png;base64,...）。base64 只在 main 内部流转，不回传 Renderer。 */
  imageDataUrl: string
  /** 调用方已经算好的图片内容哈希；未传时由 main 内部计算 */
  imageHash?: string
  /** 指定 OCR 语言标签；默认按系统语言解析 */
  language?: string
}

/**
 * 缓存 key 组合。刻意与 ImageInsight 的 `imageHash` 保持不同的键空间，
 * 保证远端 Vision 的旧结果永远不会被当成"本地 OCR 结果"复用，
 * 也保证 System OCR 运行时升级后不会永远命中旧结果。
 */
export const buildSystemOcrCacheKey = (input: {
  imageHash: string
  language: string | null
  runtimeVersion: string | null
  platform?: string
}): string =>
  [
    input.imageHash,
    SYSTEM_OCR_ENGINE,
    input.platform ?? 'unknown',
    input.language ?? 'auto',
    input.runtimeVersion ?? 'unknown'
  ].join('|')

const CJK_CHAR =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/

/**
 * Windows OCR 会在每个 CJK 字符之间插入空格（"本 地 图 片"）。
 * 这里只删除 **两侧都是 CJK** 的空格，保留 "TraceMemo 本地图片文字识别" 里的真实分隔。
 */
export const normalizeSystemOcrText = (value: string): string => {
  const source = String(value ?? '')
  if (!source) return ''
  let result = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === ' ' || char === '\u3000') {
      const previous = result[result.length - 1]
      let next = ''
      for (let lookahead = index + 1; lookahead < source.length; lookahead += 1) {
        if (source[lookahead] !== ' ' && source[lookahead] !== '\u3000') {
          next = source[lookahead]
          break
        }
      }
      if (previous && next && CJK_CHAR.test(previous) && CJK_CHAR.test(next)) continue
    }
    result += char
  }
  return result.trim()
}

/** 把系统 locale（如 zh-CN / en-US）映射成 Windows OCR 语言标签。 */
const LANGUAGE_TAG_BY_LOCALE: Record<string, string> = {
  zh: 'zh-Hans-CN',
  'zh-cn': 'zh-Hans-CN',
  'zh-hans': 'zh-Hans-CN',
  'zh-hans-cn': 'zh-Hans-CN',
  'zh-sg': 'zh-Hans-CN',
  'zh-tw': 'zh-Hant-TW',
  'zh-hant': 'zh-Hant-TW',
  'zh-hant-tw': 'zh-Hant-TW',
  'zh-hk': 'zh-Hant-HK',
  'zh-hant-hk': 'zh-Hant-HK',
  'zh-mo': 'zh-Hant-MO',
  'zh-hant-mo': 'zh-Hant-MO',
  en: 'en-US',
  'en-us': 'en-US',
  'en-gb': 'en-GB',
  'en-au': 'en-AU',
  'en-ca': 'en-CA',
  ja: 'ja-JP',
  'ja-jp': 'ja-JP',
  ko: 'ko-KR',
  'ko-kr': 'ko-KR',
  fr: 'fr-FR',
  'fr-fr': 'fr-FR',
  de: 'de-DE',
  'de-de': 'de-DE',
  es: 'es-ES',
  'es-es': 'es-ES',
  it: 'it-IT',
  'it-it': 'it-IT',
  pt: 'pt-BR',
  'pt-br': 'pt-BR',
  ru: 'ru-RU',
  'ru-ru': 'ru-RU'
}

export const resolveSystemOcrLanguageTag = (
  locale: string | null | undefined
): string | null => {
  const normalized = String(locale ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  if (!normalized) return null
  if (LANGUAGE_TAG_BY_LOCALE[normalized]) return LANGUAGE_TAG_BY_LOCALE[normalized]
  const primary = normalized.split('-')[0]
  return LANGUAGE_TAG_BY_LOCALE[primary] ?? null
}

/**
 * 把 native 错误映射成产品级错误码。
 *
 * 已确认的 Windows 行为（1.2.0）：
 *   - 语言包缺失 / 引擎无法创建：`Windows error 操作成功完成。 (0x00000000)`
 *     —— TryCreateFromLanguage 返回 null 引擎但 HRESULT 是 S_OK，非常容易误判。
 *   - 送给解码器的字节不是可识别的图片：`Windows error Could not recognize file (0x80070005)`
 */
export const mapSystemOcrNativeError = (message: string): SystemOcrErrorCode => {
  const detail = String(message ?? '')
  if (!detail) return 'OCR_FAILED'
  if (/Cannot find native binding|Failed to load native binding|MODULE_NOT_FOUND/i.test(detail)) {
    return 'SYSTEM_OCR_UNAVAILABLE'
  }
  if (/\(0x00000000\)/.test(detail)) return 'OCR_LANGUAGE_UNAVAILABLE'
  if (/Could not recognize file/i.test(detail)) return 'IMAGE_DECODE_FAILED'
  if (/Could not open file/i.test(detail)) return 'IMAGE_DECODE_FAILED'
  return 'OCR_FAILED'
}

/** 解析 data URL；只接受图片 MIME。 */
export const parseImageDataUrl = (
  dataUrl: string
): { mimeType: string; base64: string } | null => {
  const matched = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(dataUrl ?? '').trim())
  if (!matched) return null
  return { mimeType: matched[1].toLowerCase(), base64: matched[2] }
}

export type SystemOcrImageFormat = 'png' | 'jpeg' | 'gif' | 'bmp' | 'webp' | 'tiff'

/** 按魔数识别格式。返回 null 表示不在支持范围内。 */
export const detectSystemOcrImageFormat = (buffer: Uint8Array): SystemOcrImageFormat | null => {
  if (!buffer || buffer.length < 4) return null
  const byte = (index: number): number => buffer[index]
  if (byte(0) === 0x89 && byte(1) === 0x50 && byte(2) === 0x4e && byte(3) === 0x47) return 'png'
  if (byte(0) === 0xff && byte(1) === 0xd8 && byte(2) === 0xff) return 'jpeg'
  if (byte(0) === 0x47 && byte(1) === 0x49 && byte(2) === 0x46) return 'gif'
  if (byte(0) === 0x42 && byte(1) === 0x4d) return 'bmp'
  if (
    byte(0) === 0x52 &&
    byte(1) === 0x49 &&
    byte(2) === 0x46 &&
    byte(3) === 0x46 &&
    buffer.length > 11 &&
    byte(8) === 0x57 &&
    byte(9) === 0x45 &&
    byte(10) === 0x42 &&
    byte(11) === 0x50
  ) {
    return 'webp'
  }
  if ((byte(0) === 0x49 && byte(1) === 0x49) || (byte(0) === 0x4d && byte(1) === 0x4d)) {
    return 'tiff'
  }
  return null
}

/**
 * 64x32 纯白 PNG。仅用于 language capability 探测：
 * 引擎能创建 → 该语言包可用；引擎创建失败 → 语言不可用。
 * 探测耗时量级为个位数毫秒。
 */
export const SYSTEM_OCR_PROBE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAANUlEQVR42u3PAQkAAAgDMLV/59tCELYG6yT12dRzAgICAgICAgICAgICAgICAgICAgICAvcWMisDPdIJjMIAAAAASUVORK5CYII='
