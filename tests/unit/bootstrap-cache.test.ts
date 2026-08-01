import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
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
  saveBootstrapContacts,
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
})
