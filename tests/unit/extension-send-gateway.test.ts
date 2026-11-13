import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionSendGateway } from '../../src/main/extensions/extension-send-gateway'
import type { PersonalWechatSendCapability } from '../../src/shared/personal-wechat'
import type { WechatActionRequest, WechatActionResult } from '../../src/shared/wechat-action'

const readyCapability = {
  supported: true,
  ready: true,
  status: 'ready',
  capabilities: { text: true, image: true, voice: false, video: true },
  senderStatus: {},
  message: '已就绪'
} as unknown as PersonalWechatSendCapability

const sentResult: WechatActionResult = {
  actionId: 'action-1',
  status: 'sent',
  decision: 'allow',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z'
}

function gateway(
  overrides: {
    capability?: PersonalWechatSendCapability
    entitlement?: {
      ok: boolean
      message: string
      source: 'mac_license' | 'hook_license' | 'unsupported'
    }
    executeAction?: (request: WechatActionRequest) => Promise<WechatActionResult>
    dataRoot?: string
    now?: () => number
  } = {}
): {
  instance: ExtensionSendGateway
  executeAction: ReturnType<
    typeof vi.fn<(request: WechatActionRequest) => Promise<WechatActionResult>>
  >
} {
  const executeAction = vi.fn(async (request: WechatActionRequest) => {
    if (overrides.executeAction) return overrides.executeAction(request)
    return sentResult
  })
  const instance = new ExtensionSendGateway({
    getCapability: async () => overrides.capability ?? readyCapability,
    checkEntitlement: async () =>
      overrides.entitlement ?? { ok: true, message: '授权有效', source: 'mac_license' },
    executeAction: executeAction as never,
    ...(overrides.dataRoot ? { getExtensionDataRoot: () => overrides.dataRoot as string } : {}),
    now: overrides.now ?? (() => 1_000_000)
  })
  return { instance, executeAction }
}

const context = {
  extensionId: 'com.example.keyword-bot',
  permissions: ['wechat.send.text' as const],
  conversationScope: [] as string[]
}

