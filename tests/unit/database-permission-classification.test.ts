import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => 'fixture-settings' },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { databaseKeyErrorMessage, mapConnectionError } from '../../src/main/services/chat-service'
import {
  isPermissionDeniedError,
  looksLikePermissionDenied,
  PathAccessDeniedError,
  probePathAccess
} from '../../src/main/services/path-access-probe'

/**
 * macOS 未授予「完全磁盘访问权限」时的错误分类。
 *
 * 背景：底层探测用的是 `fs.existsSync()`，它对 `EPERM` 同样返回 `false`，
 * 于是"权限被拒绝"会被静默降级成"文件不存在"，最终报出「数据库文件缺失」——
 * 用户据此去查路径和重装，而真正该做的是去系统设置授权。
 *
 * 这组用例把分类规则的**顺序**钉住：权限判定必须排在文件缺失之前，
 * 同时不能把真正缺失、账号不匹配、Windows VC Runtime 这些既有分类挤掉。
 */
function errnoError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('数据库错误分类 · 权限优先于文件缺失', () => {
  it('EPERM 且文本里带 session.db，仍归为权限问题而不是文件缺失', () => {
    const error = errnoError(
      "EPERM: operation not permitted, open '/Users/fixture/xwechat_files/wxid_demo/db_storage/session/session.db'",
      'EPERM'
    )
    expect(mapConnectionError(error)).toBe('DATABASE_PERMISSION_DENIED')
  })

  it('EACCES 同样归为权限问题', () => {
    const error = errnoError(
      "EACCES: permission denied, open '/Users/fixture/xwechat_files/wxid_demo/db_storage/session/session.db'",
      'EACCES'
    )
    expect(mapConnectionError(error)).toBe('DATABASE_PERMISSION_DENIED')
  })

  it('errno 被包装层丢掉、只剩文本时仍能识别（这是真实的降级形态）', () => {
    expect(
      mapConnectionError(new Error("EPERM: operation not permitted, open '/x/session.db'"))
    ).toBe('DATABASE_PERMISSION_DENIED')
    expect(mapConnectionError(new Error("EACCES: permission denied, stat '/x/session.db'"))).toBe(
      'DATABASE_PERMISSION_DENIED'
    )
  })

  it('探测层抛出的 PathAccessDeniedError 能被通用判定识别', () => {
    const error = new PathAccessDeniedError('/fixture/xwechat_files/wxid_demo/db_storage')
    expect(isPermissionDeniedError(error)).toBe(true)
    expect(mapConnectionError(error)).toBe('DATABASE_PERMISSION_DENIED')
  })

  it('文本匹配不过宽：permission 出现在无关语义里不会被误判', () => {
    expect(mapConnectionError(new Error('permission config not found in manifest'))).not.toBe(
      'DATABASE_PERMISSION_DENIED'
    )
  })
})

describe('数据库错误分类 · 既有分类不被权限规则抢走', () => {
  it('真正的文件缺失仍是数据库文件缺失', () => {
    expect(
      mapConnectionError(
        new Error('未找到微信 4.0 session.db: /Users/fixture/xwechat_files/wxid_demo/db_storage')
      )
    ).toBe('DATABASE_FILE_MISSING')
    expect(
      mapConnectionError(
        errnoError("ENOENT: no such file or directory, stat '/x/session.db'", 'ENOENT')
      )
    ).toBe('DATABASE_FILE_MISSING')
  })

  it('账号密钥不匹配不受影响', () => {
    expect(mapConnectionError(new Error('密钥与当前账号不匹配'))).toBe('ACCOUNT_MISMATCH')
    expect(mapConnectionError(new Error('wcdb_open_account failed: -1005'))).toBe(
      'ACCOUNT_MISMATCH'
    )
  })

  it('Windows VC Runtime 缺失语义不受影响', () => {
    /*
     * 输入必须是**底层错误文本**（DLL 加载失败），不是给用户看的那段文案 ——
     * `isWindowsVcRuntimeMissingError` 匹配的是 vcruntime140.dll / win32 error 126
     * 这类特征，用户文案里没有它们。
     */
    const vcError = new Error(
      'ERR_DLOPEN_FAILED: The specified module could not be found. vcruntime140.dll (win32 error 126)'
    )
    expect(mapConnectionError(vcError, 'win32')).toBe('VC_RUNTIME_MISSING')
    // 同一条文本在 macOS 上不该被归成 Windows 专属错误码。
    expect(mapConnectionError(vcError, 'darwin')).not.toBe('VC_RUNTIME_MISSING')
  })

  it('根目录不可用与打开失败仍各自归类', () => {
    expect(mapConnectionError(new Error('未找到包含 db_storage 的微信 4.0 账号目录: /x'))).toBe(
      'ROOT_UNAVAILABLE'
    )
    expect(mapConnectionError(new Error('wcdb_open_account failed'))).toBe('DATABASE_OPEN_FAILED')
  })
})

