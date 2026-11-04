import type { MacLicenseStatus } from './personal-wechat-mac-license'
import type { MacWechatSendRuntimeAvailabilityResult } from './personal-wechat-mac-runtime'
import type { PersonalWechatSenderStatus } from './personal-wechat'

export type MacSendPrimaryActionKind = 'none' | 'bind' | 'send'

export interface MacSendPrimaryAction {
  label: string
  disabled: boolean
  loading: boolean
  action: MacSendPrimaryActionKind
  reason:
    | 'runtime_unavailable'
    | 'runtime_error'
    | 'license_pending'
    | 'license_invalid'
    | 'license_feature_denied'
    | 'binding'
    | 'unbound'
    | 'initializing'
    | 'ready'
}

export function hasValidWechatLicense(license: MacLicenseStatus | null): boolean {
  if (
    !license ||
    !license.authorized ||
    (license.state !== 'valid' && license.state !== 'cached') ||
    !license.features.includes('wechat')
  ) {
    return false
  }
  const tokenExpiresAt = license.tokenExpiresAt ? Date.parse(license.tokenExpiresAt) : Number.NaN
  return Number.isFinite(tokenExpiresAt) && tokenExpiresAt > Date.now()
}

export function resolveMacSendPrimaryAction(input: {
  runtime: MacWechatSendRuntimeAvailabilityResult | null
  license: MacLicenseStatus | null
  senderStatus: PersonalWechatSenderStatus | null
  binding: boolean
  detecting: boolean
}): MacSendPrimaryAction {
  const { runtime, license, senderStatus, binding, detecting } = input
  const result = (
    label: string,
    disabled: boolean,
    loading: boolean,
    action: MacSendPrimaryActionKind,
    reason: MacSendPrimaryAction['reason']
  ): MacSendPrimaryAction => ({ label, disabled, loading, action, reason })

  if (!runtime || (detecting && !senderStatus)) {
    return result('正在检查发送组件…', true, true, 'none', 'runtime_error')
  }
  if (runtime.state === 'unavailable') {
    return result('当前版本没有微信发送能力', true, false, 'none', 'runtime_unavailable')
  }
  if (runtime.state === 'component_error') {
    return result('发送组件缺失或异常', true, false, 'none', 'runtime_error')
  }
  if (license === null) {
    return result('正在检测授权…', true, true, 'none', 'license_pending')
  }
  if (license.state === 'valid' || license.state === 'cached') {
    if (license.authorized && !license.features.includes('wechat')) {
      return result('未开通微信发送', true, false, 'none', 'license_feature_denied')
    }
    if (hasValidWechatLicense(license)) {
      if (binding) return result('正在绑定…', true, true, 'none', 'binding')
      const bound = Boolean(
        senderStatus &&
        (senderStatus.state === 'online' ||
          Boolean(
            senderStatus.wechatPid &&
            senderStatus.boundWechatPid === senderStatus.wechatPid &&
            senderStatus.attachReady &&
            senderStatus.baseAddressReady
          ))
      )
      if (!bound) return result('绑定微信', false, false, 'bind', 'unbound')
      if (senderStatus?.canSend) return result('开始发送', false, false, 'send', 'ready')
      return result('正在准备发送能力…', true, detecting, 'none', 'initializing')
    }
  }
  const bound = Boolean(
    senderStatus &&
    (senderStatus.state === 'online' ||
      Boolean(
        senderStatus.wechatPid &&
        senderStatus.boundWechatPid === senderStatus.wechatPid &&
        senderStatus.attachReady &&
        senderStatus.baseAddressReady
      ))
  )
  return result(
    bound ? '授权后可开始发送' : '授权后可绑定微信',
    true,
    false,
    'none',
    'license_invalid'
  )
}
