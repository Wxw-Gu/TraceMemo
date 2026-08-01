import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const on = vi.fn()
const removeListener = vi.fn()
const exposeInMainWorld = vi.fn()

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener }
}))
vi.mock('@electron-toolkit/preload', () => ({ electronAPI: { fixture: true } }))

async function loadApi(): Promise<typeof window.api> {
  vi.resetModules()
  exposeInMainWorld.mockClear()
  Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
  await import('../../src/preload/index')
  const exposed = exposeInMainWorld.mock.calls.find(([name]) => name === 'api')
  if (!exposed) throw new Error('preload did not expose api')
  return exposed[1] as typeof window.api
}

describe('preload IPC contract', () => {
  beforeEach(() => {
    invoke.mockReset()
    on.mockReset()
    removeListener.mockReset()
  })

  it('forwards message and media parameters to the exact main channels', async () => {
    const api = await loadApi()
    invoke.mockResolvedValue({ success: true })

    await api.getMessages('fixture-user', 10, 20, { limit: 50 })
    expect(invoke).toHaveBeenLastCalledWith('db:getMessages', 'fixture-user', 10, 20, {
      limit: 50
    })

    await api.getImage('fixture-md5', 'fixture.dat', 'fixture-session', {
      force: true,
      priority: 0
    })
    expect(invoke).toHaveBeenLastCalledWith(
      'db:getImage',
      'fixture-md5',
      'fixture.dat',
      'fixture-session',
      { force: true, priority: 0 }
    )
  })

  it('preserves key API return values without exposing ipcRenderer', async () => {
    const api = await loadApi()
    invoke.mockResolvedValueOnce({ success: false, code: 'DATABASE_OPEN_FAILED' })
    await expect(api.testConnection('b'.repeat(64), 'fixture-root')).resolves.toEqual({
      success: false,
      code: 'DATABASE_OPEN_FAILED'
    })
    expect(invoke).toHaveBeenCalledWith('db:testConnection', 'b'.repeat(64), 'fixture-root')
    expect(api).not.toHaveProperty('ipcRenderer')
    expect(api).not.toHaveProperty('send')
  })

  it('unsubscribes the same listener registered for native database changes', async () => {
    const api = await loadApi()
    const callback = vi.fn()
    const unsubscribe = api.onWcdbChange(callback)
    expect(on).toHaveBeenCalledWith('wcdb-change', expect.any(Function))
    const listener = on.mock.calls.at(-1)?.[1]
    listener({}, { type: 'insert', json: '{"fixture":true}' })
    expect(callback).toHaveBeenCalledWith({ type: 'insert', json: '{"fixture":true}' })
    unsubscribe()
    expect(removeListener).toHaveBeenCalledWith('wcdb-change', listener)
  })
})
