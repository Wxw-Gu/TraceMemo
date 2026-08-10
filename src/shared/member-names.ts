export type MemberNameMode = 'groupNickname' | 'wechatNickname' | 'remark'

export interface MemberNameFields {
  wxid: string
  nickname?: string
  groupNickname?: string
  wechatNickname?: string
  remark?: string
}

const firstName = (...values: Array<string | undefined>): string =>
  values.map((value) => String(value || '').trim()).find(Boolean) || ''

export function resolveMemberName(member: MemberNameFields, mode: MemberNameMode): string {
  if (mode === 'groupNickname') {
    return firstName(member.groupNickname, member.wechatNickname, member.wxid)
  }
  if (mode === 'wechatNickname') {
    return firstName(member.wechatNickname, member.groupNickname, member.wxid)
  }
  return firstName(
    member.remark,
    member.wechatNickname,
    member.groupNickname,
    member.nickname,
    member.wxid
  )
}
