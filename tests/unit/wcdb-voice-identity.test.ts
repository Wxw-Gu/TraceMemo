import { describe, expect, it, vi } from 'vitest'
import { Wcdb4Client } from '../../src/main/wcdb4-client'

const serverId = '9007199254740993'
const reference = {
  sessionId: 'fixture-group@chatroom',
  createTime: 1700000100,
  localId: 7,
  svrId: serverId,
  candidates: ['fixture-group@chatroom']
}

function fixture(): { client: Wcdb4Client; native: ReturnType<typeof vi.fn> } {
  const client = Object.create(Wcdb4Client.prototype) as Wcdb4Client
  // Simulate a native local-ID shortcut selecting an older shard before checking server ID.
  const native = vi.fn((...args: unknown[]) => {
    const out = args[6] as unknown[]
    out[0] = args[3] === 0 && args[4] === BigInt(serverId) ? 'aabb' : 'ccdd'
    const callback = args[7] as (error: unknown, code: number) => void
    callback(null, 0)
  })
  Object.assign(client, {
    handle: 1,
    closing: false,
    nativeCallsInFlight: new Set(),
    wcdbGetVoiceData: { async: native },
    wcdbFreeString: vi.fn(),
    decodeHexPtr: (ptr: unknown) => ptr
  })
  return { client, native }
}

function lookup(
  client: Wcdb4Client,
  id: string | number = serverId
): ReturnType<Wcdb4Client['getVoiceData']> {
  return client.getVoiceData(reference.sessionId, reference.createTime, reference.candidates, 7, id)
}

describe('voice native lookup identity', () => {
  it('avoids the colliding local ID when an exact 64-bit server ID is available', async () => {
    const { client, native } = fixture()
    expect(await lookup(client)).toMatchObject({ success: true, hex: 'aabb' })
    expect(native.mock.calls[0][3]).toBe(0)
    expect(native.mock.calls[0][4]).toBe(9007199254740993n)
  })

  it.each([0, '0', ''])('preserves legacy lookup when no server ID is present (%s)', async (id) => {
    const { client, native } = fixture()
    await lookup(client, id)
    expect(native.mock.calls[0][3]).toBe(7)
    expect(native.mock.calls[0][4]).toBe(0n)
  })

  it.each([9007199254740992, 'invalid', '-1', '9223372036854775808'])(
    'rejects invalid or lossy server IDs (%s)',
    async (id) => {
      const { client, native } = fixture()
      expect(await lookup(client, id)).toMatchObject({ success: false })
      expect(native).not.toHaveBeenCalled()
    }
  )

  it('disables local-ID lookup in native batches and preserves result ordering', async () => {
    const { client } = fixture()
    const batch = vi.fn(async (_fn: unknown, payload: string) => {
      const requests = JSON.parse(payload)
      return requests.reverse().map((r: { index: number; local_id: number; svr_id: string }) => ({
        index: r.index,
        success: true,
        hex: r.local_id === 0 && r.svr_id === serverId ? 'aabb' : 'ccdd'
      }))
    })
    Object.assign(client, { wcdbGetVoiceDataBatch: vi.fn(), callJsonAsync: batch })
    const results = await client.getVoiceDataBatch([reference, { ...reference, svrId: 0 }])
    expect(results.map((r) => r.hex)).toEqual(['aabb', 'ccdd'])
  })

  it.each([false, true])(
    'keeps server-ID lookup on single-item fallback (batch throws: %s)',
    async (throws) => {
      const { client, native } = fixture()
      if (throws)
        Object.assign(client, {
          wcdbGetVoiceDataBatch: vi.fn(),
          callJsonAsync: vi.fn().mockRejectedValue(new Error('unsupported'))
        })
      expect(await client.getVoiceDataBatch([reference])).toEqual([
        { success: true, hex: 'aabb', error: '' }
      ])
      expect(native.mock.calls[0][3]).toBe(0)
    }
  )

  it('rejects an invalid batch entry without dropping valid siblings or invoking a lossy native lookup', async () => {
    const { client, native } = fixture()
    const batch = vi.fn()
    Object.assign(client, { wcdbGetVoiceDataBatch: vi.fn(), callJsonAsync: batch })
    const results = await client.getVoiceDataBatch([
      { ...reference, svrId: 9007199254740992 },
      reference
    ])
    expect(results[0].success).toBe(false)
    expect(results[1]).toMatchObject({ success: true, hex: 'aabb' })
    expect(batch).not.toHaveBeenCalled()
    expect(native).toHaveBeenCalledOnce()
  })

  it('does not retry a failed server-ID lookup using the colliding local ID', async () => {
    const { client, native } = fixture()
    native.mockImplementation((...args: unknown[]) => {
      const callback = args[7] as (error: unknown, code: number) => void
      callback(null, -1)
    })
    expect(await lookup(client)).toMatchObject({ success: false })
    expect(native).toHaveBeenCalledOnce()
    expect(native.mock.calls[0][3]).toBe(0)
  })
})
