import { describe, expect, it } from 'vitest'
import { resolveMemberName } from '../../src/shared/member-names'

const member = {
  wxid: 'wxid-member',
  nickname: '兼容名称',
  groupNickname: '群内名称',
  wechatNickname: '微信名称',
  remark: '通讯录备注'
}

describe('member name resolution', () => {
  it('keeps group nickname and WeChat nickname modes independent from remarks', () => {
    expect(resolveMemberName(member, 'groupNickname')).toBe('群内名称')
    expect(resolveMemberName(member, 'wechatNickname')).toBe('微信名称')
    expect(resolveMemberName(member, 'remark')).toBe('通讯录备注')
  })

  it('does not leak whitespace and uses the wxid when the selected source is empty', () => {
    expect(
      resolveMemberName(
        { ...member, groupNickname: ' ', wechatNickname: '', remark: '不能串用的备注' },
        'groupNickname'
      )
    ).toBe('wxid-member')
  })
})
