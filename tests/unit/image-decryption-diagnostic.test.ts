import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'wxe-image-diagnostic-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => root,
    getVersion: () => '2.1.7-test'
  }
}))
vi.mock('../../src/main/image-decrypt-service', () => ({
  ImageDecryptService: class {},
  inspectImageDecoderStatus: vi.fn()
}))
vi.mock('../../src/main/services/chat-service', () => ({}))
vi.mock('../../src/main/services/image-key-config-service', () => ({
  validateImageKeyRequest: vi.fn()
}))
vi.mock('../../src/main/services/wechat-process-status', () => ({
  isWechatRunning: vi.fn()
}))

import { buildImageTestDiagnosticLog } from '../../src/main/services/image-decryption-status-service'

describe('image decryption diagnostic log', () => {
  beforeAll(() => mkdirSync(join(root, 'private-account', 'msg', 'attach'), { recursive: true }))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('keeps useful failure details without exposing keys or absolute paths', () => {
    const resourceRoot = join(root, 'private-account')
    const aesKey = '0123456789abcdef'
    const imageMd5 = '1234567890abcdef1234567890abcdef'
    const log = buildImageTestDiagnosticLog({
      request: {
        userMd5: 'conversation-secret',
        resourceRoot,
        xorKey: '0x40',
        aesKey
      },
      result: {
        success: false,
        code: 'DECRYPT_FAILED',
        error: '图片密钥与当前账号不匹配，或图片文件已损坏',
        fileFound: true,
        decrypted: false,
        readable: false,
        isThumbnail: false
      },
      startedAt: Date.now() - 25,
      testedImage: {
        md5: imageMd5,
        datName: `${imageMd5}_h.dat`,
        sessionId: 'wxid_private_session',
        selection: '自动测试样本'
      },
      filePath: join(
        resourceRoot,
        'msg',
        'attach',
        imageMd5,
        '2026-08',
        'Img',
        `${imageMd5}_h.dat`
      ),
      decodeDiagnostic: {
        code: 'AES_DECRYPT_FAILED',
        detail: 'AES 解密校验失败，密钥可能与当前账号不匹配',
        datVersion: 2,
        fileSize: 2048
      }
    })

    expect(log).toContain('AES_DECRYPT_FAILED')
    expect(log).toContain('WeChat 4.0 V2')
    expect(log).toContain('内容未记录')
    expect(log).not.toContain(aesKey)
    expect(log).not.toContain(resourceRoot)
    expect(log).not.toContain(imageMd5)
    expect(log).not.toContain('conversation-secret')
    expect(log).not.toContain('wxid_private_session')
  })

  it('describes plain images with a DAT extension without reporting an unsupported protocol', () => {
    const resourceRoot = join(root, 'private-account')
    const filePath = join(resourceRoot, 'msg', 'attach', 'plain-image_M.dat')
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]))
    const log = buildImageTestDiagnosticLog({
      request: {
        userMd5: 'conversation-secret',
        resourceRoot,
        xorKey: '0x40',
        aesKey: '0123456789abcdef'
      },
      result: {
        success: true,
        fileFound: true,
        decrypted: true,
        readable: true,
        isThumbnail: false
      },
      startedAt: Date.now() - 10,
      filePath,
      decodeDiagnostic: {
        code: 'DIRECT_IMAGE',
        detail: 'DAT 文件内容是可直接读取的图片',
        fileSize: 8,
        imageFormat: 'PNG'
      }
    })

    expect(log).toContain('DAT 协议：明文图片（无需 DAT 解密）')
    expect(log).not.toContain('不受支持/旧版格式')
  })
})
