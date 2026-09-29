import {
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
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/fixture/app',
    getPath: () => '/tmp/tracememo-test-user-data',
    isPackaged: false
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

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-personal-runtime-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
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
})
