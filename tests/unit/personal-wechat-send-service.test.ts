import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtimeMocks = vi.hoisted(() => ({
  ensureStarted: vi.fn(),
  buildSenderStatus: vi.fn(),
  getSendMechanism: vi.fn(),
  getPort: vi.fn(() => 4290)
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/fixture/app',
    getPath: () => '/tmp/tracememo-test-user-data',
    isPackaged: false
  }
}))
vi.mock('../../src/main/services/mac-wechat-runtime-manager', () => ({
  macWechatRuntimeManager: runtimeMocks
}))
vi.mock('../../src/main/voice-pipeline/audio-decoder', () => ({
  SilkAudioDecoder: class {
    async decode() {
      return { pcm: Buffer.alloc(48_000), channels: 1, sampleRate: 24_000 }
    }
  },
  SilkAudioEncoder: class {}
}))
vi.mock('../../src/main/services/local-account-identity', () => ({
  readLocalAccountIdentity: () => ({ wxid: 'wxid_fixture_self' }),
  accountDirectoryBelongsToIdentity: (directory: string, wxid: string) => {
    const normalizedDirectory = directory.toLowerCase()
    const normalizedWxid = wxid.toLowerCase()
    if (normalizedDirectory === normalizedWxid) return true
    if (!normalizedDirectory.startsWith(`${normalizedWxid}_`)) return false
    return /^[a-z0-9]{4}$/.test(normalizedDirectory.slice(normalizedWxid.length + 1))
  }
}))

import {
  buildPersonalWechatVoiceDiagnostic,
  buildWindowsWechatRequest,
  findWechatImagePath,
  normalizeWindowsWechatPort,
  parseWindowsLoginStatus,
  parseWindowsHookResponse,
  prepareWindowsImageFile,
  WindowsHookHttpError
} from '../../src/main/services/personal-wechat-send-service'
import { PersonalWechatSendService } from '../../src/main/services/personal-wechat-send-service'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-personal-runtime-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  vi.unstubAllGlobals()
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

beforeEach(() => {
  runtimeMocks.ensureStarted.mockReset().mockResolvedValue(undefined)
  runtimeMocks.buildSenderStatus
    .mockReset()
    .mockResolvedValue({ canSendText: true, canSendImage: true, canSendVoice: true })
  runtimeMocks.getSendMechanism.mockReset().mockResolvedValue('legacy-req2buf')
  runtimeMocks.getPort.mockReset().mockReturnValue(4290)
})

