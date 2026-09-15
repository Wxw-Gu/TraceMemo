import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SYSTEM_OCR_ENGINE,
  SYSTEM_OCR_PROBE_PNG_BASE64,
  buildSystemOcrCacheKey,
  detectSystemOcrImageFormat,
  mapSystemOcrNativeError,
  normalizeSystemOcrText,
  parseImageDataUrl,
  resolveSystemOcrLanguageTag
} from '../../src/shared/system-ocr'

vi.mock('../../src/main/image-decrypt-service', () => ({
  resolveFfmpegExecutable: (): string => 'ffmpeg'
}))

const { getByHash, upsert } = vi.hoisted(() => ({
  getByHash: vi.fn(),
  upsert: vi.fn()
}))

vi.mock('../../src/main/db/image-insights-store', () => ({
  imageInsightsStore: {
    getByHash,
    upsert,
    listBySession: vi.fn(() => [])
  }
}))

import { SystemOcrService } from '../../src/main/services/system-ocr-service'
import { imageInsightService } from '../../src/main/services/image-insight-service'

const PROBE_BYTES = Buffer.from(SYSTEM_OCR_PROBE_PNG_BASE64, 'base64')
const FIXTURE_PNG = readFileSync(join(__dirname, '..', 'fixtures', 'ocr', 'system-ocr-zh.png'))
const PNG_DATA_URL = `data:image/png;base64,${FIXTURE_PNG.toString('base64')}`
const JPEG_DATA_URL = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64')}`
const GARBAGE_DATA_URL = `data:image/png;base64,${Buffer.from('definitely-not-an-image').toString('base64')}`

const LANGUAGE_UNAVAILABLE_MESSAGE = 'Windows error 操作成功完成。 (0x00000000)'
const DECODE_FAILED_MESSAGE = 'Windows error Could not recognize file (0x80070005)'

/**
 * mock 运行时按「探测图字节」区分 capability probe 和业务调用，
 * 这样 probeError 才能稳定复现「语言包缺失」的场景。
 */
const createRuntime = (
  options: {
    text?: string
    lines?: Array<{ text: string; confidence?: number }>
    probeError?: string
    error?: string
    version?: string | null
  } = {}
): { version: string | null; recognize: ReturnType<typeof vi.fn> } => {
  const recognize = vi.fn(
    async (image: Uint8Array, _accuracy?: number, _languages?: string[]): Promise<unknown> => {
      if (Buffer.from(image).equals(PROBE_BYTES)) {
        if (options.probeError) throw new Error(options.probeError)
        return { text: '', confidence: 1, lines: [] }
      }
      if (options.error) throw new Error(options.error)
      const text = options.text ?? ''
      return {
        text,
        confidence: 1,
        lines: (options.lines ?? [{ text, confidence: 1 }]).map((line) => ({
          text: line.text,
          confidence: line.confidence ?? 1,
          boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
        }))
      }
    }
  )
  return { version: options.version === undefined ? '1.2.0' : options.version, recognize }
}

const createService = (
  runtime: { version: string | null; recognize: ReturnType<typeof vi.fn> } | null,
  overrides: Partial<ConstructorParameters<typeof SystemOcrService>[0]> = {}
): SystemOcrService =>
  new SystemOcrService({
    platform: 'win32',
    arch: 'x64',
    locale: () => 'zh-CN',
    loadRuntime: () => (runtime ? { ...runtime } : null),
    toPngBytes: async ({ buffer }) => buffer,
    ...overrides
  })

