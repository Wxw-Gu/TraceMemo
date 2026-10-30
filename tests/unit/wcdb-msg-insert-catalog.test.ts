import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Wcdb4Client } from '../../src/main/wcdb4-client'
import { readMsgInsertSwitches } from '../../src/main/services/msg-insert-switch-service'

vi.mock('../../src/main/resource-paths', () => ({
  getResourceRoots: () => [],
  findResource: () => null
}))

describe('message insert shard catalog', () => {
  const roots: string[] = []
  const room = 'fixture-group@chatroom'
  const hash = createHash('md5').update(room).digest('hex')
  const table = `Msg_${hash}`
  const capture = `_tm_msg_insert_capture_${hash}`

  afterEach(() => {
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  })

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'wcdb-insert-catalog-'))
    roots.push(root)
    const messageRoot = join(root, 'message')
    mkdirSync(messageRoot)
    for (const name of ['message_0.db', 'message_1.db']) {
      const db = new DatabaseSync(join(messageRoot, name))
      try {
        db.exec(`CREATE TABLE ${table}(content TEXT);`)
        if (name === 'message_0.db') {
          db.exec(`
            CREATE TABLE _tm_config(key TEXT PRIMARY KEY, value INTEGER);
            CREATE TRIGGER ${capture} AFTER INSERT ON ${table} BEGIN SELECT 1; END;
          `)
        }
      } finally {
        db.close()
      }
    }
    for (const name of ['media_0.db', 'message_0 (SFConflict).db', 'message_0.db-wal']) {
      writeFileSync(join(messageRoot, name), '')
    }
    const nativeCatalog = vi.fn(() => {
      throw new Error('unsafe native catalog called')
    })
    const query = vi.fn((_handle, kind, dbPath: string, sql: string, out: unknown[]) => {
      expect(kind).toBe('message')
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        out[0] = db.prepare(sql).all()
      } finally {
        db.close()
      }
      return 0
    })
    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      dbStoragePath: root,
      wcdbMsgInsertListShardCatalog: nativeCatalog,
      wcdbExecQuery: query,
      callJson: (call: (handle: number, out: unknown[]) => number) => {
        const out: unknown[] = [null]
        call(1, out)
        return out[0]
      },
      getSessions: () => [{ username: room }],
      getMsgInsertSwitches: () => ({ success: true, switches: { recall_notice: true } })
    }) as Wcdb4Client
    return { client, nativeCatalog, query, messageRoot }
  }

  it('reads tables and trigger attachments through read-only SQL without the crashing native API', () => {
    const { client, nativeCatalog, query, messageRoot } = fixture()

    expect(client.listMsgInsertShardCatalog()).toEqual({
      success: true,
      catalog: {
        shardCount: 2,
        shards: [
          {
            shard: 'message_0.db',
            dbPath: join(messageRoot, 'message_0.db'),
            configTable: true,
            tables: [table, '_tm_config'],
            rules: [{ name: capture, table }]
          },
          {
            shard: 'message_1.db',
            dbPath: join(messageRoot, 'message_1.db'),
            configTable: false,
            tables: [table],
            rules: []
          }
        ]
      }
    })
    expect(nativeCatalog).not.toHaveBeenCalled()
    expect(query.mock.calls.map((call) => basename(call[2]))).toEqual([
      'message_0.db',
      'message_1.db'
    ])
  })

  it('preserves the rule coverage calculation across shards', () => {
    const { client } = fixture()

    const snapshot = readMsgInsertSwitches({ client, monitoredRoomIds: [] })
    expect(snapshot.success).toBe(true)
    expect(snapshot.switches.recall_notice).toMatchObject({
      desiredEnabled: true,
      effectiveEnabled: false,
      totalShards: 2,
      totalInstallableRooms: 1,
      readyInstallableRooms: 0,
      notReadyRooms: [{ roomId: room, notReadyShards: ['message_1.db'] }]
    })
  })

  it('reports a query failure instead of returning a partial catalog', () => {
    const { client, query } = fixture()
    query.mockImplementationOnce(() => {
      throw new Error('fixture shard unavailable')
    })

    expect(client.listMsgInsertShardCatalog()).toEqual({
      success: false,
      error: 'fixture shard unavailable'
    })
  })

  it('reports an unsupported SQL channel without calling the unsafe native API', () => {
    const { client, nativeCatalog } = fixture()
    Reflect.set(client, 'wcdbExecQuery', null)

    expect(client.listMsgInsertShardCatalog()).toMatchObject({ success: false })
    expect(nativeCatalog).not.toHaveBeenCalled()
  })
})