describe('macOS message-source send routing', () => {
  it('sends a message-source image through one local-path request without CDN upload', async () => {
    const root = temporaryDirectory()
    const filePath = join(root, 'fixture-image.png')
    writeFileSync(filePath, 'fixture-image')
    const imageTemp = join(root, 'wxid_fixture_self', 'temp', 'ImageTemp', '2026-11')
    mkdirSync(imageTemp, { recursive: true })
    runtimeMocks.getSendMechanism.mockResolvedValue('tm-message-source-send')
    let stagedPath = ''
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, ok: true, message: 'sent' })
    })
    fetchMock.mockImplementation(async (_url, init) => {
      stagedPath = String((JSON.parse(String(init?.body)) as { path: string }).path)
      expect(stagedPath).toContain(imageTemp)
      expect(readFileSync(stagedPath, 'utf8')).toBe('fixture-image')
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, ok: true, message: 'sent' })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await new PersonalWechatSendService(root).send({
      type: 'image', to: 'fixture-contact', isGroup: false, filePath
    })

    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toContain('/sendMsg')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      type: 'image', to: 'fixture-contact', path: stagedPath
    })
    expect(stagedPath).not.toBe(filePath)
    expect(existsSync(stagedPath)).toBe(false)
  })

  it('uses the legacy image path only when source preparation is definitively rejected', async () => {
    const root = temporaryDirectory()
    const filePath = join(root, 'fixture-image.png')
    writeFileSync(filePath, 'fixture-image')
    const imageTemp = join(root, 'wxid_fixture_self', 'temp', 'ImageTemp', '2026-11')
    mkdirSync(imageTemp, { recursive: true })
    runtimeMocks.getSendMechanism.mockResolvedValue('tm-message-source-send')
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => String(url).endsWith('/sendMsg')
        ? { code: 6, ok: false, message: 'IMAGE_PREPARATION_FAILED:0' }
        : { code: 0, ok: true, message: 'sent' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await new PersonalWechatSendService(root).send({
      type: 'image', to: 'fixture-contact', isGroup: false, filePath
    })

    expect(result.success).toBe(true)
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:4290/sendMsg',
      'http://127.0.0.1:4290/uploadImage',
      'http://127.0.0.1:4290/sendImage'
    ])
    const uploadBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as Record<
      string,
      unknown
    >
    expect(String(uploadBody.filePath)).toContain(imageTemp)
  })

  it('does not retry image submission after a timeout or an ambiguous failure', async () => {
    const root = temporaryDirectory()
    const filePath = join(root, 'fixture-image.png')
    writeFileSync(filePath, 'fixture-image')
    const imageTemp = join(root, 'wxid_fixture_self', 'temp', 'ImageTemp', '2026-11')
    mkdirSync(imageTemp, { recursive: true })
    runtimeMocks.getSendMechanism.mockResolvedValue('tm-message-source-send')
    const fetchMock = vi.fn().mockRejectedValue(new Error('request timed out'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await new PersonalWechatSendService(root).send({
      type: 'image', to: 'fixture-contact', isGroup: false, filePath
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('图片发送失败')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toContain('/sendMsg')
  })

  it('keeps other image mechanisms on the upload-then-send endpoints', async () => {
    const root = temporaryDirectory()
    const filePath = join(root, 'fixture-image.png')
    writeFileSync(filePath, 'fixture-image')
    const imageTemp = join(root, 'wxid_fixture_self', 'temp', 'ImageTemp', '2026-11')
    mkdirSync(imageTemp, { recursive: true })
    runtimeMocks.getSendMechanism.mockResolvedValue('native-msg-object')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, ok: true, message: 'sent' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await new PersonalWechatSendService(root).send({
      type: 'image', to: 'fixture-contact', isGroup: false, filePath
    })

    expect(result.success).toBe(true)
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:4290/uploadImage',
      'http://127.0.0.1:4290/sendImage'
    ])
    const uploadBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<
      string,
      unknown
    >
    expect(String(uploadBody.filePath)).toContain(imageTemp)
  })

  it('sends message-source text and its mention map through the unified endpoint', async () => {
    runtimeMocks.getSendMechanism.mockResolvedValue('tm-message-source-send')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, ok: true, message: 'sent' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await new PersonalWechatSendService().send({
      type: 'text',
      to: 'fixture-room@chatroom',
      isGroup: true,
      text: '早上好',
      at: { wxid_fixture_member: '测试成员' }
    })

    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toContain('/sendMsg')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      type: 'text',
      to: 'fixture-room@chatroom',
      text: '早上好',
      is_group: true,
      at: { wxid_fixture_member: '测试成员' }
    })
  })

  it('sends a message-source SILK voice through the unified request', async () => {
    const root = temporaryDirectory()
    const filePath = join(root, 'fixture-voice.silk')
    writeFileSync(filePath, Buffer.concat([Buffer.from('\x02#!SILK_V3'), Buffer.from([1, 2, 3])]))
    runtimeMocks.getSendMechanism.mockResolvedValue('tm-message-source-send')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, ok: true, message: 'sent' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await new PersonalWechatSendService().send({
      type: 'voice', to: 'fixture-contact', isGroup: false, filePath, durationMs: 1200
    })

    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toContain('/sendMsg')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      type: 'voice', to: 'fixture-contact', voice_hex: expect.any(String), duration_ms: 1200
    })
  })

  it('rejects a sub-second message-source voice instead of sending an invalid duration', async () => {
    const root = temporaryDirectory()
    const filePath = join(root, 'fixture-voice.silk')
    writeFileSync(filePath, Buffer.concat([Buffer.from('\x02#!SILK_V3'), Buffer.from([1, 2, 3])]))
    runtimeMocks.getSendMechanism.mockResolvedValue('tm-message-source-send')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await new PersonalWechatSendService().send({
      type: 'voice', to: 'fixture-contact', isGroup: false, filePath, durationMs: 500
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('至少 1 秒')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps other text mechanisms on the existing endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, ok: true, message: 'sent' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await new PersonalWechatSendService().send({
      type: 'text', to: 'fixture-contact', isGroup: false, text: 'hello'
    })

    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toContain('/sendText')
  })

  it('keeps other voice mechanisms on the upload-then-send endpoints', async () => {
    const root = temporaryDirectory()
    const filePath = join(root, 'fixture-voice.silk')
    writeFileSync(filePath, Buffer.concat([Buffer.from('\x02#!SILK_V3'), Buffer.from([1, 2, 3])]))
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, ok: true, message: 'sent' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await new PersonalWechatSendService().send({
      type: 'voice', to: 'fixture-contact', isGroup: false, filePath, durationMs: 1200
    })

    expect(result.success).toBe(true)
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:4290/uploadVoice',
      'http://127.0.0.1:4290/sendVoice'
    ])
  })
})

