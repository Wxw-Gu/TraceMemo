import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import {
  detectImageMime,
  embedAvatar,
  mapWithConcurrency
} from '../../src/main/group-report-service'

/**
 * 「日报有的头像没生成出来」的回归。
 *
 * 实测根因（同一天三次生成同一份报告）：真实头像失败率 0% / 0% / 32%，
 * 且失败的那 4 个人稍后重新请求全部 200 + 合法 JPEG —— 说明是**瞬时**网络失败。
 * 旧实现对每个头像只发一次请求、失败即永久退回首字占位，于是少数人整份报告都是占位图。
 *
 * 这里锁死三件事：
 * 1. 只信真实图片字节（200 + HTML 反盗链页不得内联成"解码失败"的空白头像）；
 * 2. 瞬时失败要重试一次；
 * 3. 成功的头像要进缓存（老报告重渲染 / 连续生成不再重复下载）。
 */

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)])
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 3)
])
const HTML = Buffer.from('<!DOCTYPE html><html><body>anti hotlink</body></html>')

const imageResponse = (bytes: Buffer, contentType = 'image/jpeg'): Response =>
  new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': contentType }
  })

describe('detectImageMime — 只认真实图片字节', () => {
  it('识别常见图片格式', () => {
    expect(detectImageMime(JPEG)).toBe('image/jpeg')
    expect(detectImageMime(PNG)).toBe('image/png')
    expect(detectImageMime(Buffer.from('GIF89a----'))).toBe('image/gif')
    expect(detectImageMime(Buffer.from([0x42, 0x4d, 0, 0]))).toBe('image/bmp')
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WEBP'),
      Buffer.alloc(8)
    ])
    expect(detectImageMime(webp)).toBe('image/webp')
    expect(detectImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
      'image/svg+xml'
    )
  })

  it('HTML 反盗链页 / 空响应 一律不认（否则会内联成空白头像）', () => {
    expect(detectImageMime(HTML)).toBeUndefined()
    expect(detectImageMime(Buffer.alloc(0))).toBeUndefined()
    expect(detectImageMime(Buffer.from('{"error":"forbidden"}'))).toBeUndefined()
    // XML 前缀但正文不是 svg（HTML 页面带 xml 声明）也不许蒙混过关
    expect(
      detectImageMime(Buffer.from('<?xml version="1.0"?><html><body>x</body></html>'))
    ).toBeUndefined()
  })
})

describe('mapWithConcurrency — 有界并发且保序', () => {
  it('同时在飞的任务数不超过上限，结果顺序与输入一致', async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 20 }, (_, index) => index)
    const results = await mapWithConcurrency(items, 6, async (item) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return item * 2
    })
    expect(peak).toBeLessThanOrEqual(6)
    expect(peak).toBeGreaterThan(1)
    expect(results).toEqual(items.map((item) => item * 2))
  })

  it('空输入与单元素输入都安全', async () => {
    expect(await mapWithConcurrency([], 4, async (item: number) => item)).toEqual([])
    expect(await mapWithConcurrency([1], 4, async (item) => item + 1)).toEqual([2])
  })
})

describe('embedAvatar — 不因单次瞬时失败永久退化', () => {
  it('200 + 非图片正文（反盗链页）→ 首字占位，绝不内联成解码失败的空白头像', async () => {
    const fetchMock = vi.fn(async () => imageResponse(HTML, 'text/html'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await embedAvatar('https://wx.qlogo.cn/mmhead/ver_1/antihotlink', '张三')

    expect(result.fallback).toBe(true)
    expect(result.source.startsWith('data:image/svg+xml;base64,')).toBe(true)
    // 两次尝试（首次 + 重试）都拿到 HTML → 都判失败
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
  })

  it('首次失败、重试成功 → 拿到真实头像（不是首字占位）', async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(imageResponse(JPEG))
    vi.stubGlobal('fetch', fetchMock)

    const result = await embedAvatar('https://wx.qlogo.cn/mmhead/ver_1/retry-once', '李四')

    expect(result.fallback).toBe(false)
    expect(result.source.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(Buffer.from(result.source.split(',')[1], 'base64').subarray(0, 3)).toEqual(
      Buffer.from([0xff, 0xd8, 0xff])
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
  })

  it('两次都失败 → 首字占位，且不再继续请求', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await embedAvatar('https://wx.qlogo.cn/mmhead/ver_1/always-down', '王五')

    expect(result.fallback).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
  })

  it('同一 URL 成功后进缓存：重渲染 / 连续生成不重复下载', async () => {
    const fetchMock = vi.fn(async () => imageResponse(PNG, 'image/png'))
    vi.stubGlobal('fetch', fetchMock)

    const first = await embedAvatar('https://wx.qlogo.cn/mmhead/ver_1/cached', '赵六')
    const second = await embedAvatar('https://wx.qlogo.cn/mmhead/ver_1/cached', '赵六')

    expect(first.fallback).toBe(false)
    expect(second).toEqual(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('没有来源时直接首字占位，不发请求', async () => {
    const fetchMock = vi.fn(async () => imageResponse(JPEG))
    vi.stubGlobal('fetch', fetchMock)

    const result = await embedAvatar(undefined, '无名')

    expect(result.fallback).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('已是 data URL 时直接复用，不发请求', async () => {
    const fetchMock = vi.fn(async () => imageResponse(JPEG))
    vi.stubGlobal('fetch', fetchMock)

    const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`
    const result = await embedAvatar(dataUrl, '已内联')

    expect(result).toEqual({ source: dataUrl, fallback: false })
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
