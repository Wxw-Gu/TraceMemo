// 【macOS】System OCR native fidelity。
//
// capability-gated 的原生冒烟测试：只有在「macOS + native 运行时可用」时才真正跑。
// macOS 的 Apple Vision 后端没有"语言包缺失"这一失败模式，所以门槛只有运行时本身；
// mock 单元测试仍然是 mandatory（tests/unit/system-ocr-service.test.ts）。
//
// 这里断言的是 **macOS 专有**的性质，与 system-ocr-windows.test.ts 刻意不同：
//   - 引擎标识是 macos-system-ocr；
//   - 不做任何图片归一化：Vision 原生接受 PNG / JPEG，不得转码、不得起 ffmpeg；
//   - capability.language 恒为 null（识别语言由 Vision 决定）；
//   - line.confidence 是 Vision 的真实置信度，不像 Windows 恒为 1.0。
//
// fixture 全部是 synthetic 图片（tests/fixtures/ocr/*），不含任何真实聊天数据。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SYSTEM_OCR_ENGINE_MACOS } from '../../src/shared/system-ocr'

vi.mock('../../src/main/image-decrypt-service', () => ({
  resolveFfmpegExecutable: (): string => 'ffmpeg'
}))

import { SystemOcrService, systemOcrService } from '../../src/main/services/system-ocr-service'

const fixtureDirectory = join(__dirname, '..', 'fixtures', 'ocr')

const toDataUrl = (fileName: string, mimeType: string): string =>
  `data:${mimeType};base64,${readFileSync(join(fixtureDirectory, fileName)).toString('base64')}`

/** 只比较"主要 token"，避免识别微差造成脆弱测试。 */
const expectContainsTokens = (text: string, tokens: string[]): void => {
  const normalized = text.replace(/[\s\u3000]+/g, '').toLowerCase()
  for (const token of tokens) {
    expect(normalized).toContain(token.replace(/[\s\u3000]+/g, '').toLowerCase())
  }
}

const capability = await systemOcrService.getCapability()
const onMac = process.platform === 'darwin'
const platformGate = onMac ? it : it.skip
const nativeGate = onMac && capability.available ? it : it.skip

/**
 * 走「真实 process.platform/arch + 真实 native binding + 默认归一化路径」的实例，
 * 只把 ffmpeg 解析器换成 spy —— 用来证明 macOS 路径根本没有碰归一化。
 */
const ffmpegResolver = vi.fn(() => 'ffmpeg')
const nativeService = new SystemOcrService({ resolveFfmpegExecutable: ffmpegResolver })

describe('macOS System OCR native fidelity', () => {
  platformGate('reports a usable capability backed by Apple Vision', () => {
    expect(capability.engine).toBe(SYSTEM_OCR_ENGINE_MACOS)
    expect(capability.platform).toBe('darwin')
    expect(capability.runtimeVersion).not.toBeNull()
    // Vision 自行决定识别语言，不声称任何语言包。
    expect(capability.language).toBeNull()
    if (!capability.available) {
      console.warn(`[integration] macOS System OCR smoke skipped: ${capability.message}`)
    }
  })

  nativeGate('recognizes simplified Chinese text', async () => {
    const result = await nativeService.recognize({
      imageDataUrl: toDataUrl('system-ocr-zh.png', 'image/png')
    })
    expect(result.success).toBe(true)
    expectContainsTokens(result.text, ['TraceMemo', '本地', '文字', '识别'])
    expect(result.language).toBeNull()
    expect(result.durationMs).toBeGreaterThan(0)
  })

  nativeGate('recognizes English text', async () => {
    const result = await nativeService.recognize({
      imageDataUrl: toDataUrl('system-ocr-en.png', 'image/png')
    })
    expect(result.success).toBe(true)
    expectContainsTokens(result.text, ['TraceMemo', 'System', 'OCR'])
  })

  nativeGate('recognizes mixed Chinese/English text', async () => {
    const result = await nativeService.recognize({
      imageDataUrl: toDataUrl('system-ocr-mixed.png', 'image/png')
    })
    expect(result.success).toBe(true)
    expectContainsTokens(result.text, ['TraceMemo', '本地', 'OCR', '2026'])
  })

  /**
   * Vision 原生接受 JPEG —— 这条用例同时是「macOS 不做归一化」的回归保护：
   * 一旦有人把 Windows 的 PNG-only 假设搬过来，ffmpeg 解析器就会被调用。
   */
  nativeGate('accepts JPEG directly without any image normalization', async () => {
    ffmpegResolver.mockClear()
    const result = await nativeService.recognize({
      imageDataUrl: toDataUrl('system-ocr-mixed.jpg', 'image/jpeg')
    })
    expect(result.success).toBe(true)
    expectContainsTokens(result.text, ['TraceMemo', 'OCR', '2026'])
    expect(ffmpegResolver).not.toHaveBeenCalled()
  })

  nativeGate('reports real Vision confidence and top-left-origin boxes', async () => {
    const result = await nativeService.recognize({
      imageDataUrl: toDataUrl('system-ocr-mixed.png', 'image/png')
    })
    expect(result.success).toBe(true)
    expect(result.lines.length).toBeGreaterThan(0)
    for (const line of result.lines) {
      // Windows 恒为 1.0；macOS 必须给出真实置信度。
      expect(line.confidence).toBeGreaterThanOrEqual(0)
      expect(line.confidence).toBeLessThanOrEqual(1)
      const { x, y, width, height } = line.boundingBox
      for (const value of [x, y, width, height]) {
        expect(Number.isFinite(value)).toBe(true)
      }
      expect(x).toBeGreaterThanOrEqual(0)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(x + width).toBeLessThanOrEqual(1.0001)
      expect(y + height).toBeLessThanOrEqual(1.0001)
    }
  })

  nativeGate('caches an identical repeat request', async () => {
    const request = { imageDataUrl: toDataUrl('system-ocr-en.png', 'image/png') }
    const first = await systemOcrService.recognize(request)
    const second = await systemOcrService.recognize(request)
    expect(first.success).toBe(true)
    expect(second.fromCache).toBe(true)
  })
})
