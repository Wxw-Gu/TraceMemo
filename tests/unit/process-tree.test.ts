import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { terminateChildProcess, waitForChildExit } from '../../src/main/process-tree'

class FakeChildProcess extends EventEmitter {
  pid: number | undefined = 4242
  killed = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  kill = vi.fn((signal?: NodeJS.Signals | number) => {
    this.killed = true
    this.signalCode = typeof signal === 'string' ? signal : 'SIGTERM'
    queueMicrotask(() => this.emit('exit', null, this.signalCode))
    return true
  })
}

describe('process-tree', () => {
  it('waitForChildExit resolves immediately for already exited process', async () => {
    const child = new FakeChildProcess()
    child.exitCode = 0
    await expect(waitForChildExit(child, 50)).resolves.toBe(true)
  })

  it('waitForChildExit waits for exit event and returns false on timeout', async () => {
    const child = new FakeChildProcess()
    const pending = waitForChildExit(child, 300)
    setTimeout(() => {
      child.exitCode = 0
      child.emit('exit', 0, null)
    }, 10)
    await expect(pending).resolves.toBe(true)

    const hanging = new FakeChildProcess()
    await expect(waitForChildExit(hanging, 30)).resolves.toBe(false)
  })

  it('terminateChildProcess falls back to child.kill when killTree returns fallback', async () => {
    const child = new FakeChildProcess()
    const killTree = vi.fn(async () => 'fallback' as const)

    const exited = await terminateChildProcess(child, {
      timeoutMs: 300,
      killTree
    })

    expect(exited).toBe(true)
    expect(killTree).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('terminateChildProcess waits for exit after killTree succeeds', async () => {
    const child = new FakeChildProcess()
    const killTree = vi.fn(async () => {
      setTimeout(() => {
        child.exitCode = 0
        child.emit('exit', 0, null)
      }, 15)
      return 'taskkill' as const
    })

    const exited = await terminateChildProcess(child, {
      timeoutMs: 300,
      killTree
    })

    expect(exited).toBe(true)
    expect(child.kill).not.toHaveBeenCalled()
  })
})
