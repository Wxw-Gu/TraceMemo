// src/shared/system-ocr.ts
//
// 本地系统 OCR（System OCR）共享契约。
//
// 架构边界（不要混淆）：
//   - System OCR 是**本地 Runtime**，不是 AI Provider，也不是 Vision Model。
//     它不占用 AIVisionRuntimeConfig.source，也不产生任何网络请求。
//   - 能力边界：只把图片里的文字读出来。它不等于「理解人物 / 理解场景 /
//     描述照片 / 理解表情包语义 / 视觉推理」——那些仍然属于 Vision Model。
//   - 后端按平台选择（统一经 @napi-rs/system-ocr 调用）：
//       Windows → Windows.Media.Ocr.OcrEngine
//       macOS   → Apple Vision（VNRecognizeTextRequest / RecognizeDocumentsRequest）
//     Linux 不支持。
//   - 引擎标识会进入 artifact 指纹与缓存 key，两个平台的结果**不得互相复用**。
//
// 数据边界：
//   - OCR 文字始终是**派生内容**，会把原图定位回去（artifact + binding），
//     但绝不写回 WCDB、也绝不伪装成原始聊天文字；原始消息始终是权威来源。
//   - 历史图片回填与 Knowledge 回填由 image-text-index 负责，本模块只提供识别能力。

/** Windows 引擎标识（Windows.Media.Ocr.OcrEngine）。 */
export const SYSTEM_OCR_ENGINE_WINDOWS = 'windows-system-ocr'

/** macOS 引擎标识（Apple Vision）。 */
export const SYSTEM_OCR_ENGINE_MACOS = 'macos-system-ocr'

/** System OCR 引擎标识。这是本地 Runtime，不是 provider id。 */
export type SystemOcrEngine = typeof SYSTEM_OCR_ENGINE_WINDOWS | typeof SYSTEM_OCR_ENGINE_MACOS

/** 支持 System OCR 的平台。Linux 明确不支持。 */
export const isSystemOcrPlatform = (platform: string): boolean =>
  platform === 'win32' || platform === 'darwin'

/**
 * 平台 → 引擎标识。
 *
 * 不要把引擎串硬编码成某一个平台：它同时是 artifact 指纹的一部分，
 * 一旦写死，跨平台结果就会互相复用。
 */
export const resolveSystemOcrEngine = (platform: string): SystemOcrEngine =>
  platform === 'darwin' ? SYSTEM_OCR_ENGINE_MACOS : SYSTEM_OCR_ENGINE_WINDOWS

/** 本地 OCR 结果在内存中的缓存时长。 */
export const SYSTEM_OCR_CACHE_TTL_MS = 10 * 60 * 1000

/**
 * 产品级错误码。用户可见文案由 error 字段承载，任何 native 堆栈 / HRESULT
 * 都不会直接透出到 Renderer。
 */
export type SystemOcrErrorCode =
  /** 运行时不可用（native binding 缺失 / 加载失败） */
  | 'SYSTEM_OCR_UNAVAILABLE'
  /** 当前平台不支持（Linux，或非 Windows / macOS 平台） */
  | 'UNSUPPORTED_PLATFORM'
  /** 图片格式不在支持范围内 */
  | 'UNSUPPORTED_IMAGE'
  /** 图片解码失败（格式可识别但内容损坏或无法转成可识别图像） */
  | 'IMAGE_DECODE_FAILED'
  /** 当前 Windows 未安装对应的 OCR 语言支持（macOS 由 Vision 自行决定，不会出现） */
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
  engine: SystemOcrEngine
  platform: NodeJS.Platform
  arch: string
  /** @napi-rs/system-ocr 运行时版本；无法读取时为 null */
  runtimeVersion: string | null
  /**
   * 实际使用的 OCR 语言标签。
   *
   * Windows 为系统语言包对应的标签（如 zh-Hans-CN）；macOS 由 Vision 自行决定识别语言，
   * 这里恒为 null（对应 UI 的「跟随系统语言」）。null 也表示走系统语言。
   */
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
  /** Windows 恒为 1.0；macOS 为 Vision 返回的逐行平均置信度 */
  confidence: number
  boundingBox: SystemOcrBoundingBox
}

