import { describe, expect, it } from 'vitest'
import { isEnterpriseSession, isGroupSession } from '../../src/shared/wechat-identities'

/** Synthetic conversation IDs only — no real wxid, corp id, or group name. */
describe(`wechat identity classification`, () => {
  it(`recognizes enterprise group and direct sessions`, () => {
    expect(isGroupSession(`wwfixture_corp123_room1@qy_g`)).toBe(true)
    expect(isEnterpriseSession(`wwfixture_corp123_room1@qy_g`)).toBe(true)
    expect(isEnterpriseSession(`wwfixture_corp123_user1@qy_u`)).toBe(true)
    expect(isGroupSession(`wwfixture_corp123_user1@qy_u`)).toBe(false)
  })

  it(`preserves ordinary friend, group, and official-account classification`, () => {
    expect(isGroupSession(`123456@chatroom`)).toBe(true)
    expect(isGroupSession(`wxid_fixture_friend`)).toBe(false)
    expect(isEnterpriseSession(`wxid_fixture_friend`)).toBe(false)
    expect(isEnterpriseSession(`gh_fixture_account`)).toBe(false)
    expect(isEnterpriseSession(`123456@chatroom`)).toBe(false)
  })

  it(`tolerates empty and whitespace-padded values`, () => {
    expect(isGroupSession(undefined)).toBe(false)
    expect(isGroupSession(null)).toBe(false)
    expect(isGroupSession(`   `)).toBe(false)
    expect(isEnterpriseSession(`  wwfixture_corp_room@qy_g  `)).toBe(true)
  })
})
