import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
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
    const selfRoot = '/fixture/a969409112_d784'
    saveBootstrapContacts(selfRoot, [
      {
        m_nsUsrName: 'a969409112',
        m_nsNickName: '濑岛田井卫',
        md5: 'self-md5',
        type: 'user'
      }
    ])
    saveBootstrapSelf(selfRoot, {
      wxid: 'a969409112',
      nickname: 'a969409112',
      accountRoot: selfRoot
    })

    expect(
      mergeCachedSelfInfo(selfRoot, {
        wxid: 'a969409112',
        nickname: 'a969409112',
        accountRoot: selfRoot
      }).nickname
    ).toBe('濑岛田井卫')
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
