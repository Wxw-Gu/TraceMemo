// src/main/services/system-ocr-service.ts
//
// System OCR Runtime（本地图片文字识别）。
//
// 职责边界（只做这些事）：
//   1. capability detection
//   2. image normalization / preparation
//   3. OCR execution
//   4. result normalization
//   5. runtime metadata
//   6. error mapping
//
// 明确不做：
//   - 不伪装成 AI Provider / Vision Model；不读写 AIVisionRuntimeConfig；
//   - 不发任何网络请求；不上传原图；
//   - 不遍历历史图片、不做 backfill、不写 Knowledge；
//   - 不把 OCR 文本写进 image-insights.json（那是 Vision 结果的缓存）。
//
// Windows 后端：Windows.Media.Ocr.OcrEngine（经 @napi-rs/system-ocr）。
// 已实测的引擎行为（@napi-rs/system-ocr 1.2.0 / Electron 43 / Windows x64）：
//   - Buffer 输入只接受 PNG；JPEG / WEBP / BMP 会被判为不可识别，
//     所以本服务在边界上统一归一化成 PNG 字节再调用（不落盘）。
//   - preferredLangs 只使用第一个语言；语言包缺失时引擎创建失败，
//     抛出的错误是 `Windows error 操作成功完成。 (0x00000000)`（HRESULT 为 S_OK）。
//   - 空白图不会报错，返回空文本 → 映射成 OCR_EMPTY_RESULT。
//   - CJK 字符之间会被引擎插入空格，结果里做归一化。

import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  SYSTEM_OCR_CACHE_TTL_MS,
  SYSTEM_OCR_ENGINE,
  SYSTEM_OCR_PROBE_PNG_BASE64,
  buildSystemOcrCacheKey,
  detectSystemOcrImageFormat,
  mapSystemOcrNativeError,
  normalizeSystemOcrText,
  parseImageDataUrl,
  resolveSystemOcrLanguageTag
} from '../../shared/system-ocr'
import type {
  SystemOcrCapability,
  SystemOcrErrorCode,
  SystemOcrImageFormat,
  SystemOcrLine,
  SystemOcrRequest,
  SystemOcrResult
} from '../../shared/system-ocr'

const NATIVE_PACKAGE = '@napi-rs/system-ocr'
const MAX_CACHE_ENTRIES = 32
const FFMPEG_TIMEOUT_MS = 10_000

interface NativeLine {
  text: string
  confidence: number
  boundingBox: { x: number; y: number; width: number; height: number }
}

interface NativeResult {
  text: string
  confidence: number
  lines: NativeLine[]
}

interface NativeRuntime {
  version: string | null
  recognize: (image: Uint8Array, accuracy?: number, languages?: string[]) => Promise<NativeResult>
}

export interface SystemOcrServiceDeps {
  /** 加载 native 运行时；不可用时返回 null（不允许抛） */
  loadRuntime?: () => NativeRuntime | null
  /** 把输入图片转成 PNG 字节；失败返回 null */
  toPngBytes?: (input: {
    buffer: Buffer
    format: SystemOcrImageFormat
  }) => Promise<Buffer | null>
  /**
   * ffmpeg 可执行文件解析器。只用于 GIF/BMP/WebP/TIFF → PNG 的兜底归一化。
   * main/index.ts 会注入项目统一的解析逻辑（与图片解密共用一套候选路径）。
   */
  resolveFfmpegExecutable?: () => string
  platform?: NodeJS.Platform
  arch?: string
  /** 系统 locale（如 zh-CN），用于推导 OCR 语言标签 */
  locale?: () => string
}

/** 未被显式注入时的兜底：环境变量 → 打包内 ffmpeg-static → PATH。 */
const defaultResolveFfmpegExecutable = (): string => {
  const fromEnvironment = String(process.env['FFMPEG_BIN'] || '').trim()
  if (fromEnvironment) return fromEnvironment
  try {
    const bundled = require('ffmpeg-static') as string | null
    if (bundled) return bundled
  } catch {
    // 忽略：退回到 PATH 上的 ffmpeg
  }
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
}

const toLines = (lines: NativeLine[] | undefined): SystemOcrLine[] =>
  Array.isArray(lines)
    ? lines.map((line) => ({
        text: normalizeSystemOcrText(line.text),
        confidence: typeof line.confidence === 'number' ? line.confidence : 1,
        boundingBox: {
          x: Number(line.boundingBox?.x ?? 0),
          y: Number(line.boundingBox?.y ?? 0),
          width: Number(line.boundingBox?.width ?? 0),
          height: Number(line.boundingBox?.height ?? 0)
        }
      }))
    : []