describe('system-ocr shared helpers', () => {
  it('removes only the engine-inserted spaces between CJK glyphs', () => {
    expect(normalizeSystemOcrText('TraceMemo 本 地 图 片 文 字 识 别')).toBe(
      'TraceMemo 本地图片文字识别'
    )
    expect(normalizeSystemOcrText('TraceMemo System OCR')).toBe('TraceMemo System OCR')
    expect(normalizeSystemOcrText('  本  地  ')).toBe('本地')
  })

  it('maps system locale onto Windows OCR language tags', () => {
    expect(resolveSystemOcrLanguageTag('zh-CN')).toBe('zh-Hans-CN')
    expect(resolveSystemOcrLanguageTag('zh-Hans-CN')).toBe('zh-Hans-CN')
    expect(resolveSystemOcrLanguageTag('zh_TW')).toBe('zh-Hant-TW')
    expect(resolveSystemOcrLanguageTag('en-US')).toBe('en-US')
    expect(resolveSystemOcrLanguageTag('en')).toBe('en-US')
    expect(resolveSystemOcrLanguageTag('')).toBeNull()
    expect(resolveSystemOcrLanguageTag('xx-YY')).toBeNull()
  })

  it('maps native Windows errors onto product error codes', () => {
    expect(mapSystemOcrNativeError(LANGUAGE_UNAVAILABLE_MESSAGE)).toBe('OCR_LANGUAGE_UNAVAILABLE')
    expect(mapSystemOcrNativeError(DECODE_FAILED_MESSAGE)).toBe('IMAGE_DECODE_FAILED')
    expect(mapSystemOcrNativeError('Cannot find native binding.')).toBe('SYSTEM_OCR_UNAVAILABLE')
    expect(mapSystemOcrNativeError('Failed to load native binding')).toBe('SYSTEM_OCR_UNAVAILABLE')
    expect(mapSystemOcrNativeError('Windows error something broke (0x80070057)')).toBe('OCR_FAILED')
    expect(mapSystemOcrNativeError('')).toBe('OCR_FAILED')
  })

  it('parses image data urls and rejects other payloads', () => {
    expect(parseImageDataUrl(PNG_DATA_URL)).toMatchObject({ mimeType: 'image/png' })
    expect(parseImageDataUrl('data:text/plain;base64,aGk=')).toBeNull()
    expect(parseImageDataUrl('not-a-data-url')).toBeNull()
  })

  it('detects supported container formats by magic bytes', () => {
    expect(detectSystemOcrImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe('png')
    expect(detectSystemOcrImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
    expect(detectSystemOcrImageFormat(Buffer.from('GIF89a'))).toBe('gif')
    expect(detectSystemOcrImageFormat(Buffer.from('BM1234'))).toBe('bmp')
    expect(
      detectSystemOcrImageFormat(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))
    ).toBe('webp')
    expect(detectSystemOcrImageFormat(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBe('tiff')
    expect(detectSystemOcrImageFormat(Buffer.from('nope'))).toBeNull()
  })

  it('keeps the local OCR cache keyspace separate from the vision imageHash', () => {
    const base = { imageHash: 'a'.repeat(32), language: 'zh-Hans-CN', runtimeVersion: '1.2.0' }
    const key = buildSystemOcrCacheKey({ ...base, platform: 'win32' })
    expect(key).not.toBe(base.imageHash)
    expect(key).toContain(SYSTEM_OCR_ENGINE)
    expect(key).toContain('zh-Hans-CN')
    expect(key).toContain('1.2.0')
    // 语言或运行时版本变化必须换 key，避免复用过期 / 跨引擎结果。
    expect(buildSystemOcrCacheKey({ ...base, language: 'en-US', platform: 'win32' })).not.toBe(key)
    expect(
      buildSystemOcrCacheKey({ ...base, runtimeVersion: '1.3.0', platform: 'win32' })
    ).not.toBe(key)
  })
})

describe('SystemOcrService capability detection', () => {
  it('reports available with the probed language on Windows', async () => {
    const service = createService(createRuntime())
    const capability = await service.getCapability()
    expect(capability).toMatchObject({
      available: true,
      engine: SYSTEM_OCR_ENGINE,
      platform: 'win32',
      arch: 'x64',
      runtimeVersion: '1.2.0',
      language: 'zh-Hans-CN'
    })
  })

  it('is unavailable on unsupported platforms without loading a runtime', async () => {
    const loadRuntime = vi.fn(() => null)
    const service = createService(null, { platform: 'linux', loadRuntime })
    const capability = await service.getCapability()
    expect(capability.available).toBe(false)
    expect(capability.reason).toBe('UNSUPPORTED_PLATFORM')
    expect(loadRuntime).not.toHaveBeenCalled()
  })

  it('is unavailable when the native runtime cannot be loaded', async () => {
    const service = createService(null)
    const capability = await service.getCapability()
    expect(capability.available).toBe(false)
    expect(capability.reason).toBe('NATIVE_MODULE_MISSING')
  })

  it('reports a missing Windows OCR language pack as LANGUAGE_UNAVAILABLE', async () => {
    const runtime = createRuntime({ probeError: LANGUAGE_UNAVAILABLE_MESSAGE })
    const service = createService(runtime)
    const capability = await service.getCapability()
    expect(capability.available).toBe(false)
    expect(capability.reason).toBe('LANGUAGE_UNAVAILABLE')
    expect(capability.message).toContain('OCR 语言')
  })
})

describe('SystemOcrService recognition', () => {
  beforeEach(() => {
    getByHash.mockReset()
    getByHash.mockReturnValue(null)
    upsert.mockReset()
  })

  it('normalizes a successful result and reports runtime metadata', async () => {
    const runtime = createRuntime({
      text: 'TraceMemo 本 地 OCR 2026',
      lines: [{ text: 'TraceMemo 本 地 OCR 2026' }]
    })
    const service = createService(runtime)

    const result = await service.recognize({ imageDataUrl: PNG_DATA_URL })

    expect(result).toMatchObject({
      success: true,
      text: 'TraceMemo 本地 OCR 2026',
      language: 'zh-Hans-CN',
      engine: SYSTEM_OCR_ENGINE
    })
    expect(result.lines[0].boundingBox).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('returns OCR_EMPTY_RESULT when the engine finds no text', async () => {
    const service = createService(createRuntime({ text: '' }))
    const result = await service.recognize({ imageDataUrl: PNG_DATA_URL })
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('OCR_EMPTY_RESULT')
    expect(result.text).toBe('')
  })

  it('returns UNSUPPORTED_PLATFORM on non-Windows platforms', async () => {
    const service = createService(null, { platform: 'darwin', arch: 'arm64' })
    const result = await service.recognize({ imageDataUrl: PNG_DATA_URL })
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('UNSUPPORTED_PLATFORM')
    expect(result.engine).toBe(SYSTEM_OCR_ENGINE)
  })

  it('returns OCR_LANGUAGE_UNAVAILABLE when no OCR language pack is installed', async () => {
    const service = createService(createRuntime({ probeError: LANGUAGE_UNAVAILABLE_MESSAGE }))
    const result = await service.recognize({ imageDataUrl: PNG_DATA_URL })
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('OCR_LANGUAGE_UNAVAILABLE')
  })

  it('rejects payloads that are not a supported image container', async () => {
    const runtime = createRuntime()
    const service = createService(runtime)

    const badUrl = await service.recognize({ imageDataUrl: 'nope' })
    expect(badUrl.errorCode).toBe('UNSUPPORTED_IMAGE')

    const garbage = await service.recognize({ imageDataUrl: GARBAGE_DATA_URL })
    expect(garbage.errorCode).toBe('UNSUPPORTED_IMAGE')
    expect(runtime.recognize).not.toHaveBeenCalled()
  })

  it('maps an image preparation failure onto IMAGE_DECODE_FAILED', async () => {
    const runtime = createRuntime()
    const service = createService(runtime, { toPngBytes: async () => null })
    const result = await service.recognize({ imageDataUrl: JPEG_DATA_URL })
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('IMAGE_DECODE_FAILED')
  })

  it('maps a native OCR failure onto a product error code', async () => {
    const runtime = createRuntime({ error: DECODE_FAILED_MESSAGE })
    const service = createService(runtime)
    const result = await service.recognize({ imageDataUrl: PNG_DATA_URL })
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('IMAGE_DECODE_FAILED')
    expect(result.error).not.toContain('0x80070005')
  })

  it('caches by image identity + engine + language + runtime version only', async () => {
    const runtime = createRuntime({ text: 'TraceMemo 本 地' })
    const service = createService(runtime)

    const first = await service.recognize({ imageDataUrl: PNG_DATA_URL })
    const callsAfterFirst = runtime.recognize.mock.calls.length
    const second = await service.recognize({ imageDataUrl: PNG_DATA_URL })

    expect(first.success).toBe(true)
    expect(second.fromCache).toBe(true)
    expect(runtime.recognize.mock.calls.length).toBe(callsAfterFirst)

    // 运行时版本升级 → 缓存 key 变化 → 必须重新识别，不能永远吃旧结果。
    const upgradedRuntime = createRuntime({ text: 'TraceMemo 本 地' })
    service.bind({
      loadRuntime: () => ({ version: '1.3.0', recognize: upgradedRuntime.recognize })
    })
    const afterUpgrade = await service.recognize({ imageDataUrl: PNG_DATA_URL })

    expect(afterUpgrade.success).toBe(true)
    expect(afterUpgrade.fromCache).toBeUndefined()
    expect(upgradedRuntime.recognize).toHaveBeenCalled()
  })

  it('never reuses a remote Vision insight as a local OCR result', async () => {
    getByHash.mockReturnValue({
      imageHash: 'a'.repeat(32),
      description: '远端 Vision 旧结果',
      ocrText: '远端 OCR 文本',
      updatedAt: Date.now()
    })
    const runtime = createRuntime({ text: '本地 文 字' })
    const service = createService(runtime)

    const result = await service.recognize({ imageDataUrl: PNG_DATA_URL })

    expect(result.text).toBe('本地文字')
    expect(getByHash).not.toHaveBeenCalled()
  })
})

describe('ImageInsightService local OCR orchestration', () => {
  beforeEach(() => {
    getByHash.mockReset()
    getByHash.mockReturnValue(null)
    upsert.mockReset()
  })

  it('exposes capability and never falls back to the remote vision provider', async () => {
    const analyzeImage = vi.fn(async () => ({ success: true, data: '{}' }))
    imageInsightService.bind({
      providerService: {
        list: () => ({ providers: [], defaultProviderId: 'vision-provider' }),
        getVisionRuntimeConfig: () => ({
          providerId: 'vision-provider',
          providerName: 'OpenAI',
          model: 'gpt-vision',
          modelName: 'gpt-vision',
          configured: true
        }),
        analyzeImage
      },
      decryptService: {
        findImageFile: () => null,
        decryptImageToBase64: () => null
      }
    })

    const capability = await imageInsightService.getSystemOcrCapability()
    expect(capability.engine).toBe(SYSTEM_OCR_ENGINE)

    const result = await imageInsightService.extractLocalText({ imageDataUrl: PNG_DATA_URL })
    expect(result.engine).toBe(SYSTEM_OCR_ENGINE)
    // 关键约束：本地 OCR 路径绝不调用远端 Vision Provider。
    expect(analyzeImage).not.toHaveBeenCalled()
    // 也不写 Vision 的 insight 缓存。
    expect(upsert).not.toHaveBeenCalled()
  })
})
