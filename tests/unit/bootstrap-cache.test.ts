import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  statSync,
  chmodSync,
  existsSync
} from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import fsExtra from 'fs-extra'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Contact, Message } from '../../src/shared/types'

const userData = mkdtempSync(join(tmpdir(), 'wxe-bootstrap-test-'))

vi.mock('electron', () => ({
  app: { getPath: () => userData }
}))

import {
  clearBootstrapCache,
  flushBootstrapCacheWritesSync,
  getBootstrapCache,
  getCachedMessages,
  mergeBootstrapAvatars,
  mergeCachedSelfInfo,
  saveBootstrapContacts,
  saveBootstrapSelf,
  saveCachedGroupSnapshot,
  saveCachedMessages
} from '../../src/main/services/bootstrap-cache'

const accountRoot = 'fixture-account-root'
const contact: Contact = {
  m_nsUsrName: 'fixture-user',
  m_nsNickName: '脱敏联系人',
  md5: 'fixture-md5',
  type: 'user'
}

function findFile(name: string): string {
  const visit = (directory: string): string | null => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) {
        const nested = visit(file)
        if (nested) return nested
      } else if (entry.name === name) return file
    }
    return null
  }
  const result = visit(userData)
  if (!result) throw new Error(`${name} was not written`)
  return result
}

