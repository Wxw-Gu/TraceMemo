import fs from 'fs-extra'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveWindowsNativeAccountRoot,
  Wcdb4Client,
  type Wcdb4Message
} from '../../src/main/wcdb4-client'

const message = (id: string, year: number, serverId = `server-${id}`): Wcdb4Message => ({
  mesLocalID: id,
  serverId,
  mesDes: 0,
  messageType: '1',
  msgCreateTime: String(Math.floor(Date.UTC(year, 0, 1) / 1000)),
  msgContent: `fixture-${year}`,
  raw: {}
})

describe('WCDB message shard pagination', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.removeSync(directory)
  })

  it('keeps messages whose local ids repeat across database shards', async () => {
    const cursor = vi.fn(async () => [
      message('1', 2024, 'server-2024'),
      message('1', 2025, 'server-2025')
    ])
    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      getMessagesByCursorAsync: cursor
    }) as Wcdb4Client

    const result = await client.getMessagesAsync('fixture@chatroom')

    expect(result).toHaveLength(2)
    expect(result.map((item) => item.serverId)).toEqual(['server-2024', 'server-2025'])
  })

  it('merges cursor and all-store rows for a bounded cross-year page', async () => {
    const cursor = vi.fn(async () => [message('2025', 2025)])
    const tableScan = vi.fn(async () => [message('2017', 2017), message('2025', 2025)])
    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      wcdbGetMessageTableStats: vi.fn(),
      wcdbExecQuery: vi.fn(),
      getMessagesByCursorAsync: cursor,
      getMessagesByTableScanAsync: tableScan
    }) as Wcdb4Client

    const result = await client.getMessagesAsync(
      'fixture@chatroom',
      undefined,
      Math.floor(Date.UTC(2026, 0, 1) / 1000),
      { limit: 20 }
    )

    expect(tableScan).toHaveBeenCalledOnce()
    expect(result.map((item) => item.msgContent)).toEqual(['fixture-2017', 'fixture-2025'])
  })

  it('reports an unsupported shard query instead of claiming history ended', async () => {
    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      getMessagesByCursorAsync: vi.fn(async () => [])
    }) as Wcdb4Client

    await expect(
      client.getMessagesAsync('fixture@chatroom', undefined, 1_767_225_600, { limit: 20 })
    ).rejects.toThrow('无法检查历史消息分片')
  })

  it('falls back to biz_message shards for official-account sessions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wxe-biz-shards-'))
    temporaryDirectories.push(root)
    const messageRoot = path.join(root, 'db_storage', 'message')
    fs.ensureDirSync(messageRoot)
    const bizDbPath = path.join(messageRoot, 'biz_message_0.db')
    fs.writeFileSync(bizDbPath, '')

    const client = Object.assign(Object.create(Wcdb4Client.prototype), {
      dbStoragePath: path.join(root, 'db_storage'),
      wcdbGetMessageTableStats: null,
      wcdbExecQuery: vi.fn(),
      callJson: vi.fn(() => [{ name: 'Msg_19cde0e21f4f938ca1fcebd7146dbbd2' }])
    }) as Wcdb4Client

    const stores = Reflect.get(client, 'listMessageStores').call(client, 'gh_23069e016533')

    expect(stores).toEqual([
      {
        tableName: 'Msg_19cde0e21f4f938ca1fcebd7146dbbd2',
        dbPath: bizDbPath
      }
    ])
  })

  it('creates a stable ASCII junction for a Windows account path containing Chinese', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wxe-path-bridge-'))
    temporaryDirectories.push(root)
    const publicRoot = path.join(root, 'Public')
    const accountRoot = path.join(root, '微信聊天记录', 'wxid_fixture')
    fs.ensureDirSync(path.join(accountRoot, 'db_storage'))

    const first = resolveWindowsNativeAccountRoot(accountRoot, {
      platform: 'win32',
      publicRoot
    })
    const second = resolveWindowsNativeAccountRoot(accountRoot, {
      platform: 'win32',
      publicRoot
    })

    expect(first).toBe(second)
    expect(first).not.toContain('微信聊天记录')
    expect(first).toContain(path.join('TraceMemo', 'path-bridges'))
    expect(fs.realpathSync(first)).toBe(fs.realpathSync(accountRoot))
  })

  it('reuses an existing legacy Windows path bridge without creating a new one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wxe-legacy-path-bridge-'))
    temporaryDirectories.push(root)
    const publicRoot = path.join(root, 'Public')
    const accountRoot = path.join(root, '微信聊天记录', 'wxid_legacy')
    fs.ensureDirSync(path.join(accountRoot, 'db_storage'))
    const bridgeId = crypto
      .createHash('sha256')
      .update(path.resolve(accountRoot).toLowerCase())
      .digest('hex')
      .slice(0, 24)
    const legacyBridge = path.join(publicRoot, 'WechatExplorer', 'path-bridges', bridgeId)
    fs.ensureDirSync(path.dirname(legacyBridge))
    fs.symlinkSync(accountRoot, legacyBridge, 'junction')

    expect(resolveWindowsNativeAccountRoot(accountRoot, { platform: 'win32', publicRoot })).toBe(
      legacyBridge
    )
    expect(fs.existsSync(path.join(publicRoot, 'TraceMemo'))).toBe(false)
  })
})
