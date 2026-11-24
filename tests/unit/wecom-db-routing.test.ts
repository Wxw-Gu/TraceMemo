import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isEnterpriseSession } from '../../src/shared/wechat-identities'
import { Wcdb4Client } from '../../src/main/wcdb4-client'

/**
 * Synthetic shard filenames only: no real databases, keys, wxids, or content.
 * Wcdb4Client is constructed against an empty temporary account root and the
 * private discovery method is reached without opening any native database.
 */
describe(`enterprise message database routing`, () => {
  let root: string
  let client: Wcdb4Client

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), `wxe-wecom-routing-`))
    const account = join(root, `fixture-account`)
    const dbStorage = join(account, `db_storage`)
    mkdirSync(join(dbStorage, `message`), { recursive: true })
    mkdirSync(join(dbStorage, `session`), { recursive: true })
    writeFileSync(join(dbStorage, `session`, `session.db`), ``)
    const shards = [`message_0.db`, `message_1.db`, `biz_message_0.db`, `biz_message_1.db`]
    for (const name of shards) writeFileSync(join(dbStorage, `message`, name), ``)
    client = new Wcdb4Client(`00`, account)
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  function route(username: string): string[] {
    return (client as unknown as { getMessageDatabasePaths(u: string): string[] })
      .getMessageDatabasePaths(username)
  }

  function names(username: string): string[] {
    return route(username).map((p) => p.split(`/`).pop() || ``)
  }

  it(`routes enterprise group and direct sessions to biz_message shards`, () => {
    expect(isEnterpriseSession(`wwfixture_corp_user@qy_u`)).toBe(true)
    expect(names(`wwfixture_corp_room@qy_g`)).toEqual([`biz_message_0.db`, `biz_message_1.db`])
    expect(names(`wwfixture_corp_user@qy_u`)).toEqual([`biz_message_0.db`, `biz_message_1.db`])
  })

  it(`keeps ordinary sessions on the message shards`, () => {
    expect(names(`wxid_fixture_friend`)).toEqual([`message_0.db`, `message_1.db`])
    expect(names(`12345@chatroom`)).toEqual([`message_0.db`, `message_1.db`])
  })
})