describe('bootstrap cache', () => {
  beforeAll(() => rmSync(userData, { recursive: true, force: true }))
  beforeEach(() => clearBootstrapCache())
  afterAll(() => rmSync(userData, { recursive: true, force: true }))

  it('persists contacts and caps each message bucket', () => {
    saveBootstrapContacts(accountRoot, [contact])
    const messages: Message[] = Array.from({ length: 140 }, (_, index) => ({
      id: String(index),
      from: 'user',
      type: '文本',
      datetime: '2026-08-01 10:00:00',
      content: `fixture-${index}`,
      isSender: false,
      createTime: index + 1
    }))
    saveCachedMessages(accountRoot, contact.md5, undefined, undefined, messages)
    flushBootstrapCacheWritesSync()
    clearBootstrapCache()

    expect(getBootstrapCache(accountRoot)?.contacts).toEqual([contact])
    const cached = getCachedMessages(accountRoot, contact.md5)
    expect(cached).toHaveLength(120)
    expect(cached[0].id).toBe('20')
  })

  it('degrades to a cache miss when persisted JSON is corrupted', () => {
    saveBootstrapContacts(accountRoot, [contact])
    flushBootstrapCacheWritesSync()
    const startup = findFile('startup.json')
    expect(readFileSync(startup, 'utf8')).toContain('fixture-user')
    writeFileSync(startup, '{broken', 'utf8')
    clearBootstrapCache()
    expect(getBootstrapCache(accountRoot)).toBeNull()
  })

  it('reuses a hydrated contact nickname when cached self info only contains the account id', () => {
    const selfRoot = '/fixture/fixture_account_1a2b'
    saveBootstrapContacts(selfRoot, [
      {
        m_nsUsrName: 'fixture_account',
        m_nsNickName: '示例昵称',
        md5: 'self-md5',
        type: 'user'
      }
    ])
    saveBootstrapSelf(selfRoot, {
      wxid: 'fixture_account',
      nickname: 'fixture_account',
      accountRoot: selfRoot
    })

    expect(
      mergeCachedSelfInfo(selfRoot, {
        wxid: 'fixture_account',
        nickname: 'fixture_account',
        accountRoot: selfRoot
      }).nickname
    ).toBe('示例昵称')
  })

  it('migrates the previous startup cache so account discovery can show identity before unlock', () => {
    const legacyRoot = '/fixture/legacy-account'
    const digest = createHash('sha1')
      .update(`${process.platform}:${legacyRoot}`)
      .digest('hex')
      .slice(0, 16)
    const legacyFile = join(userData, 'cache', 'bootstrap', `${process.platform}-${digest}.json`)
    mkdirSync(join(userData, 'cache', 'bootstrap'), { recursive: true })
    writeFileSync(
      legacyFile,
      JSON.stringify({
        version: 1,
        platform: process.platform,
        accountRoot: legacyRoot,
        updatedAt: Date.now(),
        self: {
          wxid: 'wxid_legacy',
          nickname: '缓存昵称',
          avatar: 'data:image/png;base64,fixture',
          accountRoot: legacyRoot
        },
        contacts: []
      }),
      'utf8'
    )

    clearBootstrapCache()
    expect(getBootstrapCache(legacyRoot)?.self).toMatchObject({
      wxid: 'wxid_legacy',
      nickname: '缓存昵称',
      avatar: 'data:image/png;base64,fixture'
    })
    flushBootstrapCacheWritesSync()
  })

  it('preserves known group nicknames when a refresh only returns contact nicknames', () => {
    const groupRoot = '/fixture/group-account'
    const first = {
      roomId: 'fixture@chatroom',
      memberCount: 1,
      members: [
        {
          wxid: 'wxid-member',
          nickname: '群内昵称',
          groupNickname: '群内昵称',
          wechatNickname: '通讯录昵称',
          remark: '',
          avatar: ''
        }
      ]
    }
    const refreshed = {
      ...first,
      members: [{ ...first.members[0], nickname: '通讯录昵称', groupNickname: '通讯录昵称' }]
    }

    saveCachedGroupSnapshot(groupRoot, 'fixture-md5', first)
    flushBootstrapCacheWritesSync()
    clearBootstrapCache()
    const merged = saveCachedGroupSnapshot(groupRoot, 'fixture-md5', refreshed)

    expect(merged.members[0]).toMatchObject({
      nickname: '群内昵称',
      groupNickname: '群内昵称',
      wechatNickname: '通讯录昵称'
    })
  })

  it('accepts a refreshed group nickname when it is not a contact fallback', () => {
    const groupRoot = '/fixture/group-nickname-update'
    const first = {
      roomId: 'fixture@chatroom',
      memberCount: 1,
      members: [
        {
          wxid: 'wxid-member',
          nickname: '旧群昵称',
          groupNickname: '旧群昵称',
          wechatNickname: '',
          remark: '',
          avatar: ''
        }
      ]
    }
    const refreshed = {
      ...first,
      members: [{ ...first.members[0], nickname: '新群昵称', groupNickname: '新群昵称' }]
    }

    saveCachedGroupSnapshot(groupRoot, 'fixture-md5', first)
    flushBootstrapCacheWritesSync()
    clearBootstrapCache()
    const merged = saveCachedGroupSnapshot(groupRoot, 'fixture-md5', refreshed)

    expect(merged.members[0]).toMatchObject({
      nickname: '新群昵称',
      groupNickname: '新群昵称',
      wechatNickname: ''
    })
  })
})

// ---------------------------------------------------------------------------
// 写入闸门 / 原子替换回归
//
// 这一组断言的是**真实文件系统**的结果（inode、mtime、内容哈希、残留 .tmp），
// 不是函数调用次数 —— 换实现时计数会骗人，inode 不会。
// ---------------------------------------------------------------------------

const BIG_AVATAR = `data:image/jpeg;base64,${Buffer.alloc(2800, 0x41).toString('base64')}`

function cacheFileFor(root: string): string {
  const accountKey = createHash('sha1')
    .update(`${process.platform}:${root}`)
    .digest('hex')
    .slice(0, 24)
  return join(userData, 'cache', 'bootstrap', `${process.platform}-${accountKey}`, 'startup.json')
}

interface FileSnapshot {
  exists: boolean
  ino: number
  mtimeMs: number
  size: number
  sha: string
}

function snapshotFile(file: string): FileSnapshot {
  if (!existsSync(file)) return { exists: false, ino: 0, mtimeMs: 0, size: 0, sha: '' }
  const stat = statSync(file)
  const content = readFileSync(file)
  return {
    exists: true,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    sha: createHash('sha256').update(content).digest('hex')
  }
}