const failure = (
  errorCode: SystemOcrErrorCode,
  error: string,
  startedAt: number
): SystemOcrResult => ({
  success: false,
  text: '',
  lines: [],
  language: null,
  engine: SYSTEM_OCR_ENGINE,
  durationMs: Date.now() - startedAt,
  errorCode,
  error
})

/** 把任意容器（gif/bmp/webp/tiff）用 ffmpeg 走内存管道转成 PNG。不落盘。 */
const convertWithFfmpeg = (buffer: Buffer, executable: string): Promise<Buffer | null> =>
  new Promise((resolve) => {
    let settled = false
    const finish = (value: Buffer | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        executable,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          'pipe:0',
          '-frames:v',
          '1',
          '-f',
          'image2pipe',
          '-vcodec',
          'png',
          'pipe:1'
        ],
        { windowsHide: true }
      )
    } catch {
      finish(null)
      return
    }
    const chunks: Buffer[] = []
    const timeout = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // best-effort
      }
      finish(null)
    }, FFMPEG_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', () => {
      clearTimeout(timeout)
      finish(null)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      finish(code === 0 && chunks.length > 0 ? Buffer.concat(chunks) : null)
    })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(buffer)
  })

class SystemOcrService {
  private runtime: NativeRuntime | null = null
  private runtimeLoaded = false
  private capability: SystemOcrCapability | null = null
  private capabilityPromise: Promise<SystemOcrCapability> | null = null
  private readonly cache = new Map<string, { value: SystemOcrResult; expireAt: number }>()
  private deps: SystemOcrServiceDeps = {}

  constructor(deps: SystemOcrServiceDeps = {}) {
    this.deps = deps
  }

  /** 由 main/index.ts 在 app ready 后调用（可选，用于注入 app.getLocale 等）。 */
  bind(deps: SystemOcrServiceDeps): void {
    this.deps = { ...this.deps, ...deps }
    this.runtime = null
    this.runtimeLoaded = false
    this.capability = null
    this.capabilityPromise = null
  }

  /** 仅测试用：清空探测与缓存状态。 */
  reset(): void {
    this.runtime = null
    this.runtimeLoaded = false
    this.capability = null
    this.capabilityPromise = null
    this.cache.clear()
  }

