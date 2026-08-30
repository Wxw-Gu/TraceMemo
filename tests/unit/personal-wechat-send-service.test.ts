import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
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
  buildPersonalWechatOneBotRequest,
  findWechatImagePath,
  findPersonalWechatRuntime,
  normalizeWindowsWechatPort,
  parseWindowsLoginStatus,
  parseWindowsHookResponse,
  parsePersonalWechatHookLog
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

describe('personal WeChat OneBot request', () => {
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

  it('builds a private text message request', () => {
    expect(
      buildPersonalWechatOneBotRequest({
        to: ' wxid_fixture ',
        type: 'text',
        text: ' 测试发送 ',
        isGroup: false
      })
    ).toEqual({
      endpoint: '/send_private_msg',
      body: {
        user_id: 'wxid_fixture',
        message: [{ type: 'text', data: { text: '测试发送' } }]
      }
    })
  })

  it('uses the group endpoint for chatroom targets', () => {
    expect(
      buildPersonalWechatOneBotRequest({
        to: 'fixture-room@chatroom',
        type: 'text',
        text: '群聊测试',
        isGroup: false
      })
    ).toEqual({
      endpoint: '/send_group_msg',
      body: {
        group_id: 'fixture-room@chatroom',
        message: [{ type: 'text', data: { text: '群聊测试' } }]
      }
    })
  })

  it('builds a base64 image request without mixing text content', () => {
    expect(
      buildPersonalWechatOneBotRequest(
        { to: 'fixture-room@chatroom', type: 'image', filePath: '/tmp/test.png', isGroup: false },
        'aGVsbG8='
      )
    ).toEqual({
      endpoint: '/send_group_msg',
      body: {
        group_id: 'fixture-room@chatroom',
        message: [{ type: 'image', data: { file: 'base64://aGVsbG8=' } }]
      }
    })
  })

  it('builds a base64 voice record request', () => {
    expect(
      buildPersonalWechatOneBotRequest(
        { to: 'filehelper', type: 'voice', filePath: '/tmp/test.silk', isGroup: false },
        'dm9pY2U='
      )
    ).toEqual({
      endpoint: '/send_private_msg',
      body: {
        user_id: 'filehelper',
        message: [{ type: 'record', data: { file: 'base64://dm9pY2U=' } }]
      }
    })
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

  it('finds the nested release archive layout', () => {
    const root = temporaryDirectory()
    mkdirSync(join(root, 'onebot'), { recursive: true })
    mkdirSync(join(root, 'wechat_version'), { recursive: true })
    writeFileSync(join(root, 'onebot', 'onebot'), 'fixture')
    writeFileSync(join(root, 'onebot', 'script.js'), 'fixture')

    expect(findPersonalWechatRuntime([root])).toEqual({
      root,
      executable: join(root, 'onebot', 'onebot'),
      workingDirectory: join(root, 'onebot'),
      configDirectory: join(root, 'wechat_version'),
      logPath: join(root, 'onebot', 'log', 'macos.log')
    })
  })

  it('finds a flat runtime layout and rejects incomplete directories', () => {
    const incomplete = temporaryDirectory()
    writeFileSync(join(incomplete, 'onebot'), 'fixture')

    const root = temporaryDirectory()
    mkdirSync(join(root, 'wechat_version'), { recursive: true })
    writeFileSync(join(root, 'onebot'), 'fixture')
    writeFileSync(join(root, 'script.js'), 'fixture')

    expect(findPersonalWechatRuntime([incomplete, root])).toEqual({
      root,
      executable: join(root, 'onebot'),
      workingDirectory: root,
      configDirectory: join(root, 'wechat_version'),
      logPath: join(root, 'log', 'macos.log')
    })
  })
})

describe('personal WeChat hook diagnostics', () => {
  it('does not treat a listening service as hook-ready after req2buf scan failure', () => {
    expect(
      parsePersonalWechatHookLog(
        [
          JSON.stringify({ time: '2026-08-06T14:08:10+08:00', payload: '[+] HTTP 服务启动在' }),
          JSON.stringify({
            time: '2026-08-06T14:08:11+08:00',
            err: "Error: [-] Cannot find 'req2buf' keyword in a range > 100MB"
          })
        ].join('\n')
      )
    ).toMatchObject({ readiness: 'failed' })
  })

  it('requires StartTask capture before reporting ready', () => {
    expect(
      parsePersonalWechatHookLog(
        JSON.stringify({ payload: '[+] Dynamic Text Message Setup Complete.' })
      )
    ).toMatchObject({ readiness: 'initializing', textHookInstalled: true })
    expect(
      parsePersonalWechatHookLog(
        JSON.stringify({ payload: '[+] 捕获到 StartTask 调用，X0：0x1, Payload: 0x2' })
      )
    ).toMatchObject({ readiness: 'ready', textHookReady: true })
  })

  it('resets stale hook results when a new WeChat process attach starts', () => {
    expect(
      parsePersonalWechatHookLog(
        [
          JSON.stringify({ payload: '[+] 捕获到 StartTask 调用，X0：0x1, Payload: 0x2' }),
          JSON.stringify({ message: '使用指定的微信进程 PID', PID: 123 }),
          JSON.stringify({ payload: '[+] Dynamic Text Message Setup Complete.' })
        ].join('\n')
      )
    ).toMatchObject({
      readiness: 'initializing',
      boundWechatPid: 123,
      textHookInstalled: true,
      textHookReady: false
    })
  })

  it('tracks base, image Hook and message listener diagnostics', () => {
    expect(
      parsePersonalWechatHookLog(
        [
          JSON.stringify({ message: '使用指定的微信进程 PID', PID: 4668 }),
          JSON.stringify({ message: '成功 Attach 微信进程', PID: 4668 }),
          JSON.stringify({ payload: '[+] Base address from range: 0x114ef8000' }),
          JSON.stringify({ payload: '[+] Dynamic Text Message Setup Complete.' }),
          JSON.stringify({ payload: '[+] 图片上传 Hook Setup Complete.' }),
          JSON.stringify({ payload: '[+] 捕获到图片上传上下文，uploadGlobalX0：0x1' }),
          JSON.stringify({ message: '发送数据' })
        ].join('\n')
      )
    ).toMatchObject({
      attached: true,
      baseAddress: '0x114ef8000',
      textHookInstalled: true,
      imageHookInstalled: true,
      imageHookReady: true,
      messageListenerReady: true,
      boundWechatPid: 4668
    })
  })

  it('recognizes a successful legacy image send without the new Hook marker', () => {
    expect(
      parsePersonalWechatHookLog(
        JSON.stringify({ type: 'send_image', result: '1', message: '发送图片任务执行结果' })
      )
    ).toMatchObject({ imageHookInstalled: true, imageHookReady: true })
  })

  it('recognizes the real onebot two-record image result format', () => {
    expect(
      parsePersonalWechatHookLog(
        [
          JSON.stringify({ task_id: 536870915, type: 'send_image' }),
          JSON.stringify({
            result: '1',
            task_id: 536870915,
            message: '📩 发送图片任务执行结果'
          })
        ].join('\n')
      )
    ).toMatchObject({ imageHookInstalled: true, imageHookReady: true })
  })
})