function tempFilesIn(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((name) => name.endsWith('.tmp'))
}

/** 防抖 300ms + 写盘；失败路径还要多等 4 次重试（约 0.5s）。 */
const settle = (ms = 800): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function makeContacts(
  count: number,
  mutate?: (contact: Contact, index: number) => Contact
): Contact[] {
  return Array.from({ length: count }, (_, index) => {
    const contact: Contact = {
      m_nsUsrName: `wxid_fixture_${index}`,
      m_nsNickName: `脱敏联系人${index}`,
      md5: createHash('md5').update(String(index)).digest('hex'),
      type: 'user',
      avatar: BIG_AVATAR,
      wechatNickname: `脱敏联系人${index}`,
      remark: ''
    }
    return mutate ? mutate(contact, index) : contact
  })
}

describe('bootstrap cache write gating', () => {
  beforeEach(() => clearBootstrapCache())

  it('writes the first save and then stops writing identical content', async () => {
    const root = '/fixture/gate-identical'
    const file = cacheFileFor(root)

    saveBootstrapContacts(root, makeContacts(3))
    await settle()
    const first = snapshotFile(file)
    expect(first.exists).toBe(true)

    for (let index = 0; index < 100; index += 1) {
      saveBootstrapContacts(root, makeContacts(3))
    }
    await settle()

    const second = snapshotFile(file)
    expect(second.ino).toBe(first.ino)
    expect(second.mtimeMs).toBe(first.mtimeMs)
    expect(second.sha).toBe(first.sha)
  })

  it('treats a reordered contact list as unchanged and never mutates the input array', async () => {
    const root = '/fixture/gate-reorder'
    const file = cacheFileFor(root)
    const original = makeContacts(4)

    saveBootstrapContacts(root, original)
    await settle()
    const first = snapshotFile(file)

    const reordered = [original[2], original[0], original[3], original[1]]
    const inputSnapshot = reordered.map((contact) => contact.m_nsUsrName)
    saveBootstrapContacts(root, reordered)
    await settle()

    const second = snapshotFile(file)
    expect(second.ino).toBe(first.ino)
    expect(second.sha).toBe(first.sha)
    // 指纹排序的是派生副本，调用方数组顺序必须原样保留
    expect(reordered.map((contact) => contact.m_nsUsrName)).toEqual(inputSnapshot)
  })

  it('persists every kind of real content change', async () => {
    const root = '/fixture/gate-changes'
    const file = cacheFileFor(root)

    saveBootstrapContacts(root, makeContacts(4))
    await settle()
    let previous = snapshotFile(file)

    const cases: { name: string; contacts: Contact[] }[] = [
      {
        name: 'remark',
        contacts: makeContacts(4, (contact, index) =>
          index === 1 ? { ...contact, remark: '新备注' } : contact
        )
      },
      {
        name: 'avatar',
        contacts: makeContacts(4, (contact, index) =>
          index === 2
            ? {
                ...contact,
                avatar: `data:image/png;base64,${Buffer.alloc(1200, 0x42).toString('base64')}`
              }
            : contact
        )
      },
      { name: 'added', contacts: makeContacts(5) },
      { name: 'removed', contacts: makeContacts(3) }
    ]

    for (const testCase of cases) {
      saveBootstrapContacts(root, testCase.contacts)
      await settle()
      const current = snapshotFile(file)
      expect(current.ino, `${testCase.name} 应该触发一次真实替换`).not.toBe(previous.ino)
      expect(JSON.parse(readFileSync(file, 'utf8')).contacts).toHaveLength(testCase.contacts.length)
      previous = current
    }
  })

  it('gates self info and avatar merges the same way', async () => {
    const root = '/fixture/gate-self'
    const file = cacheFileFor(root)
    const contacts = makeContacts(2)

    saveBootstrapContacts(root, contacts)
    await settle()
    saveBootstrapSelf(root, {
      wxid: 'wxid_self',
      nickname: '自己的昵称',
      accountRoot: root
    })
    await settle()
    const afterSelf = snapshotFile(file)
    expect(afterSelf.exists).toBe(true)

    // 相同的 self → 不再写
    saveBootstrapSelf(root, {
      wxid: 'wxid_self',
      nickname: '自己的昵称',
      accountRoot: root
    })
    await settle()
    const afterSameSelf = snapshotFile(file)
    expect(afterSameSelf.ino).toBe(afterSelf.ino)
    expect(afterSameSelf.mtimeMs).toBe(afterSelf.mtimeMs)

    // 改昵称 → 必须写
    saveBootstrapSelf(root, {
      wxid: 'wxid_self',
      nickname: '改过的昵称',
      accountRoot: root
    })
    await settle()
    expect(snapshotFile(file).ino).not.toBe(afterSelf.ino)

    // 头像合并：值相同不写，值不同写
    const beforeMerge = snapshotFile(file)
    mergeBootstrapAvatars(root, { [`wxid_fixture_0`]: BIG_AVATAR })
    await settle()
    expect(snapshotFile(file).ino).toBe(beforeMerge.ino)

    mergeBootstrapAvatars(root, {
      [`wxid_fixture_0`]: `data:image/png;base64,${Buffer.alloc(900, 0x43).toString('base64')}`
    })
    await settle()
    expect(snapshotFile(file).ino).not.toBe(beforeMerge.ino)
  })

  // Windows 的只读目标会让 MoveFileEx/REPLACE_EXISTING 抛 EPERM；
  // POSIX 的 rename 不看文件 mode，这个场景在 macOS 上无法复现。
  it.skipIf(process.platform !== 'win32')(
    'keeps the previous cache when replacement fails, then recovers',
    async () => {
      const root = '/fixture/gate-rename-failure'
      const file = cacheFileFor(root)
      const directory = join(cacheFileFor(root), '..')

      saveBootstrapContacts(root, makeContacts(2))
      await settle()
      const good = snapshotFile(file)
      const goodContent = readFileSync(file, 'utf8')
      expect(good.exists).toBe(true)

      // 只读目标让 MoveFileEx/REPLACE_EXISTING 抛 EPERM；这不是 mock，是真实的文件系统行为。
      chmodSync(file, 0o444)
      try {
        saveBootstrapContacts(
          root,
          makeContacts(3, (contact) => ({ ...contact, remark: '失败尝试' }))
        )
        await settle(1500)

        const failed = snapshotFile(file)
        expect(failed.ino, '替换失败时目标文件必须原样保留').toBe(good.ino)
        expect(readFileSync(file, 'utf8')).toBe(goodContent)
        expect(tempFilesIn(directory), '失败后不能残留 .tmp').toHaveLength(0)
      } finally {
        chmodSync(file, 0o666)
      }

      // 失败过的内容再存一次必须能真正落盘，不能被指纹闸门吞掉
      const target = makeContacts(3, (contact) => ({ ...contact, remark: '失败尝试' }))
      saveBootstrapContacts(root, target)
      await settle()
      const recovered = snapshotFile(file)
      expect(recovered.ino).not.toBe(good.ino)
      expect(JSON.parse(readFileSync(file, 'utf8')).contacts).toHaveLength(3)
      expect(tempFilesIn(directory)).toHaveLength(0)
    }
  )

  it('lands the newest revision under rapid changes', async () => {
    const root = '/fixture/gate-rapid'
    const file = cacheFileFor(root)

    for (let index = 0; index < 40; index += 1) {
      saveBootstrapContacts(
        root,
        makeContacts(2, (contact, contactIndex) =>
          contactIndex === 0 ? { ...contact, remark: `rev-${index}` } : contact
        )
      )
    }
    await settle()

    const contacts = JSON.parse(readFileSync(file, 'utf8')).contacts as Contact[]
    expect(contacts[0].remark).toBe('rev-39')
  })

  it('does not lose the final state on an A → B → A sequence', async () => {
    const root = '/fixture/gate-aba'
    const file = cacheFileFor(root)
    const stateA = makeContacts(2, (contact) => ({ ...contact, remark: 'A' }))
    const stateB = makeContacts(2, (contact) => ({ ...contact, remark: 'B' }))

    saveBootstrapContacts(root, stateA)
    await settle()
    // 同一防抖窗口内 B 紧接着 A：队列里排着 B，最终内存态又是 A
    saveBootstrapContacts(root, stateB)
    saveBootstrapContacts(root, stateA)
    await settle()

    const contacts = JSON.parse(readFileSync(file, 'utf8')).contacts as Contact[]
    expect(contacts.every((contact) => contact.remark === 'A')).toBe(true)
  })

  it('never resurrects writes that were pending when the cache was cleared', async () => {
    const root = '/fixture/gate-clear'
    const file = cacheFileFor(root)

    saveBootstrapContacts(root, makeContacts(2))
    await settle()
    const persisted = snapshotFile(file)

    // 待写入任务还在防抖窗口里就清缓存：不应有任何旧内容被写回
    saveBootstrapContacts(
      root,
      makeContacts(3, (contact) => ({ ...contact, remark: 'pending' }))
    )
    clearBootstrapCache()
    await settle()

    const afterClear = snapshotFile(file)
    expect(afterClear.ino).toBe(persisted.ino)
    expect(afterClear.sha).toBe(persisted.sha)
  })

  it('flushes the newest pending state on quit without being overwritten later', async () => {
    const root = '/fixture/gate-flush'
    const file = cacheFileFor(root)

    saveBootstrapContacts(
      root,
      makeContacts(2, (contact) => ({ ...contact, remark: 'old' }))
    )
    // 不等待防抖，直接换成新内容再同步刷盘
    saveBootstrapContacts(
      root,
      makeContacts(2, (contact) => ({ ...contact, remark: 'new' }))
    )
    flushBootstrapCacheWritesSync()

    const flushed = JSON.parse(readFileSync(file, 'utf8')).contacts as Contact[]
    expect(flushed.every((contact) => contact.remark === 'new')).toBe(true)
    expect(tempFilesIn(join(file, '..'))).toHaveLength(0)

    // 已经飞起来的异步写不能把同步刷盘的内容覆盖回去
    await settle()
    const afterSettle = JSON.parse(readFileSync(file, 'utf8')).contacts as Contact[]
    expect(afterSettle.every((contact) => contact.remark === 'new')).toBe(true)
  })

  it('recovers from a corrupted startup.json and writes again', async () => {
    const root = '/fixture/gate-corrupted'
    const file = cacheFileFor(root)

    saveBootstrapContacts(root, makeContacts(2))
    await settle()
    writeFileSync(file, '{broken', 'utf8')
    clearBootstrapCache()
    expect(getBootstrapCache(root)).toBeNull()

    saveBootstrapContacts(
      root,
      makeContacts(2, (contact) => ({ ...contact, remark: 'recovered' }))
    )
    await settle()

    const contacts = JSON.parse(readFileSync(file, 'utf8')).contacts as Contact[]
    expect(contacts).toHaveLength(2)
    expect(contacts[0].remark).toBe('recovered')
  })
})

