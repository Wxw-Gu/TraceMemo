import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import {
  ExtensionHost,
  forkExtensionHost,
  killProcessTree,
  redactSecrets
} from '../../src/main/extensions/extension-host'
import { ExtensionStorage } from '../../src/main/extensions/extension-storage'
import { EXTENSION_HOST_PROTOCOL_VERSION } from '../../src/shared/extensions/rpc'

const roots: string[] = []

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-extension-process-'))
  roots.push(root)
  return root
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  // 先给残留进程一点时间退出，再删目录。
  await sleep(50)
  for (const root of roots.splice(0)) fs.removeSync(root)
})

describe('redactSecrets', () => {
  it('抹掉赋值形态的凭据值，保留键名', () => {
    expect(redactSecrets('cookie: abcdef123456')).toBe('cookie: ***')
    expect(redactSecrets('Authorization=BearerToken123')).toBe('Authorization=***')
    expect(redactSecrets('api_key = sk-1234567890')).toBe('api_key = ***')
  })

  it('抹掉 Bearer token，普通文本不受影响', () => {
    expect(redactSecrets('Authorization: Bearer fake-token-for-redaction-test')).toBe(
      'Authorization: Bearer ***'
    )
    expect(redactSecrets('token bucket 已满')).toBe('token bucket 已满')
    expect(redactSecrets('普通日志：已发送')).toBe('普通日志：已发送')
  })
})

describe('killProcessTree', () => {
  const spawned: number[] = []

  afterEach(async () => {
    for (const pid of spawned.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 已经退出。
      }
    }
    await sleep(30)
  })

  it.skipIf(process.platform === 'win32')('结束进程组时连带结束孙进程', async () => {
    const dir = tempRoot()
    const script = path.join(dir, 'parent.js')
    fs.writeFileSync(
      script,
      `const { spawn } = require('node:child_process')
       const child = spawn('/bin/sleep', ['300'], { stdio: 'ignore' })
       process.send({ grandchild: child.pid })
       setInterval(() => {}, 1000)`
    )

    const parent = spawn(process.execPath, [script], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    spawned.push(parent.pid as number)

    const grandchildPid = await new Promise<number>((resolve) => {
      parent.on('message', (message) => resolve((message as { grandchild: number }).grandchild))
    })
    spawned.push(grandchildPid)
    await sleep(100)
    expect(isAlive(grandchildPid)).toBe(true)

    expect(await killProcessTree(parent.pid)).toBe('group')
    await sleep(300)
    expect(isAlive(grandchildPid)).toBe(false)
    expect(isAlive(parent.pid as number)).toBe(false)
  })

  it('不存在的 pid 返回 fallback 且不抛错', async () => {
    // 不存在的 PID 会让 taskkill 以 128 退出，断言必须落在真实结果上。
    await expect(killProcessTree(999_999_999)).resolves.toBe('fallback')
    await expect(killProcessTree(undefined)).resolves.toBe('fallback')
  })

  it.skipIf(process.platform === 'win32')('只结束指定组，不影响另一个进程组', async () => {
    const dir = tempRoot()
    const script = path.join(dir, 'parent.js')
    fs.writeFileSync(script, 'setInterval(() => {}, 1000)')

    const first = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' })
    const second = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' })
    spawned.push(first.pid as number, second.pid as number)
    await sleep(120)

    await killProcessTree(first.pid)
    await sleep(300)
    expect(isAlive(first.pid as number)).toBe(false)
    expect(isAlive(second.pid as number)).toBe(true)
  })

  /** 覆盖 Windows 进程树：父+孙都被结束，且不波及无关进程。 */
  it.skipIf(process.platform !== 'win32')(
    'Windows 结束父进程树时连带孙进程，且不影响无关进程',
    async () => {
      const dir = tempRoot()
      const script = path.join(dir, 'tree-parent.js')
      fs.writeFileSync(
        script,
        `const { spawn } = require('node:child_process')
         const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
           stdio: 'ignore'
         })
         process.send({ grandchild: child.pid })
         setInterval(() => {}, 1000)`
      )

      const parent = spawn(process.execPath, [script], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      })
      spawned.push(parent.pid as number)

      const grandchildPid = await new Promise<number>((resolve) => {
        parent.on('message', (message) => resolve((message as { grandchild: number }).grandchild))
      })
      spawned.push(grandchildPid)

      // 无关进程：验证杀树不会波及别的扩展。
      const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore'
      })
      spawned.push(bystander.pid as number)

      await sleep(200)
      expect(isAlive(grandchildPid)).toBe(true)
      expect(isAlive(bystander.pid as number)).toBe(true)

      expect(await killProcessTree(parent.pid)).toBe('taskkill')

      await sleep(600)
      expect(isAlive(parent.pid as number)).toBe(false)
      expect(isAlive(grandchildPid)).toBe(false)
      expect(isAlive(bystander.pid as number)).toBe(true)
    }
  )
})

