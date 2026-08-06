const { fork } = require('node:child_process')
const { existsSync, mkdtempSync } = require('node:fs')
const { rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { randomUUID, createHash } = require('node:crypto')

const workerPath = join(__dirname, '..', 'out', 'main', 'knowledgeWorker.js')
if (!existsSync(workerPath)) throw new Error(`Knowledge worker build is missing: ${workerPath}`)

const root = mkdtempSync(join(tmpdir(), 'wxe-knowledge-worker-'))
const child = fork(workerPath, [], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  serialization: 'advanced',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
const pending = new Map()

function request(type, payload) {
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    child.send({ version: 1, type, requestId, payload }, (error) => {
      if (error) reject(error)
    })
  })
}

child.on('message', (message) => {
  if (!message || message.type === 'progress') return
  const current = pending.get(message.requestId)
  if (!current) return
  pending.delete(message.requestId)
  if (message.type === 'error') current.reject(new Error(message.error))
  else current.resolve(message.payload)
})

function fts(profileId) {
  return {
    profileId,
    tokenizer: 'trigram',
    contentMode: 'external',
    detail: 'full',
    columnsize: 1
  }
}

function conversation(accountId, id) {
  return {
    conversationId: `conversation-${id}`,
    completeSnapshot: true,
    messages: [
      {
        accountId,
        conversationId: `conversation-${id}`,
        messageId: `message-${id}`,
        createTime: 1,
        senderId: 'fixture-member',
        senderName: '脱敏成员',
        kind: 'text',
        text: `脱敏索引内容 ${id}`
      }
    ]
  }
}

function accountPath(accountId) {
  const key = createHash('sha256')
    .update(`knowledge-account-v1:${accountId}`)
    .digest('hex')
    .slice(0, 32)
  return join(root, key, 'knowledge.sqlite')
}

async function main() {
  try {
    const chunker = {
      version: 'conversation-v1',
      maxGapMs: 600000,
      maxMessages: 12,
      maxCharacters: 1200,
      overlapMessages: 3
    }
    const accountA = 'worker-fixture-a'
    const accountB = 'worker-fixture-b'
    const first = await request('index', {
      accountId: accountA,
      databaseRoot: root,
      conversations: [conversation(accountA, 'a')],
      chunker,
      fts: fts('worker-a')
    })
    await request('index', {
      accountId: accountB,
      databaseRoot: root,
      conversations: [conversation(accountB, 'b')],
      chunker,
      fts: fts('worker-b')
    })
    if (
      !first ||
      first.cancelled ||
      !existsSync(accountPath(accountA)) ||
      !existsSync(accountPath(accountB))
    ) {
      throw new Error('Knowledge worker did not create isolated derived databases')
    }
    const search = await request('search', {
      accountId: accountA,
      databaseRoot: root,
      fts: fts('worker-a'),
      text: '查询脱敏索引内容 a',
      terms: ['脱敏索引内容', 'a'],
      limit: 10
    })
    const evidence = search?.evidence?.[0]
    if (
      search?.state !== 'ready' ||
      !evidence ||
      evidence.messageId !== 'message-a' ||
      evidence.conversationId !== 'conversation-a' ||
      evidence.sender !== '脱敏成员' ||
      typeof evidence.timestamp !== 'number'
    ) {
      throw new Error('Knowledge worker search did not return message-level evidence')
    }
    await request('remove', { accountId: accountA, databaseRoot: root })
    if (existsSync(accountPath(accountA)) || !existsSync(accountPath(accountB))) {
      throw new Error('Knowledge worker removal crossed an account boundary')
    }
    const unavailable = await request('search', {
      accountId: accountA,
      databaseRoot: root,
      fts: fts('worker-a'),
      text: '查询脱敏索引内容 a',
      terms: ['脱敏索引内容'],
      limit: 10
    })
    if (unavailable?.state !== 'unavailable' || unavailable.evidence?.length) {
      throw new Error('Knowledge worker did not report unavailable index after removal')
    }
    await request('close', {})
    console.log('Knowledge worker integration check passed')
  } finally {
    child.kill()
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
