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
