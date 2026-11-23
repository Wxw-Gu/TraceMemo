import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { selectMessageLocation, Wcdb4Client, Wcdb4Message } from '../../src/main/wcdb4-client'

/** Synthetic cross-shard hits only — no real ids, keys, or content. */
describe(`enterprise message de-duplication`, () => {
  let root: string
  let client: Wcdb4Client
  type Merger = (current: Wcdb4Message[], recovered: Wcdb4Message[], limit?: number) => Wcdb4Message[]
  let mergeRows: Merger

  const msg = (serverId: string, content: string, time: number, extra: Partial<Wcdb4Message> = {}): Wcdb4Message => ({
    mesLocalID: `100`,
    serverId,
    mesDes: 0,
    messageType: `1`,
    msgCreateTime: String(time),
    msgContent: content,
    raw: {},
    ...extra,
  })

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), `wxe-wecom-dedup-`))
    const account = join(root, `fixture-account`)
    const dbStorage = join(account, `db_storage`)
    mkdirSync(join(dbStorage, `session`), { recursive: true })
    writeFileSync(join(dbStorage, `session`, `session.db`), ``)
    client = new Wcdb4Client(`00`, account)
    mergeRows = (client as unknown as { mergeMessageRows: Merger }).mergeMessageRows.bind(client)
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it(`deduplicates enterprise messages by server id across snapshots`, () => {
    const a = msg(`srv-1001`, `fixture text A`, 1000, { sender: `wwfixture_user@qy_u` })
    const b = msg(`srv-1001`, `fixture text A`, 1000, { senderNickname: `fixture sender` })
    const merged = mergeRows([a], [b])
    expect(merged).toHaveLength(1)
    expect(merged[0].sender).toBe(`wwfixture_user@qy_u`)
    expect(merged[0].senderNickname).toBe(`fixture sender`)
  })

  it(`keeps distinct enterprise messages separate`, () => {
    const a = msg(`srv-2001`, `fixture text 1`, 2000)
    const b = msg(`srv-2002`, `fixture text 2`, 2001)
    expect(mergeRows([a], [b])).toHaveLength(2)
  })

  it(`resolves a unique cross-shard message by time`, () => {
    const hits = [
      { createTime: 1000, localId: 1 },
      { createTime: 1000, localId: 2 },
      { createTime: 2000, localId: 3 },
    ]
    expect(selectMessageLocation(hits, 2000)).toEqual({ status: `found`, location: hits[2] })
    expect(selectMessageLocation(hits, 1000).status).toBe(`ambiguous`)
    expect(selectMessageLocation(hits, null).status).toBe(`ambiguous`)
  })
})
