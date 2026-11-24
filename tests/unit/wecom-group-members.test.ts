import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Wcdb4Client, Wcdb4GroupMember } from '../../src/main/wcdb4-client'

/** Synthetic group/member rows only — no real ids or content. */
describe(`enterprise group name and member mapping`, () => {
  let root: string
  let client: Wcdb4Client
  type IdsFn = (rows: Record<string, unknown>[] | null | undefined) => string[]
  type MembersFn = (ids: string[], rows: Record<string, unknown>[] | null | undefined) => Wcdb4GroupMember[]
  let memberIds: IdsFn
  let membersFromRows: MembersFn

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), `wxe-wecom-members-`))
    const account = join(root, `fixture-account`)
    const dbStorage = join(account, `db_storage`)
    mkdirSync(join(dbStorage, `session`), { recursive: true })
    writeFileSync(join(dbStorage, `session`, `session.db`), ``)
    client = new Wcdb4Client(`00`, account)
    const impl = client as unknown as { enterpriseMemberIdsFromRows: IdsFn; enterpriseMembersFromRows: MembersFn }
    memberIds = impl.enterpriseMemberIdsFromRows.bind(client)
    membersFromRows = impl.enterpriseMembersFromRows.bind(client)
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it(`parses the semicolon-delimited user_list and de-duplicates`, () => {
    expect(memberIds([{ user_list: `wwfixture_user_a@qy_u; wwfixture_user_b@qy_u;;wwfixture_user_a@qy_u ` }])).toEqual([
      `wwfixture_user_a@qy_u`,
      `wwfixture_user_b@qy_u`,
    ])
    expect(memberIds([])).toEqual([])
    expect(memberIds(null)).toEqual([])
  })

  it(`distinguishes a failed enterprise member read from a genuinely empty group`, async () => {
    const stub = (impl: Record<string, unknown>) => {
      impl.wcdbExecQuery = () => 0
      return impl
    }

    const failed = new Wcdb4Client(`00`, join(root, `fixture-account`))
    const failedImpl = stub(failed as unknown as Record<string, unknown>)
    failedImpl.callJson = () => {
      throw new Error(`fixture native failure`)
    }
    failedImpl.callJsonAsync = () => Promise.reject(new Error(`fixture native failure`))
    expect(failed.getEnterpriseGroupMembers(`fixture@qy_g`)).toBeNull()
    await expect(failed.getEnterpriseGroupMembersAsync(`fixture@qy_g`)).resolves.toBeNull()

    const empty = new Wcdb4Client(`00`, join(root, `fixture-account`))
    const emptyImpl = stub(empty as unknown as Record<string, unknown>)
    emptyImpl.callJson = () => []
    emptyImpl.callJsonAsync = () => Promise.resolve([])
    expect(empty.getEnterpriseGroupMembers(`fixture@qy_g`)).toEqual([])
    await expect(empty.getEnterpriseGroupMembersAsync(`fixture@qy_g`)).resolves.toEqual([])

    const unavailable = new Wcdb4Client(`00`, join(root, `fixture-account`))
    expect(unavailable.getEnterpriseGroupMembers(`fixture@qy_g`)).toBeNull()
  })

  it(`resolves an enterprise group name on a cold cache without waiting for hydration`, () => {
    const client = new Wcdb4Client(`00`, join(root, `fixture-account`))
    const impl = client as unknown as Record<string, unknown>
    impl.wcdbExecQuery = () => 0
    let calls = 0
    impl.callJson = () => {
      calls += 1
      return [{ chat_name: `fixture group name` }]
    }

    // 冷缓存：同步快照路径第一次取群名就必须拿到真实群名，而不是 raw username。
    expect(client.getEnterpriseGroupName(`fixture@qy_g`)).toBe(`fixture group name`)
    // 第二次命中缓存，不再打库。
    expect(client.getEnterpriseGroupName(`fixture@qy_g`)).toBe(`fixture group name`)
    expect(calls).toBe(1)

    // 非企业会话不参与该通道。
    expect(client.getEnterpriseGroupName(`fixture@chatroom`)).toBe(``)
  })

  it(`gives the sync session list the same enterprise group name as hydration`, () => {
    const client = new Wcdb4Client(`00`, join(root, `fixture-account`))
    const impl = client as unknown as Record<string, unknown>
    impl.wcdbExecQuery = () => 0
    impl.wcdbGetSessions = () => 0
    let calls = 0
    impl.callJson = () => {
      calls += 1
      return [{ chat_name: `fixture group name` }]
    }
    impl.callJsonAsync = () => Promise.resolve([{ chat_name: `fixture group name` }])
    impl.readSessionRows = () => [
      { username: `fixture@qy_g`, nickname: `fixture@qy_g`, sort_timestamp: 1 },
      { username: `fixture@qy_u`, nickname: `fixture single chat`, sort_timestamp: 2 }
    ]

    // 冷启动：同步列表第一次就显示真实群名，不出现 raw username。
    const sessions = client.getSessions()
    expect(sessions.find((item) => item.username === `fixture@qy_g`)?.nickname).toBe(
      `fixture group name`
    )
    // 企业单聊不走群名通道，保持自己的昵称。
    expect(sessions.find((item) => item.username === `fixture@qy_u`)?.nickname).toBe(
      `fixture single chat`
    )
    expect(calls).toBe(1)
  })

  it(`maps user_info rows to member display names`, () => {
    const members = membersFromRows(
      [`wwfixture_user_a@qy_u`, `wwfixture_user_b@qy_u`],
      [{ user_id: `wwfixture_user_a@qy_u`, user_name: `fixture member A` }]
    )
    expect(members).toHaveLength(2)
    expect(members[0].nickname).toBe(`fixture member A`)
    expect(members[1].nickname).toBe(`wwfixture_user_b@qy_u`)
  })
})
