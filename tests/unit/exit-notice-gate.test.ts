import { describe, expect, it } from 'vitest'

import {
  isDefinitelyBlocked,
  isEntitlementBlocked,
  resolveExitNoticeGate,
  resolveSwitchPresentation
} from '../../src/main/services/exit-notice-gate'
import type { MessageInsertCapability } from '../../src/main/services/msg-insert-capability-service'

/** 开关呈现：授权不成立时，两个开关必须同时显示关闭。 */

function capability(over: Partial<MessageInsertCapability>): MessageInsertCapability {
  return {
    entitlementState: 'valid',
    nativeComponentState: 'ready',
    databaseReady: true,
    canEnable: true,
    canDisable: true,
    reasonCode: 'CAPABILITY_READY',
    message: '授权与组件均已就绪',
    checkedAt: 0,
    ...over
  }
}

describe('退群内提示开关判定', () => {
  it('授权有效 + 组件就绪 + 库已连接 + 用户开着 → 显示开、确实在跑', () => {
    const d = resolveExitNoticeGate(capability({}), true)
    expect(d).toEqual({ desiredEnabled: true, effectiveEnabled: true, persistDisable: false })
  })

  it('用户本来关着 → 显示关，不落盘', () => {
    const d = resolveExitNoticeGate(capability({}), false)
    expect(d).toEqual({ desiredEnabled: false, effectiveEnabled: false, persistDisable: false })
  })

  it('授权过期（invalid）→ 显示关闭，并把本地开关落盘关掉', () => {
    const cap = capability({
      entitlementState: 'invalid',
      canEnable: false,
      reasonCode: 'LICENSE_EXPIRED',
      message: '授权已过期，请重新激活后再开启'
    })
    const d = resolveExitNoticeGate(cap, true)
    expect(d.desiredEnabled).toBe(false)
    expect(d.effectiveEnabled).toBe(false)
    expect(d.persistDisable).toBe(true)
  })

  it('授权服务探测失败（unavailable）→ 显示关闭，但不改写用户设置', () => {
    const cap = capability({
      entitlementState: 'unavailable',
      canEnable: false,
      reasonCode: 'LICENSE_UNAVAILABLE',
      message: '暂时无法确认授权状态'
    })
    const d = resolveExitNoticeGate(cap, true)
    expect(d.desiredEnabled).toBe(false)
    expect(d.effectiveEnabled).toBe(false)
    /* 微信刚启动时 4290 还没起来，这时落盘会把正常正常用户的开关误关 */
    expect(d.persistDisable).toBe(false)
    expect(isDefinitelyBlocked(cap)).toBe(false)
    expect(isEntitlementBlocked(cap)).toBe(true)
  })

  it('组件缺失 → 显示关闭，落盘关掉（OSS 包的典型状态）', () => {
    const cap = capability({
      nativeComponentState: 'missing',
      canEnable: false,
      reasonCode: 'COMPONENT_MISSING',
      message: '未安装发送能力组件'
    })
    const d = resolveExitNoticeGate(cap, true)
    expect(d.desiredEnabled).toBe(false)
    expect(d.persistDisable).toBe(true)
  })

  it('组件架构不匹配 → 显示关闭并落盘', () => {
    const cap = capability({
      nativeComponentState: 'incompatible',
      canEnable: false,
      reasonCode: 'COMPONENT_INVALID'
    })
    expect(resolveExitNoticeGate(cap, true).persistDisable).toBe(true)
  })

  it('授权与组件都就绪、只是微信库没连 → 保留用户意愿，不显示成已生效', () => {
    const cap = capability({
      databaseReady: false,
      canEnable: false,
      reasonCode: 'DATABASE_UNAVAILABLE',
      message: '微信数据库尚未连接'
    })
    const d = resolveExitNoticeGate(cap, true)
    expect(d.desiredEnabled).toBe(true)
    expect(d.effectiveEnabled).toBe(false)
    /* 库连上是暂时的，不能因此把人家的开关关掉 */
    expect(d.persistDisable).toBe(false)
  })

  it('平台不支持（公开版/非 Windows-mac 包）→ 显示关闭并落盘', () => {
    const cap = capability({
      entitlementState: 'unsupported',
      canEnable: false,
      reasonCode: 'UNSUPPORTED_PLATFORM',
      databaseReady: false
    })
    const d = resolveExitNoticeGate(cap, true)
    expect(d.desiredEnabled).toBe(false)
    expect(d.persistDisable).toBe(true)
  })

  it('授权正在验证（pending）→ 先按关闭显示，不改写设置', () => {
    const cap = capability({
      entitlementState: 'pending',
      canEnable: false,
      reasonCode: 'LICENSE_PENDING'
    })
    const d = resolveExitNoticeGate(cap, true)
    expect(d.desiredEnabled).toBe(false)
    expect(d.persistDisable).toBe(false)
  })
})

describe('两个微信内开关的呈现（防撤回 / 退群提示必须一致）', () => {
  const expired = capability({
    entitlementState: 'invalid',
    canEnable: false,
    reasonCode: 'LICENSE_EXPIRED'
  })
  const unavailable = capability({
    entitlementState: 'unavailable',
    canEnable: false,
    reasonCode: 'LICENSE_UNAVAILABLE'
  })
  const noComponent = capability({
    nativeComponentState: 'missing',
    canEnable: false,
    reasonCode: 'COMPONENT_MISSING'
  })

  it('报障场景：库里 recall=1 且本地退群=true，没有授权 → 两个都显示关闭', () => {
    for (const cap of [expired, unavailable, noComponent]) {
      expect(resolveSwitchPresentation('recall_notice', true, cap)).toEqual({
        desiredEnabled: false,
        effectiveEnabled: false
      })
      expect(resolveSwitchPresentation('group_exit_notice', true, cap)).toEqual({
        desiredEnabled: false,
        effectiveEnabled: false
      })
    }
  })

  it('授权与组件都就绪、库已连接 → 两个都保持用户设置', () => {
    const ok = capability({})
    expect(resolveSwitchPresentation('recall_notice', true, ok)).toEqual({
      desiredEnabled: true,
      effectiveEnabled: true
    })
    expect(resolveSwitchPresentation('group_exit_notice', true, ok)).toEqual({
      desiredEnabled: true,
      effectiveEnabled: true
    })
  })

  it('只是微信库没连 → 保留用户意愿但 effective 为 false', () => {
    const noDb = capability({
      databaseReady: false,
      canEnable: false,
      reasonCode: 'DATABASE_UNAVAILABLE'
    })
    expect(resolveSwitchPresentation('recall_notice', true, noDb)).toEqual({
      desiredEnabled: true,
      effectiveEnabled: false
    })
    expect(resolveSwitchPresentation('group_exit_notice', true, noDb)).toEqual({
      desiredEnabled: true,
      effectiveEnabled: false
    })
  })

  it('用户本来就关着 + 无授权 → 依然是关闭，不会被"授权没问题"之外的逻辑打开', () => {
    expect(resolveSwitchPresentation('recall_notice', false, expired).desiredEnabled).toBe(false)
    expect(resolveSwitchPresentation('group_exit_notice', false, expired).desiredEnabled).toBe(
      false
    )
  })
})
