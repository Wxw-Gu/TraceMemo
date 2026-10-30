import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Wcdb4Client } from '../../src/main/wcdb4-client'

describe('WCDB voice media shards', () => {
  const roots: string[] = []
  const databases: DatabaseSync[] = []
  const session = "wxid_fixture'peer"
  const serverId = '1234567890123456789'
  const createTime = 1_790_000_000
  const localId = 42
  const audio = Buffer.from('02532345', 'hex')

  afterEach(() => {
    databases.splice(0).forEach((db) => db.close())
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  })

  function fixture(nativeHex = '', nativeCode = 0) {
    const root = mkdtempSync(join(tmpdir(), 'wcdb-voice-shards-'))
    roots.push(root)
    const messageRoot = join(root, 'message')
    mkdirSync(messageRoot)
    const stores = new Map<string, DatabaseSync>()
    for (const name of ['media_0.db', 'media_1.db']) {
      const dbPath = join(messageRoot, name)
      const db = new DatabaseSync(dbPath)
      databases.push(db)
      db.exec(`
        CREATE TABLE Name2Id(user_name TEXT PRIMARY KEY);
        CREATE TABLE VoiceInfo(chat_name_id INTEGER, create_time INTEGER, local_id INTEGER, svr_id INTEGER, voice_data BLOB);
      `)
      db.prepare('INSERT INTO Name2Id VALUES (?)').run(session)
      db.prepare('INSERT INTO Name2Id VALUES (?)').run('other-session')
      stores.set(dbPath, db)
    }
    writeFileSync(join(messageRoot, 'media_0 (SFConflict).db'), '')
    const query = vi.fn(async (_fn, _kind, dbPath: string, sql: string) => {
      const db = stores.get(dbPath)
      if (!db) throw new Error('Unexpected media shard')
      return db.prepare(sql).all()
    })
    const freeString = vi.fn()
    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      dbStoragePath: root,
      wcdbGetVoiceData: {
        async: (...args: unknown[]) => {
          ;(args.at(-2) as [unknown])[0] = {}
          ;(args.at(-1) as (error: unknown, code: number) => void)(null, nativeCode)
        }
      },
      wcdbExecQuery: vi.fn(),
      wcdbFreeString: freeString,
      callJsonAsync: query,
      decodeHexPtr: () => nativeHex,
      handle: 1,
      closing: false,
      nativeCallsInFlight: new Set()
    }) as Wcdb4Client
    const insert = (shard: number, chat: number, id: number, svr: string, bytes = audio) => {
      stores
        .get(join(messageRoot, `media_${shard}.db`))!
        .prepare('INSERT INTO VoiceInfo VALUES (?, ?, ?, ?, ?)')
        .run(chat, createTime, id, BigInt(svr), bytes)
    }
    return { client, query, freeString, insert }
  }

  it.each([0, -3003])(
    'reads a later shard when native lookup returns empty data or fails (%s)',
    async (code) => {
      const { client, query, freeString, insert } = fixture('', code)
      insert(0, 1, localId, '1234567890123456790', Buffer.from('bad1', 'hex'))
      insert(0, 2, localId, serverId, Buffer.from('bad2', 'hex'))
      insert(0, 1, localId, serverId, Buffer.alloc(0))
      insert(1, 1, localId, serverId)

      await expect(
        client.getVoiceData(session, createTime, [session], localId, serverId)
      ).resolves.toEqual({ success: true, hex: audio.toString('hex'), error: '' })
      expect(query).toHaveBeenCalledTimes(2)
      expect(freeString).toHaveBeenCalledOnce()
    }
  )

  it('uses both local id and time within the session when no server id is available', async () => {
    const { client, insert } = fixture()
    insert(0, 1, localId + 1, '123')
    insert(0, 2, localId, '456')
    insert(1, 1, localId, '789')

    await expect(
      client.getVoiceData(session, createTime, [session], localId)
    ).resolves.toMatchObject({ success: true, hex: audio.toString('hex') })
    await expect(
      client.getVoiceData(session, createTime + 1, [session], localId)
    ).resolves.toMatchObject({ success: false })
  })

  it('does not substitute another message when the known server id is missing', async () => {
    const { client, insert } = fixture()
    insert(0, 1, localId, '1234567890123456790')

    await expect(
      client.getVoiceData(session, createTime, [session], localId, serverId)
    ).resolves.toEqual({ success: false, error: '语音数据为空' })
  })

  it('continues after an unreadable shard', async () => {
    const { client, query, insert } = fixture()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    query.mockRejectedValueOnce(new Error('unreadable shard'))
    insert(1, 1, localId, serverId)

    await expect(
      client.getVoiceData(session, createTime, [session], localId, serverId)
    ).resolves.toMatchObject({ success: true, hex: audio.toString('hex') })
  })

  it('skips SQL when native lookup succeeds or the message identity is incomplete', async () => {
    const successful = fixture('aabb')
    await expect(
      successful.client.getVoiceData(session, createTime, [], localId, serverId)
    ).resolves.toMatchObject({ success: true, hex: 'aabb' })
    expect(successful.query).not.toHaveBeenCalled()

    const missing = fixture()
    await expect(missing.client.getVoiceData(session, createTime, [])).resolves.toMatchObject({
      success: false
    })
    expect(missing.query).not.toHaveBeenCalled()
  })
})
