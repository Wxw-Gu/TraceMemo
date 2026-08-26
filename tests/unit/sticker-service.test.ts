import crypto from 'crypto'
import fs from 'fs-extra'
import http from 'http'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StickerService } from '../../src/main/sticker-service'
import type { Wcdb4Client } from '../../src/main/wcdb4-client'

const validGif = Buffer.from(
  '47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b',
  'hex'
)

describe('StickerService', () => {
  let homeDir = ''
  const servers: http.Server[] = []

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-service-'))
    vi.stubEnv('HOME', homeDir)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve()))
            )
        )
    )
    fs.removeSync(homeDir)
  })

  const serve = async (body: Buffer): Promise<{ url: string; requests: () => number }> => {
    let requestCount = 0
    const server = http.createServer((_request, response) => {
      requestCount += 1
      response.writeHead(200)
      response.end(body)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind a port')
    return {
      url: `http://127.0.0.1:${address.port}/sticker.gif`,
      requests: () => requestCount
    }
  }

  it('ignores invalid app and WeChat caches and falls back to the CDN', async () => {
    const md5 = crypto.createHash('md5').update(validGif).digest('hex')
    const invalidCache = Buffer.from('encrypted-wechat-emoticon-cache')
    const appCache = path.join(homeDir, 'Documents', 'TraceMemo', 'Emojis', `${md5}.gif`)
    fs.ensureDirSync(path.dirname(appCache))
    fs.writeFileSync(appCache, invalidCache)

    const accountRoot = path.join(homeDir, 'account')
    const wechatCache = path.join(accountRoot, 'cache', '2026-08', 'Emoticon', md5.slice(0, 2), md5)
    fs.ensureDirSync(path.dirname(wechatCache))
    fs.writeFileSync(wechatCache, invalidCache)

    const fixture = await serve(validGif)
    const client = { getAccountRoot: () => accountRoot } as unknown as Wcdb4Client
    const result = await new StickerService(client).resolveSticker(fixture.url, md5)

    expect(result.success, result.error).toBe(true)
    expect(result.data).toBe(`data:image/gif;base64,${validGif.toString('base64')}`)
    expect(fixture.requests()).toBe(1)
    expect(fs.readFileSync(appCache)).toEqual(validGif)
    expect(fs.readFileSync(wechatCache)).toEqual(invalidCache)
  })

  it('rejects an HTTP 200 response whose body is not an image', async () => {
    const md5 = 'a'.repeat(32)
    const fixture = await serve(Buffer.from('expired sticker response'))
    const result = await new StickerService().resolveSticker(fixture.url, md5)

    expect(result).toMatchObject({
      success: false,
      error: '表情包响应不是支持的图片格式'
    })
    expect(fixture.requests()).toBe(1)
    expect(
      fs.existsSync(path.join(homeDir, 'Documents', 'TraceMemo', 'Emojis', `${md5}.gif`))
    ).toBe(false)
  })
})