describe('extension send gateway', () => {
  it('缺少权限时拒绝，且不触碰 Gateway', async () => {
    const executeAction = vi.fn(async (request: WechatActionRequest) => {
      void request
      return sentResult
    })
    const { instance } = gateway({ executeAction })
    await expect(
      instance.sendText({ ...context, permissions: [] }, { to: 'fixture@chatroom', text: 'hi' })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(executeAction).not.toHaveBeenCalled()
  })

  it('目标超出扩展声明的会话范围时拒绝', async () => {
    const { instance } = gateway()
    await expect(
      instance.sendText(
        { ...context, conversationScope: ['allowed@chatroom'] },
        { to: 'other@chatroom', text: 'hi' }
      )
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('发送能力未就绪时返回 CAPABILITY_UNAVAILABLE', async () => {
    const { instance } = gateway({
      capability: { ...readyCapability, ready: false, message: '请先绑定个人微信' }
    })
    await expect(
      instance.sendText(context, { to: 'fixture@chatroom', text: 'hi' })
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
  })

  it('没有有效授权时返回 LICENSE_REQUIRED', async () => {
    const executeAction = vi.fn(async (request: WechatActionRequest) => {
      void request
      return sentResult
    })
    const { instance } = gateway({
      entitlement: { ok: false, message: '需要有效授权', source: 'mac_license' },
      executeAction
    })
    await expect(
      instance.sendText(context, { to: 'fixture@chatroom', text: 'hi' })
    ).rejects.toMatchObject({ code: 'LICENSE_REQUIRED' })
    expect(executeAction).not.toHaveBeenCalled()
  })

  it('成功时由宿主填写 origin / purpose / 幂等键', async () => {
    const executeAction = vi.fn(async (request: WechatActionRequest) => {
      void request
      return sentResult
    })
    const { instance } = gateway({ executeAction })
    const result = await instance.sendText(context, {
      to: 'fixture@chatroom',
      text: '你好',
      dedupeKey: 'event-1'
    })
    expect(result).toEqual({ actionId: 'action-1', status: 'sent' })
    const request = executeAction.mock.calls[0][0] as unknown as Record<string, unknown>
    expect(request.origin).toBe('extension')
    expect(request.purpose).toBe('extension_send')
    expect(request.triggerType).toBe('automation')
    expect((request.metadata as { extensionId: string }).extensionId).toBe(context.extensionId)
    expect(String(request.idempotencyKey)).toMatch(/^extension:com\.example\.keyword-bot:/)
    expect((request.recipient as { type: string }).type).toBe('group')
  })

  it('两条之间至少 2 秒，超限返回 RATE_LIMITED', async () => {
    let now = 1_000_000
    const { instance } = gateway({ now: () => now })
    await instance.sendText(context, { to: 'fixture@chatroom', text: 'one' })
    await expect(
      instance.sendText(context, { to: 'fixture@chatroom', text: 'two' })
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    now += 2_001
    await expect(
      instance.sendText(context, { to: 'fixture@chatroom', text: 'three' })
    ).resolves.toEqual({
      actionId: 'action-1',
      status: 'sent'
    })
  })

  it('网关失败时把底层错误码映射成扩展错误码', async () => {
    const { instance } = gateway({
      executeAction: async () => ({
        actionId: 'action-2',
        status: 'failed',
        decision: 'allow',
        errorCode: 'SEND_NOT_READY',
        reason: '未绑定',
        startedAt: '',
        finishedAt: ''
      })
    })
    await expect(
      instance.sendText(context, { to: 'fixture@chatroom', text: 'hi' })
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
  })

  it('非群聊忽略 at 参数，文本长度超限直接拒绝', async () => {
    const executeAction = vi.fn(async (request: WechatActionRequest) => {
      void request
      return sentResult
    })
    const { instance } = gateway({ executeAction })
    await instance.sendText(context, {
      to: 'wxid_peer',
      text: 'hi',
      at: { wxid_peer: '张三' }
    })
    expect(executeAction).toHaveBeenCalledTimes(1)
    const request = executeAction.mock.calls[0][0] as { content: { at?: unknown } }
    expect(request.content.at).toBeUndefined()
    await expect(
      instance.sendText(context, { to: 'wxid_peer', text: 'x'.repeat(2_001) })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})

describe('extension send gateway / image', () => {
  const cleanup: string[] = []

  function tempDir(prefix: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    cleanup.push(root)
    return root
  }

  afterEach(() => {
    for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  const imageContext = {
    extensionId: 'com.example.douyin',
    permissions: ['wechat.send.image' as const],
    conversationScope: [] as string[]
  }

  it('缺少 wechat.send.image 权限时拒绝', async () => {
    const { instance } = gateway({ dataRoot: tempDir('tm-ext-data-') })
    await expect(
      instance.sendImage(
        { ...imageContext, permissions: [] },
        { to: 'fixture@chatroom', path: '/tmp/a.mp4' }
      )
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('只能发送扩展数据目录或临时目录内的文件', async () => {
    const dataRoot = tempDir('tm-ext-data-')
    // 刻意放在仓库工作目录下：它既不在扩展数据目录，也不在系统临时目录。
    const outside = fs.mkdtempSync(path.join(process.cwd(), '.tm-ext-outside-'))
    cleanup.push(outside)
    const file = path.join(outside, 'cover.png')
    fs.writeFileSync(file, Buffer.from('fixture'))
    const { instance, executeAction } = gateway({ dataRoot })
    await expect(
      instance.sendImage(imageContext, { to: 'fixture@chatroom', path: file })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(executeAction).not.toHaveBeenCalled()
  })

  it('图片按 image 类型提交，路径取 realpath', async () => {
    const dataRoot = tempDir('tm-ext-data-')
    const file = path.join(dataRoot, 'cover.png')
    fs.writeFileSync(file, Buffer.from('fixture-image'))
    const { instance, executeAction } = gateway({ dataRoot })
    const result = await instance.sendImage(imageContext, {
      to: 'fixture@chatroom',
      path: file,
      dedupeKey: 'message:fixture'
    })
    expect(result).toEqual({ actionId: 'action-1', status: 'sent' })
    const request = executeAction.mock.calls[0][0]
    expect(request.origin).toBe('extension')
    expect(request.purpose).toBe('extension_send')
    expect(request.content).toEqual({ type: 'image', path: fs.realpathSync(file) })
    expect(request.recipient).toMatchObject({ type: 'group', id: 'fixture@chatroom' })
    expect(String(request.idempotencyKey)).toMatch(/^extension:com\.example\.douyin:/)
  })

  it('拒绝非图片/视频扩展名与不存在的路径', async () => {
    const dataRoot = tempDir('tm-ext-data-')
    const textFile = path.join(dataRoot, 'note.txt')
    fs.writeFileSync(textFile, Buffer.from('fixture'))
    const { instance } = gateway({ dataRoot })
    await expect(
      instance.sendImage(imageContext, { to: 'fixture@chatroom', path: textFile })
    ).rejects.toMatchObject({ code: 'SEND_NOT_SUPPORTED' })
    await expect(
      instance.sendImage(imageContext, {
        to: 'fixture@chatroom',
        path: path.join(dataRoot, 'missing.mp4')
      })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})

describe('extension send gateway / video', () => {
  const cleanup: string[] = []

  function tempDir(prefix: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    cleanup.push(root)
    return root
  }

  afterEach(() => {
    for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  const videoContext = {
    extensionId: 'com.example.douyin',
    permissions: ['wechat.send.video' as const],
    conversationScope: [] as string[]
  }

  it('缺 wechat.send.video 权限时拒绝', async () => {
    const { instance } = gateway({ dataRoot: tempDir('tm-ext-data-') })
    await expect(
      instance.sendVideo(
        { ...videoContext, permissions: [] },
        { to: 'fixture@chatroom', path: '/tmp/a.mp4' }
      )
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('视频按 video 类型提交，不复用 image 通道', async () => {
    const dataRoot = tempDir('tm-ext-data-')
    const file = path.join(dataRoot, 'clip.mp4')
    fs.writeFileSync(file, Buffer.from('fixture-video'))
    const { instance, executeAction } = gateway({ dataRoot })
    const result = await instance.sendVideo(videoContext, {
      to: 'fixture@chatroom',
      path: file,
      dedupeKey: 'message:fixture:video'
    })
    expect(result).toEqual({ actionId: 'action-1', status: 'sent' })
    const request = executeAction.mock.calls[0][0]
    expect(request.origin).toBe('extension')
    expect(request.purpose).toBe('extension_send')
    expect(request.content).toEqual({ type: 'video', path: fs.realpathSync(file) })
    expect(request.recipient).toMatchObject({ type: 'group', id: 'fixture@chatroom' })
    expect(String(request.idempotencyKey)).toMatch(/^extension:com\.example\.douyin:/)
  })

  it('视频通道拒绝图片扩展名', async () => {
    const dataRoot = tempDir('tm-ext-data-')
    const file = path.join(dataRoot, 'cover.png')
    fs.writeFileSync(file, Buffer.from('fixture-image'))
    const { instance } = gateway({ dataRoot })
    await expect(
      instance.sendVideo(videoContext, { to: 'fixture@chatroom', path: file })
    ).rejects.toMatchObject({ code: 'SEND_NOT_SUPPORTED' })
  })

  it('本机能力没有视频时返回 CAPABILITY_UNAVAILABLE', async () => {
    const dataRoot = tempDir('tm-ext-data-')
    const file = path.join(dataRoot, 'clip.mp4')
    fs.writeFileSync(file, Buffer.from('fixture-video'))
    const { instance } = gateway({
      dataRoot,
      capability: {
        ...readyCapability,
        capabilities: { text: true, image: true, voice: false, video: false }
      }
    })
    await expect(
      instance.sendVideo(videoContext, { to: 'fixture@chatroom', path: file })
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
  })
})
