// Windows System OCR native fidelity。
//
// 这是 capability-gated 的原生冒烟测试：
//   - 只有在「当前平台支持 + native 运行时可用 + 有可用 OCR 语言包」时才真正跑；
//   - CI 环境无法保证 Windows OCR 语言包，所以中文识别不作为所有 CI 的硬门槛
//     （mock 单元测试才是 mandatory，见 tests/unit/system-ocr-service.test.ts）；
//   - 在 Windows 真机上必须实际通过。
//
// fixture 全部是 synthetic 图片（tests/fixtures/ocr/*），不含任何真实聊天数据。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SYSTEM_OCR_ENGINE } from '../../src/shared/system-ocr'

vi.mock('../../src/main/image-decrypt-service', () => ({
  resolveFfmpegExecutable: (): string => 'ffmpeg'
}))

import { systemOcrService } from '../../src/main/services/system-ocr-service'

const fixtureDirectory = join(__dirname, '..', 'fixtures', 'ocr')

const toDataUrl = (fileName: string, mimeType: string): string =>
  `data:${mimeType};base64,${readFileSync(join(fixtureDirectory, fileName)).toString('base64')}`

/** 只比较"主要 token"，避免系统字体 / 识别微差造成脆弱测试。 */
const expectContainsTokens = (text: string, tokens: string[]): void => {
  const normalized = text.replace(/[\s\u3000]+/g, '').toLowerCase()
  for (const token of tokens) {
    expect(normalized).toContain(token.replace(/[\s\u3000]+/g, '').toLowerCase())
  }
}

const capability = await systemOcrService.getCapability()
const nativeGate = capability.available ? it : it.skip

describe('Windows System OCR native fidelity', () => {
  it('reports a usable capability on this machine', () => {
    expect(capability.engine).toBe(SYSTEM_OCR_ENGINE)
    if (!capability.available) {
      console.warn(`[integration] System OCR native smoke skipped: ${capability.message}`)
    }
  })

  nativeGate('recognizes simplified Chinese text', async () => {
    const result = await systemOcrService.recognize({
      imageDataUrl: toDataUrl('system-ocr-zh.png', 'image/png')
    })
    expect(result.success).toBe(true)
    expectContainsTokens(result.text, ['TraceMemo', '本地', '文字', '识别'])
    // 语言要么是探测到的语言包，要么是"跟随系统用户语言"（null）。
    if (capability.language) {
      expect(result.language).toBe(capability.language)
    } else {
      expect(result.language).toBeNull()
    }
    expect(result.durationMs).toBeGreaterThan(0)
  })

  nativeGate('recognizes English text', async () => {
    const result = await systemOcrService.recognize({
      imageDataUrl: toDataUrl('system-ocr-en.png', 'image/png')
    })
    expect(result.success).toBe(true)
    expectContainsTokens(result.text, ['TraceMemo', 'System', 'OCR'])
  })

  nativeGate('recognizes mixed Chinese/English text', async () => {
    const result = await systemOcrService.recognize({
      imageDataUrl: toDataUrl('system-ocr-mixed.png', 'image/png')
    })
    expect(result.success).toBe(true)
    expectContainsTokens(result.text, ['TraceMemo', '本地', 'OCR', '2026'])
  })

  /**
   * 引擎的 Buffer 输入只接受 PNG，所以 JPEG 必须走本服务的归一化路径。
   * 这条用例就是那个约束的回归保护。
   */
  nativeGate('normalizes a JPEG source before OCR', async () => {
    const result = await systemOcrService.recognize({
      imageDataUrl: toDataUrl('system-ocr-mixed.jpg', 'image/jpeg')
    })
    expect(result.success).toBe(true)
    expectContainsTokens(result.text, ['TraceMemo', 'OCR', '2026'])
  })

  nativeGate('caches an identical repeat request', async () => {
    const request = { imageDataUrl: toDataUrl('system-ocr-mixed.png', 'image/png') }
    const first = await systemOcrService.recognize(request)
    const second = await systemOcrService.recognize(request)
    expect(first.success).toBe(true)
    expect(second.fromCache).toBe(true)
  })
})
