import crypto from 'crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../src/shared/types'

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData }
}))

const message = (createTime: number, serverId?: string): Message => ({
  id: `message-${createTime}`,
  from: 'user',
  isSender: false,
  type: '普通文本',
  datetime: new Date(createTime * 1000).toISOString(),
  content: String(createTime),
  img: '',
  name: 'Jamie',
  sessionId: 'fixture-user',
  localId: 1,
  serverId,
  createTime
})

describe('recall archive message identity', () => {
  beforeAll(() => {
    state.userData = mkdtempSync(join(tmpdir(), 'wxe-recall-identity-'))
  })

  it('does not collapse messages whose local ids repeat across database shards', async () => {
    const accountRoot = '/fixture/account'
    const sessionMd5 = 'fixture-session'
    const archiveDir = join(state.userData, 'recall-archive')
    const archiveName = crypto
      .createHash('sha1')
      .update(`${process.platform}:${accountRoot}`)
      .digest('hex')
      .slice(0, 16)
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(
      join(archiveDir, `${archiveName}.json`),
      JSON.stringify({
        version: 1,
        accountRoot,
        updatedAt: Date.now(),
        sessions: {
          [sessionMd5]: {
            username: 'fixture-user',
            updatedAt: Date.now(),
            messages: [],
            recalls: []
          }
        }
      })
    )
    const { configureRecallArchive, mergeRecallArchiveMessages, messageIdentity } =
      await import('../../src/main/services/recall-archive-service')
    configureRecallArchive(accountRoot)
    const oldMessage = message(1_731_327_263)
    const newMessage = message(1_765_000_000)

    expect(messageIdentity(oldMessage)).not.toBe(messageIdentity(newMessage))
    expect(mergeRecallArchiveMessages(sessionMd5, [oldMessage, newMessage])).toEqual([
      oldMessage,
      newMessage
    ])
  })

  it('prefers the globally unique server id when one is available', async () => {
    const { messageIdentity } = await import('../../src/main/services/recall-archive-service')

    expect(messageIdentity(message(1_731_327_263, 'server-2024'))).toBe('server:server-2024')
  })
})
