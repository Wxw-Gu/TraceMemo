import { describe, expect, it } from 'vitest'
import {
  buildReportAvatarAliasIndex,
  mergeReportAvatars,
  REPORT_AVATAR_ALIAS_FIELDS,
  type ReportAvatarMember
} from '../../src/shared/group-report'

/**
 * 「日报头像 enrichment 死代码」的回归。
 *
 * 两条独立缺陷：
 * 1. `enrichAvatarsFromGroup` 的首行 `if (!metadata.talker) return` 恒真 —— 没有调用方写过 talker，
 *    整段 enrichment 从未执行（由 `group-report-facts` 侧补 talker 修复）。
 * 2. 即使执行了，索引键只有 `member.nickname`（= `wechatNickname || groupNickname || wxid`），
 *    而报告显示名默认是**群昵称**。成员同时有微信昵称与群昵称且不同时，索引全部对不上，
 *    头像照样退化成首字 —— 这里锁死"多别名 + 不覆盖调用方头像"的语义。
 */

const AVATAR_A = 'http://wx.qlogo.cn/mmhead/a/0'
const AVATAR_B = 'http://wx.qlogo.cn/mmhead/b/0'

const member = (patch: Partial<ReportAvatarMember> & { wxid: string }): ReportAvatarMember => ({
  nickname: '',
  groupNickname: '',
  wechatNickname: '',
  remark: '',
  avatar: '',
  ...patch
})

describe('buildReportAvatarAliasIndex — 显示名索引错位', () => {
  it('微信昵称与群昵称不同时，两个名字都能取到头像', () => {
    const index = buildReportAvatarAliasIndex([
      member({
        wxid: 'wxid_a',
        // 快照的 nickname 是 wechatNickname 优先 —— 报告显示名却是群昵称
        nickname: '阿哲',
        wechatNickname: '阿哲',
        groupNickname: '阿哲(技术)',
        avatar: AVATAR_A
      })
    ])
    // 报告默认按群昵称显示 → 必须命中
    expect(index.get('阿哲(技术)')).toBe(AVATAR_A)
    // 切到「微信昵称」模式时也要命中
    expect(index.get('阿哲')).toBe(AVATAR_A)
  })

  it('覆盖全部别名维度（含备注与 wxid）', () => {
    const index = buildReportAvatarAliasIndex([
      member({
        wxid: 'wxid_b',
        nickname: 'nick',
        groupNickname: '群昵称',
        wechatNickname: '微信昵称',
        remark: '备注名',
        avatar: AVATAR_B
      })
    ])
    for (const alias of ['nick', '群昵称', '微信昵称', '备注名', 'wxid_b']) {
      expect(index.get(alias), alias).toBe(AVATAR_B)
    }
    expect(REPORT_AVATAR_ALIAS_FIELDS).toHaveLength(5)
  })

  it('没有头像的成员不进索引 —— 避免用空值把别的成员头像覆盖掉', () => {
    const index = buildReportAvatarAliasIndex([
      member({ wxid: 'wxid_c', nickname: '空空', groupNickname: '空空', avatar: '' })
    ])
    expect(index.size).toBe(0)
  })

  it('空字符串别名不进索引', () => {
    const index = buildReportAvatarAliasIndex([
      member({ wxid: 'wxid_d', nickname: '', groupNickname: '  ', avatar: AVATAR_A })
    ])
    expect([...index.keys()]).toEqual(['wxid_d'])
  })

  it('同名先到先得，后到的成员不覆盖', () => {
    const index = buildReportAvatarAliasIndex([
      member({ wxid: 'wxid_e1', groupNickname: '小明', avatar: AVATAR_A }),
      member({ wxid: 'wxid_e2', groupNickname: '小明', avatar: AVATAR_B })
    ])
    expect(index.get('小明')).toBe(AVATAR_A)
  })
})

describe('mergeReportAvatars — 不覆盖调用方已给出的有效头像', () => {
  it('已有头像保留，只补缺失的别名', () => {
    const avatars: Record<string, string | undefined> = {
      群昵称: 'http://from-caller/keep.jpg'
    }
    const index = buildReportAvatarAliasIndex([
      member({
        wxid: 'wxid_f',
        nickname: '微信昵称',
        groupNickname: '群昵称',
        wechatNickname: '微信昵称',
        avatar: AVATAR_A
      })
    ])
    const filled = mergeReportAvatars(avatars, index)

    expect(avatars['群昵称']).toBe('http://from-caller/keep.jpg')
    expect(avatars['微信昵称']).toBe(AVATAR_A)
    expect(avatars['wxid_f']).toBe(AVATAR_A)
    expect(filled).toBe(2)
  })

  it('空字符串视为缺失，允许补齐', () => {
    const avatars: Record<string, string | undefined> = { 群昵称: '' }
    const index = buildReportAvatarAliasIndex([
      member({ wxid: 'wxid_g', groupNickname: '群昵称', avatar: AVATAR_B })
    ])
    mergeReportAvatars(avatars, index)
    expect(avatars['群昵称']).toBe(AVATAR_B)
  })
})
