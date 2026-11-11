import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/tracememo-settings-test-user-data' } }))

async function importStore(
  directory: string
): Promise<typeof import('../../src/main/services/settings-store')> {
  process.env.WE_SETTINGS_DIR = directory
  vi.resetModules()
  return import('../../src/main/services/settings-store')
}

function createDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'tracememo-settings-helper-'))
}

describe('macOS key helper settings', () => {
  afterAll(() => {
    delete process.env.WE_SETTINGS_DIR
  })

  it('defaults to auto without a settings file', async () => {
    const store = await importStore(createDirectory())

    expect(store.loadSettings().macKeyHelperMode).toBe('auto')
    expect(store.loadSettings().macKeyHelperPath).toBe('')
    expect(store.loadSettings().macKeyHelperProfile).toBe('')
  })

  it('converges invalid values back to auto and trims text fields', async () => {
    const directory = createDirectory()
    writeFileSync(
      join(directory, 'settings.json'),
      JSON.stringify({
        macKeyHelperMode: 'not-a-mode',
        macKeyHelperPath: '  /tmp/xkey_helper  ',
        macKeyHelperProfile: '  wechat-4.1.8  '
      }),
      'utf8'
    )

    const store = await importStore(directory)

    expect(store.loadSettings().macKeyHelperMode).toBe('auto')
    expect(store.loadSettings().macKeyHelperPath).toBe('/tmp/xkey_helper')
    expect(store.loadSettings().macKeyHelperProfile).toBe('wechat-4.1.8')
  })

  it('keeps a valid explicit mode', async () => {
    const directory = createDirectory()
    const store = await importStore(directory)

    const saved = store.updateSettings({ macKeyHelperMode: 'wechat-4.1.13' })

    expect(saved.macKeyHelperMode).toBe('wechat-4.1.13')
    expect(store.loadSettings().macKeyHelperMode).toBe('wechat-4.1.13')
  })
})