/** 本地 OCR 结果。不包含任何平台 handle / native 内部对象。 */
export interface SystemOcrResult {
  success: boolean
  /** 归一化后的文本（去掉 CJK 字符之间的引擎伪空格） */
  text: string
  lines: SystemOcrLine[]
  /** 实际使用的 OCR 语言标签；null 表示由系统决定识别语言 */
  language: string | null
  engine: SystemOcrEngine
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
 * 也保证 System OCR 运行时升级 / 切换平台后不会永远命中旧结果。
 */
export const buildSystemOcrCacheKey = (input: {
  imageHash: string
  language: string | null
  runtimeVersion: string | null
  platform?: string
  engine?: SystemOcrEngine
}): string => {
  const platform = input.platform ?? 'unknown'
  return [
    input.imageHash,
    input.engine ?? resolveSystemOcrEngine(platform),
    platform,
    input.language ?? 'auto',
    input.runtimeVersion ?? 'unknown'
  ].join('|')
}

const CJK_CHAR =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/

/**
 * Windows OCR 会在每个 CJK 字符之间插入空格（"本 地 图 片"）。
 * 这里只删除 **两侧都是 CJK** 的空格，保留 "TraceMemo 本地图片文字识别" 里的真实分隔。
 *
 * macOS（Vision）本就输出连续中文，这条规则对它恒等；保留是为了两个平台共用一条
 * 归一化路径，而不是给 macOS 加特例。
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

/**
 * 把系统 locale（如 zh-CN / en-US）映射成 **Windows OCR 语言标签**
 * （即 Windows 语言包里注册的 BCP-47 标签，中文带 region 子标签）。
 */
const WINDOWS_LANGUAGE_TAG_BY_LOCALE: Record<string, string> = {
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

/**
 * 把系统 locale 映射成 **Apple Vision 语言标签**。
 *
 * 与 Windows 表刻意分开：Vision 只认脚本级子标签（`zh-Hans` / `zh-Hant`），
 * 不认 `zh-Hans-CN` 这类 region 组合；港台繁体统一收敛到 `zh-Hant`。
 */
const MACOS_LANGUAGE_TAG_BY_LOCALE: Record<string, string> = {
  zh: 'zh-Hans',
  'zh-cn': 'zh-Hans',
  'zh-sg': 'zh-Hans',
  'zh-hans': 'zh-Hans',
  'zh-hans-cn': 'zh-Hans',
  'zh-hans-sg': 'zh-Hans',
  'zh-tw': 'zh-Hant',
  'zh-hk': 'zh-Hant',
  'zh-mo': 'zh-Hant',
  'zh-hant': 'zh-Hant',
  'zh-hant-tw': 'zh-Hant',
  'zh-hant-hk': 'zh-Hant',
  'zh-hant-mo': 'zh-Hant',
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

const lookupLanguageTag = (
  table: Record<string, string>,
  locale: string | null | undefined
): string | null => {
  const normalized = String(locale ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  if (!normalized) return null
  if (table[normalized]) return table[normalized]
  const primary = normalized.split('-')[0]
  return table[primary] ?? null
}

/** 系统 locale → Windows OCR 语言标签。 */
export const resolveWindowsOcrLanguageTag = (locale: string | null | undefined): string | null =>
  lookupLanguageTag(WINDOWS_LANGUAGE_TAG_BY_LOCALE, locale)

/** 系统 locale → Apple Vision 语言标签。 */
export const resolveMacOcrLanguageTag = (locale: string | null | undefined): string | null =>
  lookupLanguageTag(MACOS_LANGUAGE_TAG_BY_LOCALE, locale)

/** 按平台把系统 locale 映射成该平台 OCR 引擎接受的语言标签。 */
export const resolveSystemOcrLanguageTag = (
  locale: string | null | undefined,
  platform: string = 'win32'
): string | null =>
  platform === 'darwin' ? resolveMacOcrLanguageTag(locale) : resolveWindowsOcrLanguageTag(locale)

/**
 * 把 native 错误映射成产品级错误码。
 *
 * 已确认的 Windows 行为（1.2.0）：
 *   - 语言包缺失 / 引擎无法创建：`Windows error 操作成功完成。 (0x00000000)`
 *     —— TryCreateFromLanguage 返回 null 引擎但 HRESULT 是 S_OK，非常容易误判。
 *   - 送给解码器的字节不是可识别的图片：`Windows error Could not recognize file (0x80070005)`
 *
 * 已确认的 macOS 行为（1.2.0 / Vision）：
 *   - 图片无法解码成 CGImage（截断、伪造魔数、维度非法）：
 *     `CRImage Reader Detector was given zero-dimensioned image (0 x 0)`
 *   - 图片任一边不超过 2px：`The image is too small in at least one dimension 2 x 2 ...`
 *   - **图片没有文字时是抛错而不是返回空文本**：`No text recognized`
 *     —— 它必须映射成 `OCR_EMPTY_RESULT`（正常终态）。映射成失败会让表情包 /
 *     风景图 / 头像全部变成"可重试失败"，既污染派生库也会被反复重试。
 *   - macOS 没有"语言包缺失"这个概念（Vision 自行决定识别语言），
 *     所以这里不会映射出 OCR_LANGUAGE_UNAVAILABLE。
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
  // macOS Vision / CoreImage 解码失败。
  if (/zero-dimensioned image/i.test(detail)) return 'IMAGE_DECODE_FAILED'
  if (/The image is too small/i.test(detail)) return 'IMAGE_DECODE_FAILED'
  if (/CRImage|CIImage|CGImage/i.test(detail)) return 'IMAGE_DECODE_FAILED'
  // macOS Vision 的"图里没有文字"：正常终态，不是失败。
  if (/No text recognized/i.test(detail)) return 'OCR_EMPTY_RESULT'
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