describe('extension host 进程生命周期', () => {
  /**
   * 造一个「激活后派生孙进程、收到 shutdown 也不退出」的宿主，用于验证强杀路径。
   * 孙进程 pid 写到脚本同目录，供测试断言是否残留。
   */
  function createStubbornHostRunner(root: string): string {
    const script = path.join(root, 'stubborn-host.js')
    fs.writeFileSync(
      script,
      `const { spawn } = require('node:child_process')
       const fs = require('node:fs')
       const path = require('node:path')
       let grandchild = null
       process.on('message', (raw) => {
         if (!raw || typeof raw !== 'object') return
         if (raw.type === 'activate') {
           grandchild = spawn('/bin/sleep', ['300'], { stdio: 'ignore' })
           fs.writeFileSync(path.join(__dirname, 'grandchild.pid'), String(grandchild.pid))
           process.send({ type: 'activated', version: ${EXTENSION_HOST_PROTOCOL_VERSION}, ok: true })
         }
         // 刻意忽略 shutdown：模拟扩展卡在清理逻辑里。
       })
       process.send({ type: 'ready', version: ${EXTENSION_HOST_PROTOCOL_VERSION} })
       setInterval(() => {}, 1000)`
    )
    return script
  }

  it.skipIf(process.platform === 'win32')('超时后结束整棵进程树，孙进程不残留', async () => {
    const root = tempRoot()
    const script = createStubbornHostRunner(root)
    const logLines: string[] = []
    const host = new ExtensionHost({
      extensionId: 'com.example.stubborn',
      extensionDir: root,
      dataDir: path.join(root, 'data'),
      permissions: [],
      storage: new ExtensionStorage({ dataRoot: path.join(root, 'storage') }),
      spawn: forkExtensionHost(script),
      onLog: (level, message) => logLines.push(`${level}:${message}`),
      gracefulExitMs: 200,
      forceExitMs: 2_000
    })

    await host.start()
    expect(host.snapshot().state).toBe('active')

    const pidFile = path.join(root, 'grandchild.pid')
    const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    expect(isAlive(grandchildPid)).toBe(true)

    const started = Date.now()
    await host.stop()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(host.snapshot().state).toBe('inactive')
    expect(logLines.some((line) => line.includes('结束进程树'))).toBe(true)

    await sleep(200)
    expect(isAlive(grandchildPid)).toBe(false)
  })

  it('重复 stop 不抛错', async () => {
    const root = tempRoot()
    const script = path.join(root, 'quick-host.js')
    fs.writeFileSync(
      script,
      `process.on('message', (raw) => {
         if (raw && raw.type === 'activate') process.send({ type: 'activated', version: ${EXTENSION_HOST_PROTOCOL_VERSION}, ok: true })
         if (raw && raw.type === 'shutdown') process.exit(0)
       })
       process.send({ type: 'ready', version: ${EXTENSION_HOST_PROTOCOL_VERSION} })`
    )
    const host = new ExtensionHost({
      extensionId: 'com.example.quick',
      extensionDir: root,
      dataDir: path.join(root, 'data'),
      permissions: [],
      storage: new ExtensionStorage({ dataRoot: path.join(root, 'storage') }),
      spawn: forkExtensionHost(script),
      gracefulExitMs: 500,
      forceExitMs: 1_000
    })
    await host.start()
    await host.stop()
    await expect(host.stop()).resolves.toBeUndefined()
    expect(host.snapshot().state).toBe('inactive')
  })

  it('大量 stderr 不会阻塞宿主，日志有速率上限', async () => {
    const root = tempRoot()
    const script = path.join(root, 'noisy-host.js')
    fs.writeFileSync(
      script,
      `const chunk = 'x'.repeat(8 * 1024)
       process.on('message', (raw) => {
         if (raw && raw.type === 'activate') {
           for (let i = 0; i < 160; i += 1) process.stderr.write(chunk)
           process.send({ type: 'activated', version: ${EXTENSION_HOST_PROTOCOL_VERSION}, ok: true })
         }
         if (raw && raw.type === 'shutdown') process.exit(0)
       })
       process.send({ type: 'ready', version: ${EXTENSION_HOST_PROTOCOL_VERSION} })`
    )
    const logLines: string[] = []
    const host = new ExtensionHost({
      extensionId: 'com.example.noisy',
      extensionDir: root,
      dataDir: path.join(root, 'data'),
      permissions: [],
      storage: new ExtensionStorage({ dataRoot: path.join(root, 'storage') }),
      spawn: forkExtensionHost(script),
      onLog: (level, message) => logLines.push(`${level}:${message}`),
      activateTimeoutMs: 8_000
    })

    // 1.25MB stderr：管道被持续消费，激活握手必须仍然完成。
    await host.start()
    expect(host.snapshot().state).toBe('active')
    await sleep(200)

    const stderrLines = logLines.filter((line) => line.includes('[stderr]'))
    expect(stderrLines.length).toBeGreaterThan(0)
    // 单个 10 秒窗口最多 20 条；允许窗口边界多出一条。
    expect(stderrLines.length).toBeLessThanOrEqual(21)
    for (const line of stderrLines) {
      expect(line.length).toBeLessThanOrEqual(520)
    }

    await host.stop()
  })

  it('两个扩展同时运行，停用其中一个不影响另一个', async () => {
    const root = tempRoot()
    const script = path.join(root, 'pair-host.js')
    fs.writeFileSync(
      script,
      `process.on('message', (raw) => {
         if (raw && raw.type === 'activate') process.send({ type: 'activated', version: ${EXTENSION_HOST_PROTOCOL_VERSION}, ok: true })
         if (raw && raw.type === 'shutdown') process.exit(0)
       })
       process.send({ type: 'ready', version: ${EXTENSION_HOST_PROTOCOL_VERSION} })`
    )
    const makeHost = (id: string): ExtensionHost =>
      new ExtensionHost({
        extensionId: id,
        extensionDir: root,
        dataDir: path.join(root, id),
        permissions: [],
        storage: new ExtensionStorage({ dataRoot: path.join(root, `storage-${id}`) }),
        spawn: forkExtensionHost(script),
        gracefulExitMs: 500,
        forceExitMs: 1_000
      })

    const first = makeHost('com.example.first')
    const second = makeHost('com.example.second')
    await first.start()
    await second.start()
    expect(first.snapshot().state).toBe('active')
    expect(second.snapshot().state).toBe('active')

    await first.stop()
    expect(first.snapshot().state).toBe('inactive')
    expect(second.snapshot().state).toBe('active')

    await second.stop()
  })
})
