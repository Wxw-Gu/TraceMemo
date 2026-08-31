import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { classifyStickerHttpFailure } from '../../src/shared/sticker'

const logs = mkdtempSync(join(tmpdir(), 'wxe-log-test-'))
vi.mock('electron', () => ({
  app: { getPath: () => logs, isPackaged: true },
  shell: { showItemInFolder: vi.fn() }
}))

import { AppLogger } from '../../src/main/app-logger'

describe('sensitive logging', () => {
  afterAll(() => rmSync(logs, { recursive: true, force: true }))

  it('does not persist database keys, API keys or bearer tokens', () => {
    const databaseKey = 'a'.repeat(64)
    const logger = new AppLogger()
    logger.write({
      level: 'error',
      scope: 'fixture',
      message: `database open failed key=${databaseKey}`,
      details: {
        databaseKey,
        apiKey: 'sk-fixture-secret-value',
        authorization: 'Bearer fixture-token-value'
      }
    })
    const persisted = readFileSync(logger.logPath, 'utf8')
    expect(persisted).not.toContain(databaseKey)
    expect(persisted).not.toContain('sk-fixture-secret-value')
    expect(persisted).not.toContain('fixture-token-value')
    expect(persisted).toContain('***')
  })
})

describe('sticker HTTP failures', () => {
  it('distinguishes expired, unauthorized, removed and rate-limited resources', () => {
    expect(classifyStickerHttpFailure(403, 'https://fixture.invalid/a?expires=1', 2_000).code).toBe(
      'link_expired'
    )
    expect(classifyStickerHttpFailure(403, 'https://fixture.invalid/a').code).toBe('access_denied')
    expect(classifyStickerHttpFailure(401, 'https://fixture.invalid/a').code).toBe(
      'authentication_required'
    )
    expect(classifyStickerHttpFailure(410, 'https://fixture.invalid/a').code).toBe(
      'resource_removed'
    )
    expect(classifyStickerHttpFailure(429, 'https://fixture.invalid/a').code).toBe('rate_limited')
  })
})

describe('personal WeChat runtime security invariants', () => {
  it('waits for sender termination during application shutdown', () => {
    const mainSource = readFileSync(resolve('src/main/index.ts'), 'utf8')
    const shutdownStart = mainSource.indexOf("app.on('before-quit'")
    const shutdownEnd = mainSource.indexOf('function showMainWindow', shutdownStart)
    const shutdownSource = mainSource.slice(shutdownStart, shutdownEnd)

    expect(shutdownStart).toBeGreaterThanOrEqual(0)
    expect(shutdownEnd).toBeGreaterThan(shutdownStart)
    expect(shutdownSource).toContain('await Promise.all([')
    expect(shutdownSource).toContain('personalWechatSendService.terminate()')
    expect(shutdownSource).not.toContain('personalWechatSendService.stop()')

    const senderSource = readFileSync(
      resolve('src/main/services/personal-wechat-send-service.ts'),
      'utf8'
    )
    expect(senderSource).toContain("process.kill(pid, 'SIGTERM')")
    expect(senderSource).toContain("process.kill(pid, 'SIGKILL')")
    expect(senderSource).toContain('const trackedPid = this.child?.pid')
  })

  it('does not install Python packages while preparing the sender runtime', () => {
    const runtimeManagerSource = readFileSync(
      resolve('src/main/services/personal-wechat-runtime-manager.ts'),
      'utf8'
    )
    const preparationScriptSource = readFileSync(
      resolve('scripts/prepare-wechat-chatter-runtime.cjs'),
      'utf8'
    )

    for (const source of [runtimeManagerSource, preparationScriptSource]) {
      expect(source).not.toContain('pilk==')
      expect(source).not.toMatch(/['"]pip['"]/)
      expect(source).toContain('voiceAudioDataAddr = Memory.alloc(audioLen + 1);')
      expect(source).toContain('上传前按语音长度重新分配')
    }

    const senderSource = readFileSync(
      resolve('src/main/services/personal-wechat-send-service.ts'),
      'utf8'
    )
    expect(senderSource).toContain('buildPersonalWechatRuntimeEnvironment(preflight.runtime.root)')
  })
})
