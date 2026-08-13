import assert from 'node:assert/strict'
import test from 'node:test'
import worker, { escapeHtml, sha1 } from '../src/index.js'

class MemoryR2Object {
  constructor(value, metadata = {}) {
    this.value = value
    this.metadata = metadata
  }

  async text() {
    return new TextDecoder().decode(this.value)
  }

  get body() {
    return this.value
  }

  writeHttpMetadata(headers) {
    if (this.metadata.contentType) headers.set('content-type', this.metadata.contentType)
    if (this.metadata.cacheControl) headers.set('cache-control', this.metadata.cacheControl)
  }
}

class MemoryR2 {
  objects = new Map()

  async put(key, value, options = {}) {
    const bytes =
      typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)
    this.objects.set(key, new MemoryR2Object(bytes, options.httpMetadata))
  }

  async get(key) {
    return this.objects.get(key) || null
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key)
  }
}

const env = () => ({
  REPORTS: new MemoryR2(),
  UPLOAD_TOKEN: 'test-upload-token-that-is-long-enough',
  PUBLIC_ORIGIN: 'https://share.example.com',
  DEFAULT_EXPIRY_DAYS: '7'
})

test('requires the upload bearer token', async () => {
  const response = await worker.fetch(
    new Request('https://share.example.com/api/cards', { method: 'POST', body: '{}' }),
    env()
  )
  assert.equal(response.status, 401)
})

test('returns a controlled error when R2 is not configured', async () => {
  const response = await worker.fetch(
    new Request('https://share.example/s/d9069d5a-d1a0-44fc-a983-2602c3f1cb94'),
    { PUBLIC_ORIGIN: 'https://share.example' }
  )
  assert.equal(response.status, 503)
  assert.match(await response.text(), /图片存储服务尚未启用/)
})

test('creates an expiring card and serves only its random assets', async () => {
  const testEnv = env()
  const response = await worker.fetch(
    new Request('https://share.example.com/api/cards', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${testEnv.UPLOAD_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        title: '技术交流群日报',
        description: '今日群聊总结',
        imageBase64: Buffer.from('png-data').toString('base64'),
        thumbnailBase64: Buffer.from('jpeg-data').toString('base64')
      })
    }),
    testEnv
  )
  assert.equal(response.status, 200)
  const card = await response.json()
  assert.match(card.cardId, /^[0-9a-f-]{36}$/)
  assert.equal(card.shareUrl, `https://share.example.com/s/${card.cardId}`)

  const page = await worker.fetch(new Request(card.shareUrl), testEnv)
  assert.equal(page.status, 200)
  const pageHtml = await page.text()
  assert.match(pageHtml, /updateAppMessageShareData/)
  assert.match(pageHtml, new RegExp(`/l/${card.cardId}`))

  const link = await worker.fetch(
    new Request(`https://share.example.com/l/${card.cardId}`),
    testEnv
  )
  assert.equal(link.status, 302)
  assert.equal(link.headers.get('location'), `https://share.example.com/v/${card.cardId}`)

  const asset = await worker.fetch(
    new Request(`https://share.example.com/a/${card.cardId}/thumbnail`),
    testEnv
  )
  assert.equal(asset.status, 200)
  assert.equal(await asset.text(), 'jpeg-data')
})

test('escapes untrusted card metadata and produces the expected SHA-1', async () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('x')">&`),
    '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;'
  )
  assert.equal(await sha1('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d')
})

test('removes expired cards when they are requested', async () => {
  const testEnv = env()
  const id = '11111111-1111-4111-8111-111111111111'
  await testEnv.REPORTS.put(
    `cards/${id}/card.json`,
    JSON.stringify({
      id,
      title: 'expired',
      description: '',
      expiresAt: new Date(Date.now() - 1000).toISOString()
    })
  )
  await testEnv.REPORTS.put(`cards/${id}/report.png`, 'image')
  await testEnv.REPORTS.put(`cards/${id}/thumbnail.jpg`, 'thumb')

  const response = await worker.fetch(new Request(`https://share.example.com/s/${id}`), testEnv)
  assert.equal(response.status, 404)
  assert.equal(testEnv.REPORTS.objects.size, 0)
})