describe('数据库错误分类 · 用户可见文案', () => {
  it('macOS 上权限不足给出「完全磁盘访问权限」这一步，且与文件缺失文案不同', () => {
    const denied = databaseKeyErrorMessage('DATABASE_PERMISSION_DENIED', 'darwin')
    expect(denied).toContain('完全磁盘访问权限')
    expect(denied).toContain('隐私与安全性')
    expect(denied).not.toBe(databaseKeyErrorMessage('DATABASE_FILE_MISSING', 'darwin'))
  })

  it('文件缺失文案保持原样（不能因为修权限把这条改坏）', () => {
    expect(databaseKeyErrorMessage('DATABASE_FILE_MISSING', 'darwin')).toBe('数据库文件缺失')
  })

  it('文案里不出现裸的技术码', () => {
    const denied = databaseKeyErrorMessage('DATABASE_PERMISSION_DENIED', 'darwin')
    expect(denied).not.toContain('EPERM')
    expect(denied).not.toContain('EACCES')
  })

  it('非 macOS 平台不给 macOS 专属指引', () => {
    const win = databaseKeyErrorMessage('DATABASE_PERMISSION_DENIED', 'win32')
    expect(win).not.toContain('完全磁盘访问权限')
    expect(win).not.toContain('macOS')
    expect(win).toContain('无法读取微信数据库')
  })

  /**
   * FDA 是**故障恢复方案**，不是安装前置条件。
   * 文案必须读起来像"读不到时怎么办"，而不是"用之前必须先开"。
   */
  it('权限文案的口吻是故障恢复，不是安装前置条件', () => {
    const denied = databaseKeyErrorMessage('DATABASE_PERMISSION_DENIED', 'darwin')
    expect(denied).toContain('无法读取微信数据库')
    expect(denied).not.toContain('使用前')
    expect(denied).not.toContain('必须先')
    expect(denied).not.toContain('安装')
  })

  it('只有权限码在 macOS 上分叉，其余错误码跨平台一致', () => {
    for (const code of [
      'INVALID_FORMAT',
      'DATABASE_OPEN_FAILED',
      'ACCOUNT_MISMATCH',
      'ROOT_UNAVAILABLE',
      'DATABASE_FILE_MISSING',
      'UNKNOWN_VALIDATION_ERROR'
    ] as const) {
      expect(databaseKeyErrorMessage(code, 'darwin')).toBe(databaseKeyErrorMessage(code, 'win32'))
    }
  })
})

/**
 * 底层探测：`existsSync` 分不出「不存在」和「读不了」，所以新增的 probe 必须能分。
 *
 * 权限断言只在非 Windows 上跑：Windows 的 `chmod` 不改变实际访问能力，
 * 断言在那里不成立。这是**文件系统语义本身**的平台差异，不是业务逻辑被跳过。
 */
describe('路径可访问性探测', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      try {
        chmodSync(join(root, 'locked'), 0o755)
      } catch {
        /* 目录可能已不存在 */
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('能区分可读 / 不存在 / 无权限', () => {
    const root = mkdtempSync(join(tmpdir(), 'wxe-path-probe-'))
    roots.push(root)
    const locked = join(root, 'locked')
    mkdirSync(locked)
    writeFileSync(join(locked, 'session.db'), 'fixture')
    chmodSync(locked, 0o000)

    expect(probePathAccess(root)).toBe('ok')
    expect(probePathAccess(join(root, 'does-not-exist.db'))).toBe('missing')

    if (process.platform !== 'win32') {
      const target = join(locked, 'session.db')
      expect(probePathAccess(target)).toBe('denied')
      expect(looksLikePermissionDenied(target)).toBe(true)
    }
  })

  it('PathAccessDeniedError 带上与 fs errno 对齐的 code', () => {
    const error = new PathAccessDeniedError('/fixture/path')
    expect(error.code).toBe('EPERM')
    expect(error.name).toBe('PathAccessDeniedError')
    expect(isPermissionDeniedError(error)).toBe(true)
  })
})