  private get platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform
  }

  private get arch(): string {
    return this.deps.arch ?? process.arch
  }

  private get locale(): string {
    if (this.deps.locale) {
      try {
        return this.deps.locale()
      } catch {
        return ''
      }
    }
    try {
      const { app } = require('electron') as typeof import('electron')
      return app?.getLocale?.() ?? ''
    } catch {
      return ''
    }
  }

  private loadRuntime(): NativeRuntime | null {
    if (this.runtimeLoaded) return this.runtime
    this.runtimeLoaded = true
    if (this.deps.loadRuntime) {
      this.runtime = this.deps.loadRuntime()
      return this.runtime
    }
    if (this.platform !== 'win32') {
      this.runtime = null
      return this.runtime
    }
    try {
      // 原生模块必须在打包时 external + asarUnpack，否则这里会 MODULE_NOT_FOUND。
      const nativeModule = require(NATIVE_PACKAGE) as {
        recognize: NativeRuntime['recognize']
      }
      let version: string | null = null
      try {
        version = (require(`${NATIVE_PACKAGE}/package.json`) as { version?: string }).version ?? null
      } catch {
        version = null
      }
      this.runtime =
        nativeModule && typeof nativeModule.recognize === 'function'
          ? { version, recognize: nativeModule.recognize.bind(nativeModule) }
          : null
    } catch (error) {
      console.warn(
        '[SystemOcrService] native runtime unavailable engine=%s platform=%s reason=%s',
        SYSTEM_OCR_ENGINE,
        this.platform,
        error instanceof Error ? error.message.split('\n')[0] : String(error)
      )
      this.runtime = null
    }
    return this.runtime
  }

  private async toPngBytes(
    buffer: Buffer,
    format: SystemOcrImageFormat
  ): Promise<Buffer | null> {
    if (this.deps.toPngBytes) return this.deps.toPngBytes({ buffer, format })
    if (format === 'png') return buffer
    if (format === 'jpeg') {
      // 项目内已有的进程内解码能力，优先于 ffmpeg（更快、无子进程）。
      try {
        const { nativeImage } = require('electron') as typeof import('electron')
        const image = nativeImage.createFromBuffer(buffer)
        if (!image.isEmpty()) {
          const png = image.toPNG()
          if (png && png.length > 0) return png
        }
      } catch {
        // 继续走 ffmpeg 兜底
      }
    }
    try {
      const resolveFfmpeg = this.deps.resolveFfmpegExecutable ?? defaultResolveFfmpegExecutable
      const png = await convertWithFfmpeg(buffer, resolveFfmpeg())
      return png
    } catch {
      return null
    }
  }

  /** capability 探测：平台 → native 运行时 → 至少一个可用 OCR 语言。 */
  async getCapability(force = false): Promise<SystemOcrCapability> {
    if (!force && this.capability) return this.capability
    if (!force && this.capabilityPromise) return this.capabilityPromise
    this.capabilityPromise = this.detectCapability()
    try {
      this.capability = await this.capabilityPromise
    } finally {
      this.capabilityPromise = null
    }
    return this.capability
  }

  private async detectCapability(): Promise<SystemOcrCapability> {
    const base: Pick<
      SystemOcrCapability,
      'engine' | 'platform' | 'arch' | 'runtimeVersion' | 'language'
    > = {
      engine: SYSTEM_OCR_ENGINE,
      platform: this.platform,
      arch: this.arch,
      runtimeVersion: null,
      language: null
    }
    if (this.platform !== 'win32') {
      return {
        ...base,
        available: false,
        reason: 'UNSUPPORTED_PLATFORM',
        message: '本地图片文字识别目前仅支持 Windows。'
      }
    }
    const runtime = this.loadRuntime()
    if (!runtime) {
      return {
        ...base,
        available: false,
        reason: 'NATIVE_MODULE_MISSING',
        message: '本地文字识别组件不可用，请重新安装 TraceMemo。'
      }
    }
    const probed = await this.probeLanguage(runtime)
    if (probed.reason) {
      return {
        ...base,
        runtimeVersion: runtime.version,
        available: false,
        reason: probed.reason,
        message: probed.message
      }
    }
    return {
      ...base,
      runtimeVersion: runtime.version,
      available: true,
      language: probed.language,
      message: probed.language
        ? `本地图片文字识别可用（Windows 系统 OCR，${probed.language}）。`
        : '本地图片文字识别可用（Windows 系统 OCR，跟随系统语言）。'
    }
  }

  /**
   * 用一个 64x32 纯白 PNG 探测语言可用性：引擎能创建即说明语言包可用。
   * 首选「系统 locale 推导出的标签」，失败再退回「系统用户语言配置」。
   */
  private async probeLanguage(
    runtime: NativeRuntime
  ): Promise<
    | { language: string | null; reason?: undefined; message?: undefined }
    | { language: null; reason: 'LANGUAGE_UNAVAILABLE' | 'NATIVE_MODULE_MISSING'; message: string }
  > {
    const probeBuffer = Buffer.from(SYSTEM_OCR_PROBE_PNG_BASE64, 'base64')
    const preferred = resolveSystemOcrLanguageTag(this.locale)
    const candidates: Array<string | null> = preferred ? [preferred, null] : [null]
    let lastCode: SystemOcrErrorCode = 'OCR_FAILED'
    for (const candidate of candidates) {
      try {
        await runtime.recognize(
          probeBuffer,
          undefined,
          candidate ? [candidate] : undefined
        )
        return { language: candidate }
      } catch (error) {
        lastCode = mapSystemOcrNativeError(
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    if (lastCode === 'OCR_LANGUAGE_UNAVAILABLE') {
      return {
        language: null,
        reason: 'LANGUAGE_UNAVAILABLE',
        message:
          '当前 Windows 未安装可用的 OCR 语言支持，请在系统「语言和区域」里安装简体中文或英文的 OCR 语言包后重试。'
      }
    }
    return {
      language: null,
      reason: 'NATIVE_MODULE_MISSING',
      message: '本地文字识别引擎初始化失败，请重启 TraceMemo 或重新安装。'
    }
  }

  private readCache(key: string, startedAt: number): SystemOcrResult | null {
    const hit = this.cache.get(key)
    if (!hit) return null
    if (hit.expireAt <= Date.now()) {
      this.cache.delete(key)
      return null
    }
    return { ...hit.value, durationMs: Date.now() - startedAt, fromCache: true }
  }

  private writeCache(key: string, value: SystemOcrResult): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next()
      if (!oldest.done) this.cache.delete(oldest.value)
    }
    this.cache.set(key, { value, expireAt: Date.now() + SYSTEM_OCR_CACHE_TTL_MS })
  }

  /**
   * 识别一张图片里的文字。
   * 任意失败都不抛，统一返回 success=false + 产品级 errorCode。
   */
  async recognize(request: SystemOcrRequest): Promise<SystemOcrResult> {
    const startedAt = Date.now()
    const parsed = parseImageDataUrl(request.imageDataUrl)
    if (!parsed) {
      return failure('UNSUPPORTED_IMAGE', '仅支持 PNG、JPG、JPEG、WebP、GIF、BMP 图片。', startedAt)
    }
    let sourceBuffer: Buffer
    try {
      sourceBuffer = Buffer.from(parsed.base64, 'base64')
    } catch {
      return failure('IMAGE_DECODE_FAILED', '图片数据无法解码。', startedAt)
    }
    if (sourceBuffer.length === 0) {
      return failure('IMAGE_DECODE_FAILED', '图片数据为空。', startedAt)
    }
    const format = detectSystemOcrImageFormat(sourceBuffer)
    if (!format) {
      return failure('UNSUPPORTED_IMAGE', '无法识别的图片格式。', startedAt)
    }

    const imageHash =
      request.imageHash?.trim() ||
      crypto.createHash('sha256').update(sourceBuffer).digest('hex').slice(0, 32)
    const requestedLanguage = request.language?.trim() || null

    const capability = await this.getCapability()
    if (!capability.available) {
      const errorCode: SystemOcrErrorCode =
        capability.reason === 'UNSUPPORTED_PLATFORM'
          ? 'UNSUPPORTED_PLATFORM'
          : capability.reason === 'LANGUAGE_UNAVAILABLE'
            ? 'OCR_LANGUAGE_UNAVAILABLE'
            : 'SYSTEM_OCR_UNAVAILABLE'
      return failure(errorCode, capability.message, startedAt)
    }

    const languageForCache = requestedLanguage ?? capability.language
    const cacheKey = buildSystemOcrCacheKey({
      imageHash,
      language: languageForCache,
      runtimeVersion: capability.runtimeVersion,
      platform: capability.platform
    })
    if (requestedLanguage === null) {
      const cached = this.readCache(cacheKey, startedAt)
      if (cached) return cached
    }

    const runtime = this.loadRuntime()
    if (!runtime) {
      return failure('SYSTEM_OCR_UNAVAILABLE', '本地文字识别组件不可用。', startedAt)
    }

    const png = await this.toPngBytes(sourceBuffer, format)
    if (!png || png.length === 0 || !detectSystemOcrImageFormat(png)) {
      return failure('IMAGE_DECODE_FAILED', '图片解码失败，无法读取这张图片。', startedAt)
    }

    const candidates: Array<string | null> = requestedLanguage
      ? [requestedLanguage]
      : capability.language
        ? [capability.language, null]
        : [null]
    let lastErrorCode: SystemOcrErrorCode = 'OCR_FAILED'
    let lastErrorMessage = ''
    let usedLanguage: string | null = null
    for (const candidate of candidates) {
      try {
        const result = await runtime.recognize(
          png,
          undefined,
          candidate ? [candidate] : undefined
        )
        const text = normalizeSystemOcrText(result?.text ?? '')
        const lines = toLines(result?.lines)
        usedLanguage = candidate
        if (!text) {
          return failure('OCR_EMPTY_RESULT', '没有在这张图片里识别到文字。', startedAt)
        }
        const succeeded: SystemOcrResult = {
          success: true,
          text,
          lines,
          language: usedLanguage,
          engine: SYSTEM_OCR_ENGINE,
          durationMs: Date.now() - startedAt
        }
        // 生产日志只记录 error code / engine / platform / duration，绝不记录识别正文。
        console.log(
          '[SystemOcrService] ok engine=%s platform=%s language=%s chars=%d durationMs=%d',
          SYSTEM_OCR_ENGINE,
          capability.platform,
          usedLanguage ?? 'system-default',
          text.length,
          succeeded.durationMs
        )
        this.writeCache(cacheKey, succeeded)
        return succeeded
      } catch (error) {
        lastErrorMessage = error instanceof Error ? error.message : String(error)
        lastErrorCode = mapSystemOcrNativeError(lastErrorMessage)
        // 语言不可用才值得换下一个候选；其它错误直接结束，避免无意义重试。
        if (lastErrorCode !== 'OCR_LANGUAGE_UNAVAILABLE') break
      }
    }

    console.warn(
      '[SystemOcrService] failed engine=%s platform=%s errorCode=%s durationMs=%d',
      SYSTEM_OCR_ENGINE,
      capability.platform,
      lastErrorCode,
      Date.now() - startedAt
    )
    return failure(
      lastErrorCode,
      lastErrorCode === 'OCR_LANGUAGE_UNAVAILABLE'
        ? '当前 Windows 未安装可用的 OCR 语言支持。'
        : '本地文字识别失败，请稍后重试。',
      startedAt
    )
  }
}

export { SystemOcrService }
export const systemOcrService = new SystemOcrService()