describe('personal WeChat voice diagnostics', () => {
  it('keeps voice diagnostics to the safe metadata allowlist', () => {
    const diagnostic = buildPersonalWechatVoiceDiagnostic('request-1', 'completed', {
      input_bytes: 10,
      upload_result: '0',
      error: undefined,
      aesKey: 'secret',
      cdnKey: 'secret',
      token: 'secret',
      runtime_log: 'private'
    })
    expect(diagnostic).toMatchObject({ request_id: 'request-1', upload_result: '0' })
    expect(diagnostic).not.toHaveProperty('aesKey')
    expect(diagnostic).not.toHaveProperty('cdnKey')
    expect(diagnostic).not.toHaveProperty('token')
    expect(diagnostic).not.toHaveProperty('runtime_log')
  })

  it('redacts secrets embedded in diagnostic errors', () => {
    const diagnostic = buildPersonalWechatVoiceDiagnostic('request-2', 'failed', {
      error:
        'upload failed aesKey=secret-value Bearer bearer-secret token:token-value {"cdnKey":"json-secret"}'
    })
    expect(diagnostic.error).toContain('aesKey=[redacted]')
    expect(diagnostic.error).toContain('Bearer [redacted]')
    expect(diagnostic.error).toContain('token:[redacted]')
    expect(diagnostic.error).not.toContain('secret-value')
    expect(diagnostic.error).not.toContain('bearer-secret')
    expect(diagnostic.error).not.toContain('token-value')
    expect(diagnostic.error).not.toContain('json-secret')
  })
})

describe('Windows request', () => {
  it('accepts only a valid configured local port', () => {
    expect(normalizeWindowsWechatPort('')).toBeNull()
    expect(normalizeWindowsWechatPort(' 4567 ')).toBe('4567')
    expect(normalizeWindowsWechatPort('0')).toBeNull()
    expect(normalizeWindowsWechatPort('65536')).toBeNull()
    expect(normalizeWindowsWechatPort('port')).toBeNull()
  })

  it('requires ret=0 for message responses but accepts the status shape', () => {
    expect(parseWindowsHookResponse('{"ret":0,"retmsg":"success"}', true)).toEqual({
      ret: 0,
      retmsg: 'success'
    })
    expect(parseWindowsHookResponse('{"IsLogin":0,"hWeixin":123}', false)).toEqual({
      IsLogin: 0,
      hWeixin: 123
    })
    expect(() => parseWindowsHookResponse('{"ret":1,"retmsg":"fail"}', true)).toThrow('fail')
    expect(() => parseWindowsHookResponse('{"retmsg":"success"}', true)).toThrow('success')
    expect(() => parseWindowsHookResponse('{}', true)).toThrow('ret=undefined')
    expect(() => parseWindowsHookResponse('', true)).toThrow('空响应')
  })

  it('preserves the Windows Hook HTTP status and response body', () => {
    const error = new WindowsHookHttpError(500, '{"ret":-9,"retmsg":"image failed"}')
    expect(error.message).toBe('HTTP 500: {"ret":-9,"retmsg":"image failed"}')
    expect(error.status).toBe(500)
    expect(error.responseBody).toContain('image failed')
    expect(new WindowsHookHttpError(500, '').message).toBe('HTTP 500')
  })

  it('allows Windows sending only for a strict logged-in status', () => {
    expect(parseWindowsLoginStatus({ status: true })).toBe(true)
    expect(parseWindowsLoginStatus({ status: false })).toBe(false)
    expect(parseWindowsLoginStatus({ status: 1 })).toBe(false)
    expect(parseWindowsLoginStatus({ status: 'true' })).toBe(false)
    expect(parseWindowsLoginStatus({ IsLogin: 1, hWeixin: 123 })).toBe(false)
  })

  it('builds the unified text request', () => {
    expect(
      buildWindowsWechatRequest({
        to: ' wxid_fixture ',
        type: 'text',
        text: ' 测试发送 ',
        isGroup: false
      })
    ).toEqual({
      endpoint: '/SendMsg',
      body: { toWxid: 'wxid_fixture', type: 'text', msg: '测试发送' }
    })
  })

  it('builds the unified image request with a local path', () => {
    expect(
      buildWindowsWechatRequest({
        to: 'room@chatroom',
        type: 'image',
        filePath: 'C:\\fixture\\image.png',
        isGroup: true
      })
    ).toEqual({
      endpoint: '/SendMsg',
      body: { toWxid: 'room@chatroom', type: 'image', msg: 'C:\\fixture\\image.png' }
    })
  })

  it('builds the unified voice request with sender wxid and duration', () => {
    expect(
      buildWindowsWechatRequest(
        {
          to: 'wxid_fixture',
          type: 'voice',
          filePath: '/source/input.wav',
          fromId: ' wxid_self ',
          isGroup: false
        },
        { filePath: 'C:\\Temp\\prepared.silk', durationMs: 1234 }
      )
    ).toEqual({
      endpoint: '/SendMsg',
      body: {
        toWxid: 'wxid_fixture',
        type: 'voice',
        msg: 'C:\\Temp\\prepared.silk',
        fromWxid: 'wxid_self',
        duration: 1234
      }
    })
  })

  it('copies adjacent non-ASCII image paths to ASCII temporary files', () => {
    const root = temporaryDirectory()
    const content = Buffer.from('fixture-image')
    for (const fileName of ['测试图片_2026-08-31_经典.png', '测试图片_2026-08-31_经典版.png']) {
      const source = join(root, fileName)
      writeFileSync(source, content)

      const prepared = prepareWindowsImageFile(source)

      expect(prepared.temporary).toBe(true)
      expect(prepared.filePath).not.toContain(fileName)
      expect(prepared.filePath).toMatch(/^[\x20-\x7e]+$/)
      expect(readFileSync(prepared.filePath)).toEqual(content)
      unlinkSync(prepared.filePath)
    }
  })

  it('keeps an ASCII image path unchanged', () => {
    const root = temporaryDirectory()
    const source = join(root, 'report.png')
    writeFileSync(source, 'fixture-image')

    expect(prepareWindowsImageFile(source)).toEqual({ filePath: source, temporary: false })
  })
})

