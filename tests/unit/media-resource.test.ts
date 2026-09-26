import { describe, expect, it } from 'vitest'
import {
  decodePackedMessageType,
  decodeResourceType,
  describeResourceStatus,
  mediaResourceSummary
} from '../../src/shared/media-resource'

describe('media resource decode', () => {
  it('unpacks message_local_type as appmsg<<32|local', () => {
    expect(decodePackedMessageType(3)).toMatchObject({ localType: 3, appMsgType: 0 })
    expect(decodePackedMessageType(81604378673)).toMatchObject({
      localType: 49,
      appMsgType: 19
    })
    expect(decodePackedMessageType(25769803825)).toMatchObject({
      localType: 49,
      appMsgType: 6
    })
  })

  it('unpacks MessageResourceDetail.type as kind<<16|sub', () => {
    expect(decodeResourceType(0x40001)).toMatchObject({ kind: 4, sub: 1 })
    expect(decodeResourceType(0x10002)).toMatchObject({ kind: 1, sub: 2 })
    expect(decodeResourceType(3)).toMatchObject({ kind: 0, sub: 3 })
  })

  it('summarizes resource status', () => {
    expect(describeResourceStatus(1)).toBe('已落地')
    expect(describeResourceStatus(0)).toBe('未落地')
    expect(
      mediaResourceSummary({ type: 0x20001, size: 100, status: 1 })
    ).toContain('中图-1')
    expect(mediaResourceSummary({ type: 0x10001, size: 0, status: 0 })).toContain('未落地')
  })
})
