import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KnowledgeStore } from '../../src/main/knowledge/knowledge-store'
import {
  DEFAULT_KNOWLEDGE_CHUNKER,
  DEFAULT_KNOWLEDGE_FTS_CONFIG,
  type KnowledgeIndexRequest,
  type KnowledgeMessageKind,
  type KnowledgeSourceMessage
} from '../../src/shared/knowledge'

/**
 * 「按发送者聚合」SQL 的正确性。
 *
 * 这一层必须用**真实 SQLite**：系统消息排除、`sender_id IS NULL` 的归属、
 * 时间窗闭区间，三条规则都写在 SQL 里 —— mock 掉数据库就等于什么都没验证。
 */

const ACCOUNT = 'acct-stats-test'
const CONV = 'c'.repeat(32)
const OTHER_CONV = 'd'.repeat(32)
const DAY = 24 * 60 * 60 * 1000
const BASE = new Date(2026, 5, 15, 12).getTime()

let root = ''
let store: KnowledgeStore | null = null

const message = (
  id: string,
  senderId: string | undefined,
  kind: KnowledgeMessageKind,
  createTime: number,
  conversationId = CONV
): KnowledgeSourceMessage => ({
  accountId: ACCOUNT,
  conversationId,
  messageId: id,
  createTime,
  senderId,
  kind,
  // 必须带可索引文本，否则会被 normalizer 的可索引性判定挡在索引之外，
  // 测试就会因为「消息压根没入库」而假通过。
  text: `payload-${id}`
})

async function seed(messages: KnowledgeSourceMessage[]): Promise<void> {
  store = new KnowledgeStore(root, ACCOUNT, DEFAULT_KNOWLEDGE_FTS_CONFIG)
  const conversations = Array.from(new Set(messages.map((item) => item.conversationId))).map(
    (conversationId) => ({
      conversationId,
      completeSnapshot: true,
      messages: messages.filter((item) => item.conversationId === conversationId),
      sourceHighWaterTime: BASE + 10 * DAY
    })
  )
  const request: KnowledgeIndexRequest = {
    accountId: ACCOUNT,
    databaseRoot: root,
    conversations,
    chunker: DEFAULT_KNOWLEDGE_CHUNKER,
    fts: DEFAULT_KNOWLEDGE_FTS_CONFIG
  }
  await store.index(request, undefined, () => undefined)
}

const query = (startTime: number, endTime: number, conversationId = CONV) =>
  store!.memberStats({ conversationId, startTime, endTime })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tm-knowledge-stats-'))
})

afterEach(() => {
  try {
    store?.close()
  } finally {
    store = null
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('KnowledgeStore.memberStats', () => {
  it('按 sender 聚合出条数与最后发言时间，并按条数降序', async () => {
    await seed([
      message('m1', 'wxid_a', 'text', BASE + 1000),
      message('m2', 'wxid_a', 'text', BASE + 5000),
      message('m3', 'wxid_a', 'text', BASE + 3000),
      message('m4', 'wxid_b', 'text', BASE + 2000)
    ])

    const result = query(BASE, BASE + DAY)

    expect(result.totalMessages).toBe(4)
    expect(result.senders).toEqual([
      { senderId: 'wxid_a', messageCount: 3, lastMessageTime: BASE + 5000 },
      { senderId: 'wxid_b', messageCount: 1, lastMessageTime: BASE + 2000 }
    ])
  })

  it('系统消息不参与任何成员的发言统计', async () => {
    await seed([
      message('m1', 'wxid_a', 'text', BASE + 1000),
      message('m2', 'wxid_a', 'system', BASE + 2000),
      message('m3', undefined, 'system', BASE + 3000)
    ])

    const result = query(BASE, BASE + DAY)

    // 只有那条 text 算发言；系统消息既不计入总数，也不进 senders。
    expect(result.totalMessages).toBe(1)
    expect(result.senders).toEqual([
      { senderId: 'wxid_a', messageCount: 1, lastMessageTime: BASE + 1000 }
    ])
    expect(result.excludedSystemMessages).toBe(2)
    expect(result.unattributedMessages).toBe(0)
  })

  it('sender_id 缺失的消息只计入诊断，不归属任何成员', async () => {
    await seed([
      message('m1', 'wxid_a', 'text', BASE + 1000),
      message('m2', undefined, 'text', BASE + 2000),
      message('m3', undefined, 'other', BASE + 3000)
    ])

    const result = query(BASE, BASE + DAY)

    expect(result.unattributedMessages).toBe(2)
    expect(result.totalMessages).toBe(3)
    // 未归属消息**不得**变成一个空 sender 的分组。
    expect(result.senders).toEqual([
      { senderId: 'wxid_a', messageCount: 1, lastMessageTime: BASE + 1000 }
    ])
  })

  it('时间窗口是闭区间，窗口外的消息不参与', async () => {
    await seed([
      message('before', 'wxid_a', 'text', BASE - 1),
      message('start', 'wxid_a', 'text', BASE),
      message('inside', 'wxid_a', 'text', BASE + 5000),
      message('end', 'wxid_a', 'text', BASE + DAY),
      message('after', 'wxid_a', 'text', BASE + DAY + 1)
    ])

    const result = query(BASE, BASE + DAY)

    // 闭区间：两头都算在内。
    expect(result.totalMessages).toBe(3)
    expect(result.senders[0].messageCount).toBe(3)
    expect(result.senders[0].lastMessageTime).toBe(BASE + DAY)
  })

  it('只统计指定会话，不串到其它群', async () => {
    await seed([
      message('mine', 'wxid_a', 'text', BASE + 1000),
      message('theirs', 'wxid_z', 'text', BASE + 1000, OTHER_CONV)
    ])

    const result = query(BASE, BASE + DAY, CONV)

    expect(result.totalMessages).toBe(1)
    expect(result.senders.map((item) => item.senderId)).toEqual(['wxid_a'])
  })

  it('窗口内没有消息时返回空聚合而不是报错', async () => {
    await seed([message('m1', 'wxid_a', 'text', BASE + 1000)])

    const result = query(BASE + 100 * DAY, BASE + 101 * DAY)

    expect(result.totalMessages).toBe(0)
    expect(result.senders).toEqual([])
    expect(result.unattributedMessages).toBe(0)
    expect(result.indexLatestAt).not.toBeNull()
  })

  it('conversationId 为空时安全返回空结果', async () => {
    await seed([message('m1', 'wxid_a', 'text', BASE + 1000)])

    const result = store!.memberStats({ conversationId: '', startTime: BASE, endTime: BASE + DAY })

    expect(result.totalMessages).toBe(0)
    expect(result.senders).toEqual([])
  })
})