describe('personal WeChat runtime discovery', () => {
  it('uses the newest current-month WeChat image directory', () => {
    const root = temporaryDirectory()
    const oldPath = join(root, 'account', 'temp', 'old', '2026-08', 'Img')
    const latestPath = join(root, 'account', 'temp', 'latest', '2026-08', 'Img')
    mkdirSync(oldPath, { recursive: true })
    mkdirSync(latestPath, { recursive: true })
    utimesSync(oldPath, new Date('2026-08-01'), new Date('2026-08-01'))
    utimesSync(latestPath, new Date('2026-08-05'), new Date('2026-08-05'))

    expect(findWechatImagePath(root, new Date('2026-08-06'))).toBe(`${latestPath}${sep}`)
  })

  it('supports the current ImageTemp layout after a WeChat relogin', () => {
    const root = temporaryDirectory()
    const imageTempPath = join(root, 'account', 'temp', 'ImageTemp', '2026-08')
    mkdirSync(imageTempPath, { recursive: true })
    expect(findWechatImagePath(root, new Date('2026-08-06'))).toBe(`${imageTempPath}${sep}`)
  })

  it('derives the current ImageTemp directory before the month folder exists', () => {
    const root = temporaryDirectory()
    const tempRoot = join(root, 'account', 'temp')
    mkdirSync(tempRoot, { recursive: true })

    expect(findWechatImagePath(root, new Date('2026-08-06'))).toBe(
      `${join(tempRoot, 'ImageTemp', '2026-08')}${sep}`
    )
  })

  it('does not choose a newer image directory belonging to another WeChat account', () => {
    const root = temporaryDirectory()
    const ownPath = join(root, 'wxid_fixture_self', 'temp', 'ImageTemp', '2026-08')
    const otherPath = join(root, 'wxid_other_account', 'temp', 'ImageTemp', '2026-08')
    mkdirSync(ownPath, { recursive: true })
    mkdirSync(otherPath, { recursive: true })
    utimesSync(ownPath, new Date('2026-08-01'), new Date('2026-08-01'))
    utimesSync(otherPath, new Date('2026-08-05'), new Date('2026-08-05'))

    expect(findWechatImagePath(root, new Date('2026-08-06'), 'wxid_fixture_self')).toBe(
      `${ownPath}${sep}`
    )
    expect(findWechatImagePath(root, new Date('2026-08-06'), 'wxid_missing_account')).toBeUndefined()
  })
})