/**
 * 可控屏障：让测试精确控制"异步写入已经到达 rename、但还没执行"这个时刻，
 * 而不是靠 sleep 或随机并发去碰运气。
 */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('bootstrap cache replace hardening', () => {
  beforeEach(() => {
    clearBootstrapCache()
    vi.restoreAllMocks()
  })

  it('fails the write instead of copy-overwriting on EXDEV, keeping the old cache', async () => {
    const root = '/fixture/hard-exdev'
    const file = cacheFileFor(root)
    const directory = join(file, '..')

    saveBootstrapContacts(
      root,
      makeContacts(2, (contact) => ({ ...contact, remark: 'OLD' }))
    )
    await settle()
    const good = snapshotFile(file)
    const goodContent = readFileSync(file, 'utf8')

    const renameSpy = vi
      .spyOn(fsExtra, 'rename')
      .mockRejectedValueOnce(
        Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' })
      )
    const copySpy = vi.spyOn(fsExtra, 'copyFile')

    saveBootstrapContacts(
      root,
      makeContacts(2, (contact) => ({ ...contact, remark: 'NEW' }))
    )
    await settle(1200)

    expect(renameSpy).toHaveBeenCalledTimes(1)
    // 关键：跨卷时绝不允许退化成"覆盖复制"，那会把旧缓存截断
    expect(copySpy).not.toHaveBeenCalled()
    expect(snapshotFile(file).ino).toBe(good.ino)
    expect(readFileSync(file, 'utf8')).toBe(goodContent)
    expect(tempFilesIn(directory)).toHaveLength(0)

    vi.restoreAllMocks()
    // 路径恢复正常后，同一份内容必须能落盘
    saveBootstrapContacts(
      root,
      makeContacts(2, (contact) => ({ ...contact, remark: 'NEW' }))
    )
    await settle()
    expect(snapshotFile(file).ino).not.toBe(good.ino)
    expect((JSON.parse(readFileSync(file, 'utf8')).contacts as Contact[])[0].remark).toBe('NEW')
  })

  it('fingerprints every persisted field, including unknown ones, but ignores key order', async () => {
    const root = '/fixture/hard-fingerprint'
    const file = cacheFileFor(root)

    const base = makeContacts(3)
    saveBootstrapContacts(root, base)
    await settle()
    const first = snapshotFile(file)

    // 1) 没在白名单里的新字段：必须触发写盘
    const withExtraField = base.map((contact, index) =>
      index === 0 ? ({ ...contact, brandNewField: 'first' } as Contact) : contact
    )
    saveBootstrapContacts(root, withExtraField)
    await settle()
    const afterExtra = snapshotFile(file)
    expect(afterExtra.ino).not.toBe(first.ino)
    expect(readFileSync(file, 'utf8')).toContain('brandNewField')

    // 2) 同字段同值再来一次：不写
    saveBootstrapContacts(
      root,
      base.map((contact, index) =>
        index === 0 ? ({ ...contact, brandNewField: 'first' } as Contact) : contact
      )
    )
    await settle()
    expect(snapshotFile(file).ino).toBe(afterExtra.ino)

    // 3) 字段插入顺序变化、undefined 字段增删：内容等价 → 不写
    const reorderedKeys = base.map((contact, index) => {
      if (index !== 0) return { ...contact }
      return {
        brandNewField: 'first',
        m_nsUsrName: contact.m_nsUsrName,
        m_nsNickName: contact.m_nsNickName,
        md5: contact.md5,
        type: contact.type,
        avatar: contact.avatar,
        wechatNickname: contact.wechatNickname,
        remark: contact.remark,
        optionalField: undefined
      } as Contact
    })
    saveBootstrapContacts(root, reorderedKeys)
    await settle()
    expect(snapshotFile(file).ino).toBe(afterExtra.ino)

    // 4) 可选字段从无到有（真实内容变化）：必须写
    saveBootstrapContacts(
      root,
      reorderedKeys.map((contact, index) =>
        index === 0 ? ({ ...contact, optionalField: 'now-set' } as Contact) : contact
      )
    )
    await settle()
    expect(snapshotFile(file).ino).not.toBe(afterExtra.ino)
    expect(readFileSync(file, 'utf8')).toContain('now-set')
  })

  it('keeps the newest content when flush happens mid-flight, before rename', async () => {
    const root = '/fixture/hard-flush-race'
    const file = cacheFileFor(root)

    saveBootstrapContacts(
      root,
      makeContacts(2, (contact) => ({ ...contact, remark: 'A' }))
    )
    await settle()

    const gate = createDeferred()
    const entered = createDeferred()
    const originalRename = fsExtra.rename as unknown as (
      src: string,
      dest: string,
      cb: (error: NodeJS.ErrnoException | null) => void
    ) => void
    const passThrough = (src: string, dest: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        originalRename(src, dest, (error) => (error ? reject(error) : resolve()))
      })

    let gated = true
    vi.spyOn(fsExtra, 'rename').mockImplementation(((src: string, dest: string) => {
      if (!gated) return passThrough(src, dest)
      entered.resolve()
      return gate.promise.then(() => passThrough(src, dest))
    }) as never)

    // B 进入异步写入：临时文件已写好，卡在 rename 之前
    saveBootstrapContacts(
      root,
      makeContacts(2, (contact) => ({ ...contact, remark: 'B' }))
    )
    await Promise.race([entered.promise, settle(3000)])
    // 此刻再来一份更新的内容，然后模拟退出刷盘
    saveBootstrapContacts(
      root,
      makeContacts(2, (contact) => ({ ...contact, remark: 'C' }))
    )
    flushBootstrapCacheWritesSync()
    expect((JSON.parse(readFileSync(file, 'utf8')).contacts as Contact[])[0].remark).toBe('C')

    // 放开屏障：那笔已经飞起来的旧写入绝不能把 C 踩掉
    gated = false
    gate.resolve()
    await settle(1200)

    const final = JSON.parse(readFileSync(file, 'utf8')).contacts as Contact[]
    expect(final.every((contact) => contact.remark === 'C')).toBe(true)
    vi.restoreAllMocks()
  })

  it('does not resurrect the cache when it is cleared while a write is mid-flight', async () => {
    const root = '/fixture/hard-clear-race'
    const file = cacheFileFor(root)

    saveBootstrapContacts(
      root,
      makeContacts(2, (contact) => ({ ...contact, remark: 'A' }))
    )
    await settle()

    const gate = createDeferred()
    const entered = createDeferred()
    const originalRename = fsExtra.rename as unknown as (
      src: string,
      dest: string,
      cb: (error: NodeJS.ErrnoException | null) => void
    ) => void

    vi.spyOn(fsExtra, 'rename').mockImplementation(((src: string, dest: string) => {
      entered.resolve()
      return gate.promise.then(
        () =>
          new Promise<void>((resolve, reject) => {
            originalRename(src, dest, (error) => (error ? reject(error) : resolve()))
          }) as never
      )
    }) as never)

    saveBootstrapContacts(
      root,
      makeContacts(2, (contact) => ({ ...contact, remark: 'B' }))
    )
    await Promise.race([entered.promise, settle(3000)])

    clearBootstrapCache()
    gate.resolve()
    await settle(1200)

    expect(existsSync(file), '清缓存后落地的旧写入不能把文件复活').toBe(false)
    vi.restoreAllMocks()
  })

  it('bounds the retry wait of a whole flush batch', async () => {
    const root = '/fixture/hard-flush-budget'
    // 造 12 个待写文件：一个启动缓存 + 11 个消息桶
    saveBootstrapContacts(root, makeContacts(2))
    for (let index = 0; index < 11; index += 1) {
      saveCachedMessages(root, `md5_${index}`, undefined, undefined, [
        {
          id: String(index),
          from: 'fixture',
          type: '文本',
          datetime: '2026-01-01 00:00:00',
          content: `fixture-${index}`,
          isSender: false
        }
      ])
    }

    vi.spyOn(fsExtra, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EBUSY: locked'), { code: 'EBUSY' })
    })

    const startedAt = Date.now()
    flushBootstrapCacheWritesSync()
    const elapsed = Date.now() - startedAt

    // 无预算时 12 个文件 × 460ms ≈ 5.5s；预算 120ms + 12 次首试
    expect(elapsed).toBeLessThan(1200)
    vi.restoreAllMocks()
  })
})
