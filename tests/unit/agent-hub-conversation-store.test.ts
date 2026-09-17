import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHubConversationStore } from '../../src/main/services/agent-hub-conversation-store'

describe('AgentHubConversationStore', () => {
  const roots: string[] = []

  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  function createStore(options: { maxMessages?: number; maxConversations?: number } = {}): {
    store: AgentHubConversationStore
    filePath: string
  } {
    const root = mkdtempSync(join(tmpdir(), 'tracememo-conv-'))
    roots.push(root)
    const filePath = join(root, 'agent-hub', 'conversations.json')
    let sequence = 0
    const store = new AgentHubConversationStore({
      filePath: () => filePath,
      createId: () => `m-${(sequence += 1)}`,
      now: () => 1_700_000_000_000,
      ...(options.maxMessages !== undefined
        ? { maxMessagesPerConversation: options.maxMessages }
        : {}),
      ...(options.maxConversations !== undefined
        ? { maxConversations: options.maxConversations }
        : {})
    })
    return { store, filePath }
  }

  it('记录一次收发并给出会话摘要', () => {
    const { store, filePath } = createStore()

    store.append({ userId: 'user-a', direction: 'in', kind: 'text', text: '你好' })
    const result = store.append({
      userId: 'user-a',
      direction: 'out',
      kind: 'text',
      text: '这是回答',
      status: 'sent'
    })

    expect(result?.summary).toMatchObject({
      userId: 'user-a',
      messageCount: 2,
      lastPreview: '这是回答',
      lastDirection: 'out'
    })
    expect(result?.message).toMatchObject({ direction: 'out', status: 'sent', text: '这是回答' })

    const conversation = store.get('user-a')
    expect(conversation?.messages.map((item) => item.direction)).toEqual(['in', 'out'])
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })

  it('保留发送失败的记录与错误码，便于在界面上对账', () => {
    const { store } = createStore()
    store.append({
      userId: 'user-a',
      direction: 'out',
      kind: 'text',
      text: '发不出去的内容',
      status: 'failed',
      errorCode: 'STALE_TOKEN'
    })

    const message = store.get('user-a')?.messages[0]
    expect(message).toMatchObject({ status: 'failed', errorCode: 'STALE_TOKEN' })
  })

  it('媒体消息只保留类型占位，不写入路径细节以外的内容', () => {
    const { store } = createStore()
    const result = store.append({
      userId: 'user-a',
      direction: 'out',
      kind: 'image',
      text: '群日报.png',
      status: 'sent'
    })

    expect(result?.summary.lastPreview).toBe('群日报.png')
    // 空文本的媒体消息在列表里退化为中文占位。
    store.append({ userId: 'user-a', direction: 'in', kind: 'image', text: '' })
    expect(store.listSummaries()[0].lastPreview).toBe('[图片]')
  })

  it('单个会话超出上限时丢弃最旧的消息', () => {
    const { store } = createStore({ maxMessages: 3 })
    for (let index = 0; index < 5; index += 1) {
      store.append({ userId: 'user-a', direction: 'in', kind: 'text', text: `第 ${index} 条` })
    }

    const messages = store.get('user-a')?.messages ?? []
    expect(messages).toHaveLength(3)
    expect(messages.map((item) => item.text)).toEqual(['第 2 条', '第 3 条', '第 4 条'])
  })

  it('会话数超出上限时只保留最近活跃的', () => {
    const { store } = createStore({ maxConversations: 2 })
    store.append({
      userId: 'old',
      direction: 'in',
      kind: 'text',
      text: '旧会话',
      createdAt: 1_000
    })
    store.append({
      userId: 'mid',
      direction: 'in',
      kind: 'text',
      text: '中间会话',
      createdAt: 2_000
    })
    store.append({
      userId: 'new',
      direction: 'in',
      kind: 'text',
      text: '新会话',
      createdAt: 3_000
    })

    const summaries = store.listSummaries()
    expect(summaries.map((item) => item.userId)).toEqual(['new', 'mid'])
    expect(store.get('old')).toBeNull()
  })

  it('会话列表按最近活跃排序，并带上条数', () => {
    const { store } = createStore()
    store.append({ userId: 'a', direction: 'in', kind: 'text', text: '1', createdAt: 1_000 })
    store.append({ userId: 'b', direction: 'in', kind: 'text', text: '2', createdAt: 2_000 })
    store.append({ userId: 'a', direction: 'in', kind: 'text', text: '3', createdAt: 3_000 })

    expect(store.listSummaries().map((item) => [item.userId, item.messageCount])).toEqual([
      ['a', 2],
      ['b', 1]
    ])
  })

  it('get 返回副本，外部改动不会污染缓存', () => {
    const { store } = createStore()
    store.append({ userId: 'a', direction: 'in', kind: 'text', text: '原始' })

    const first = store.get('a')
    first!.messages[0].text = '被改过'
    expect(store.get('a')?.messages[0].text).toBe('原始')
  })

  it('清空后文件与内存都为空', () => {
    const { store, filePath } = createStore()
    store.append({ userId: 'a', direction: 'in', kind: 'text', text: 'x' })

    store.clear()

    expect(store.listSummaries()).toEqual([])
    expect(store.get('a')).toBeNull()
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ version: 1, conversations: [] })
  })

  it('忽略空会话标识，不产生垃圾条目', () => {
    const { store } = createStore()
    expect(store.append({ userId: '   ', direction: 'in', kind: 'text', text: 'x' })).toBeNull()
    expect(store.listSummaries()).toEqual([])
  })

  it('文件损坏时按空库处理，不抛错', () => {
    const { store, filePath } = createStore()
    store.append({ userId: 'a', direction: 'in', kind: 'text', text: 'x' })
    rmSync(filePath)
    // 重新实例化，读一个不存在的文件
    const fresh = new AgentHubConversationStore({ filePath: () => filePath })
    expect(fresh.listSummaries()).toEqual([])
  })
})
