import { describe, expect, it } from 'vitest'
import {
  describePaySubtype,
  describeRedPacketStatus,
  describeTransferStatus
} from '../../src/shared/payment-status'

describe('payment status labels', () => {
  it('maps transfer_status numbers and keywords to UI wording', () => {
    expect(describeTransferStatus(2)).toBe('已收款')
    expect(describeTransferStatus('3')).toBe('已退还')
    expect(describeTransferStatus('paid')).toBe('已收款')
    expect(describeTransferStatus('收款方过期未收款，已退还')).toBe('过期未收款，已退还')
    expect(describeTransferStatus(undefined)).toBeUndefined()
  })

  it('maps red packet hb_status / receive_status', () => {
    expect(describeRedPacketStatus('0', undefined)).toBe('待领取')
    expect(describeRedPacketStatus('1', undefined)).toBe('已领取')
    expect(describeRedPacketStatus(undefined, '2')).toBe('已被领完')
    expect(describeRedPacketStatus('已被领取', undefined)).toBe('已领取')
    expect(describeRedPacketStatus(undefined, undefined)).toBeUndefined()
  })

  it('passes through unknown status values', () => {
    expect(describeTransferStatus('99-custom')).toBe('99-custom')
    expect(describeRedPacketStatus('99', '98')).toBe('99')
    expect(describePaySubtype('3')).toBe('收款')
    expect(describePaySubtype('9')).toBe('9')
  })
})
