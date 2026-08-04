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
})
