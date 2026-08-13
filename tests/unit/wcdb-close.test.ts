import { describe, expect, it, vi } from 'vitest'
import { Wcdb4Client } from '../../src/main/wcdb4-client'

function setPrivate(target: object, key: string, value: unknown): void {
  Reflect.set(target, key, value)
}

describe('Wcdb4Client shutdown', () => {
  it('waits for tracked Koffi calls before shutting down the native runtime', async () => {
    const client = Object.create(Wcdb4Client.prototype) as Wcdb4Client
    const shutdown = vi.fn(() => 0)
    const inFlight = new Set<Promise<unknown>>()
    let finishCall: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      finishCall = resolve
    })
    inFlight.add(pending)
    void pending.then(() => inFlight.delete(pending))

    setPrivate(client, 'nativeCallsInFlight', inFlight)
    setPrivate(client, 'handle', 1)
    setPrivate(client, 'wcdbShutdown', shutdown)
    setPrivate(client, 'monitorStarted', false)
    setPrivate(client, 'displayNameCache', new Map())
    setPrivate(client, 'avatarCache', new Map())
    setPrivate(client, 'sessionStatusCache', new Map())
    setPrivate(client, 'groupNicknameCache', new Map())

    const closing = client.closeAsync(1_000)
    expect(shutdown).not.toHaveBeenCalled()

    finishCall?.()
    await expect(closing).resolves.toBe(true)
    if (process.platform === 'win32') {
      expect(shutdown).not.toHaveBeenCalled()
    } else {
      expect(shutdown).toHaveBeenCalledOnce()
    }
  })

  it('restores async batch voice results to request order', async () => {
    const client = Object.create(Wcdb4Client.prototype) as Wcdb4Client
    setPrivate(client, 'wcdbGetVoiceDataBatch', vi.fn())
    setPrivate(
      client,
      'callJsonAsync',
      vi.fn().mockResolvedValue([
        { index: 1, success: false, error: 'missing' },
        { index: 0, Success: true, hex: 'aabb' }
      ])
    )

    await expect(
      client.getVoiceDataBatch([
        { sessionId: 'a', createTime: 1, localId: 10, candidates: ['a'] },
        { sessionId: 'b', createTime: 2, localId: 20, candidates: ['b'] }
      ])
    ).resolves.toEqual([
      { success: true, hex: 'aabb', error: '' },
      { success: false, hex: undefined, error: 'missing' }
    ])
  })

  it('uses the async Koffi path for a single voice lookup and releases the result', async () => {
    const client = Object.create(Wcdb4Client.prototype) as Wcdb4Client
    const nativePointer = { value: 'aabb' }
    const freeString = vi.fn()
    const nativeFunction = {
      async: vi.fn((...args: unknown[]) => {
        const outHex = args.at(-2) as [unknown]
        const callback = args.at(-1) as (error: unknown, code: number) => void
        outHex[0] = nativePointer
        queueMicrotask(() => callback(null, 0))
      })
    }
    setPrivate(client, 'wcdbGetVoiceData', nativeFunction)
    setPrivate(client, 'wcdbFreeString', freeString)
    setPrivate(client, 'handle', 1)
    setPrivate(client, 'closing', false)
    setPrivate(client, 'nativeCallsInFlight', new Set())
    setPrivate(
      client,
      'decodeHexPtr',
      vi.fn(() => 'aabb')
    )

    await expect(client.getVoiceData('session', 100, ['session'], 10, 20)).resolves.toEqual({
      success: true,
      hex: 'aabb',
      error: ''
    })
    expect(nativeFunction.async).toHaveBeenCalledOnce()
    expect(freeString).toHaveBeenCalledWith(nativePointer)
  })
})
