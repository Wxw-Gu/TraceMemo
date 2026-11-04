import { describe, expect, it } from 'vitest'

import { resolveLicenseRefreshFailure } from '../../src/main/services/mac-wechat-runtime-manager'
import type { MacLicenseStatus } from '../../src/shared/personal-wechat-mac-license'

const DEVICE_ID = `mac_${'a'.repeat(64)}`

function status(overrides: Partial<MacLicenseStatus> = {}): MacLicenseStatus {
  return {
    deviceId: DEVICE_ID,
    state: 'cached',
    authorized: true,
    source: 'cache',
    features: ['wechat'],
    lastCheckedAt: '2026-11-04T07:00:00Z',
    licenseExpiresAt: null,
    tokenExpiresAt: '2026-11-05T07:00:00Z',
    message: '授权有效（本地缓存）',
    ...overrides
  }
}

const DIAGNOSTIC = '无法连接授权服务器，请检查网络后重试'

describe('resolveLicenseRefreshFailure', () => {
  it('有效缓存时保留授权，并把本次失败写进诊断信息', () => {
    const result = resolveLicenseRefreshFailure(status(), DIAGNOSTIC)

    // 授权状态不变 —— 网络故障不能让已授权设备变成未授权。
    expect(result.authorized).toBe(true)
    expect(result.state).toBe('cached')
    expect(result.deviceId).toBe(DEVICE_ID)
    expect(result.features).toEqual(['wechat'])
    // 但这次失败必须可见，不能被快照整个盖掉。
    expect(result.message).toContain('本次刷新失败')
    expect(result.message).toContain(DIAGNOSTIC)
    expect(result.message).toContain('本地缓存授权')
  })

  it('无有效缓存时明确报 server_unavailable，而不是未授权或已撤销', () => {
    const result = resolveLicenseRefreshFailure(null, DIAGNOSTIC)

    expect(result.state).toBe('server_unavailable')
    expect(result.authorized).toBe(false)
    expect(result.state).not.toBe('revoked')
    expect(result.state).not.toBe('unlicensed')
    expect(result.message).toBe(DIAGNOSTIC)
  })

  it('快照存在但未授权时同样按网络故障处理', () => {
    const result = resolveLicenseRefreshFailure(
      status({ state: 'unlicensed', authorized: false, message: '当前设备暂无发送能力授权' }),
      DIAGNOSTIC
    )

    expect(result.state).toBe('server_unavailable')
    expect(result.authorized).toBe(false)
    expect(result.message).toBe(DIAGNOSTIC)
  })

  it('不把 revoked 快照改写成授权有效', () => {
    const result = resolveLicenseRefreshFailure(
      status({ state: 'revoked', authorized: false, message: '授权已被撤销' }),
      DIAGNOSTIC
    )

    expect(result.authorized).toBe(false)
    expect(result.state).toBe('server_unavailable')
  })
})
