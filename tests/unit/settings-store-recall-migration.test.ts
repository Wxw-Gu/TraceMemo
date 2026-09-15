import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/tracememo-settings-test-user-data' } }))

/**
 * settings-store 在模块加载时确定 settings.json 路径并缓存设置对象，
 * 所以每个用例都要用独立的目录 + 重新加载模块。
 */
async function importStore(directory: string): Promise<
  typeof import('../../src/main/services/settings-store')
> {
  process.env.WE_SETTINGS_DIR = directory
  vi.resetModules()
  return import('../../src/main/services/settings-store')
}

function readSettingsFile(directory: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

function createDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'tracememo-settings-recall-'))
}

describe('recall protection retirement migration', () => {
  afterAll(() => {
    delete process.env.WE_SETTINGS_DIR
  })

  it('forces a previously enabled recall protection back to false on disk', async () => {
    const directory = createDirectory()
    writeFileSync(
      join(directory, 'settings.json'),
      JSON.stringify({ recallProtectionEnabled: true }),
      'utf8'
    )

    const store = await importStore(directory)

    expect(store.loadSettings().recallProtectionEnabled).toBe(false)
    expect(readSettingsFile(directory).recallProtectionEnabled).toBe(false)
  })

  it('keeps recall protection off for every write path', async () => {
    const directory = createDirectory()
    const store = await importStore(directory)

    expect(store.updateSettings({ recallProtectionEnabled: true }).recallProtectionEnabled).toBe(
      false
    )
    expect(store.loadSettings().recallProtectionEnabled).toBe(false)

    expect(
      store.saveSettings({ ...store.loadSettings(), recallProtectionEnabled: true })
        .recallProtectionEnabled
    ).toBe(false)
    expect(readSettingsFile(directory).recallProtectionEnabled).toBe(false)
  })

  it('defaults recall protection to false without a settings file', async () => {
    const store = await importStore(createDirectory())

    expect(store.loadSettings().recallProtectionEnabled).toBe(false)
  })
})
