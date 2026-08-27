import type {
  PersonalWechatSendCapability,
  PersonalWechatSendCapabilityState,
  PersonalWechatSenderStatus
} from '../../shared/personal-wechat'
import {
  personalWechatSendService,
  type PersonalWechatSendService
} from './personal-wechat-send-service'

/**
 * Converts the detailed sender diagnostics into a small contract that other
 * features can consume without knowing about OneBot, Hook or platform details.
 */
export class PersonalWechatCapabilityService {
  constructor(private readonly sender: Pick<PersonalWechatSendService, 'getStatus'>) {}

  async getPersonalWechatSendCapability(): Promise<PersonalWechatSendCapability> {
    const senderStatus = await this.sender.getStatus()
    return this.fromSenderStatus(senderStatus)
  }

  fromSenderStatus(senderStatus: PersonalWechatSenderStatus): PersonalWechatSendCapability {
    const capabilities = {
      text: Boolean(senderStatus.canSendText),
      image: Boolean(senderStatus.canSendImage),
      voice: Boolean(senderStatus.canSendVoice)
    }
    const status = this.mapState(senderStatus, capabilities.image)
    const ready = status === 'ready'
    return {
      supported: status !== 'unsupported',
      ready,
      status,
      capabilities,
      senderStatus,
      message:
        status === 'unsupported'
          ? '微信消息发送目前仅支持 macOS'
          : status === 'needs_binding' || status === 'unconfigured'
            ? '请先绑定个人微信'
            : status === 'needs_verification'
              ? '请先完成微信消息能力检测'
              : status === 'ready'
                ? '个人微信已准备好发送日报'
                : senderStatus.message || senderStatus.error || '个人微信发送能力异常',
      ...(senderStatus.error ? { error: senderStatus.error } : {})
    }
  }

  private mapState(
    senderStatus: PersonalWechatSenderStatus,
    canSendImage: boolean
  ): PersonalWechatSendCapabilityState {
    if (senderStatus.platform !== 'darwin' || senderStatus.state === 'unsupported_platform') {
      return 'unsupported'
    }
    if (senderStatus.state === 'error') return 'error'
    const hasBinding = Boolean(senderStatus.boundWechatPid)
    if (!hasBinding) {
      return senderStatus.runtimeReady ? 'needs_binding' : 'unconfigured'
    }
    if (canSendImage) return 'ready'
    if (
      senderStatus.state === 'hook_not_ready' ||
      senderStatus.state === 'online' ||
      senderStatus.state === 'starting' ||
      senderStatus.state === 'stopped'
    ) {
      return 'needs_verification'
    }
    return 'error'
  }
}

export const personalWechatCapabilityService = new PersonalWechatCapabilityService(
  personalWechatSendService
)

export const getPersonalWechatSendCapability = (): Promise<PersonalWechatSendCapability> =>
  personalWechatCapabilityService.getPersonalWechatSendCapability()
