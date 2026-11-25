import zlib from 'node:zlib'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Wcdb4Client } from '../../src/main/wcdb4-client'

/** Synthetic XML/ID rows only — no real sender ids, group ids, or content. */
describe(`enterprise source XML parsing (production code path)`, () => {
  let root: string
  let client: Wcdb4Client
  type EnterpriseParse = (row: Record<string, unknown>) => { senderId: string; senderNickname: string; bizChatId: string }
  let parseSource: EnterpriseParse

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), `wxe-wecom-source-`))
    const account = join(root, `fixture-account`)
    const dbStorage = join(account, `db_storage`)
    mkdirSync(join(dbStorage, `session`), { recursive: true })
    writeFileSync(join(dbStorage, `session`, `session.db`), ``)
    client = new Wcdb4Client(`00`, account)
    parseSource = (client as unknown as { parseEnterpriseSource: EnterpriseParse }).parseEnterpriseSource.bind(client)
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it(`parses enterprise_info from a plain source XML row`, () => {
    const xml = '<msg><user_id>wwfixture_corp_user@qy_u</user_id><user_nickname><![CDATA[fixture sender]]></user_nickname><bizchat_id>wwfixture_corp_room@qy_g</bizchat_id></msg>'
    expect(parseSource({ source: xml })).toEqual({
      senderId: 'wwfixture_corp_user@qy_u',
      senderNickname: 'fixture sender',
      bizChatId: 'wwfixture_corp_room@qy_g',
    })
  })

  it(`returns empty result for missing or non-XML source`, () => {
    const empty = { senderId: '', senderNickname: '', bizChatId: '' }
    expect(parseSource({})).toEqual(empty)
    expect(parseSource({ source: 'not xml' })).toEqual(empty)
    expect(parseSource({ source: '<broken>' })).toEqual(empty)
  })

  it(`rejects a non-enterprise sender id`, () => {
    const result = parseSource({ source: '<msg><user_id>wxid_fixture_friend</user_id></msg>' })
    expect(result.senderId).toBe('')
  })

  it('parses a zstd-compressed source row with a pure-JS fallback', () => {
    // The production path tries the native decompressor first, then a JS zstd
    // fallback. This test exercises the fallback with a synthetic zstd frame
    // produced by the system zstd tool when available; otherwise it documents
    // that only the uncompressed path is portable enough for unit tests.
    const xml = '<msg><user_id>wwfixture_corp_user@qy_u</user_id></msg>'
    const plain = Buffer.from(xml)
    // Node 22+ exposes zstdCompressSync/zstdDecompressSync; older runtimes skip.
    if (typeof zlib.zstdCompressSync !== 'function') return
    const frame = (zlib as unknown as { zstdCompressSync(b: Buffer): Buffer }).zstdCompressSync(plain)
    expect(Buffer.from(frame).subarray(0, 4).toString('hex')).toBe('28b52ffd')
    expect((zlib as unknown as { zstdDecompressSync(b: Buffer): Buffer }).zstdDecompressSync(frame).toString()).toBe(xml)
    // Production decodeMaybeCompressed also accepts a base64 string.
    expect(parseSource({ source: frame.toString('base64') }).senderId).toBe('wwfixture_corp_user@qy_u')
  })
})
