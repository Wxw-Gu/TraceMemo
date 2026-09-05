import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import { loadEnv } from 'vite'

const DEFAULT_WINDOW_CLOSE_DELAY_MS = 2000

export interface TestApplication {
  app: ElectronApplication
  page: Page
  userData: string
  close: () => Promise<void>
}

export async function launchTestApp(
  options: {
    mode?: 'connected' | 'disconnected'
    userData?: string
    largeContacts?: number
    corruptCache?: boolean
    aiFailure?: string
    updateSimulation?: boolean
    unsignedMacUpdate?: boolean
    now?: number
    appearanceTheme?: 'light' | 'dark'
    stableUserData?: string
  } = {}
): Promise<TestApplication> {
  const ownsDirectory = !options.userData || Boolean(options.stableUserData)
  const userData =
    options.userData ||
    (options.stableUserData
      ? resolve(options.stableUserData)
      : mkdtempSync(resolve(tmpdir(), 'wxe-e2e-')))
  if (options.stableUserData) rmSync(userData, { recursive: true, force: true })
  const localTestEnv = loadEnv('test', process.cwd(), 'WXE_E2E_')
  const configuredCloseDelay = Number(
    process.env.WXE_E2E_CLOSE_DELAY_MS ?? localTestEnv.WXE_E2E_CLOSE_DELAY_MS
  )
  const closeDelayMs = Number.isFinite(configuredCloseDelay)
    ? Math.max(0, configuredCloseDelay)
    : DEFAULT_WINDOW_CLOSE_DELAY_MS
  const app = await electron.launch({
    args: [resolve('tests/e2e/support/electron-main.cjs')],
    env: {
      ...process.env,
      WXE_E2E_USER_DATA: userData,
      WXE_E2E_MODE: options.mode || 'connected',
      WXE_E2E_LARGE_CONTACTS: String(options.largeContacts || 0),
      WXE_E2E_CORRUPT_CACHE: options.corruptCache ? '1' : '0',
      WXE_E2E_AI_FAILURE: options.aiFailure || '',
      WXE_E2E_UPDATE_SIMULATION: options.updateSimulation ? '1' : '0',
      WXE_E2E_UNSIGNED_MAC_UPDATE: options.unsignedMacUpdate ? '1' : '0',
      WXE_E2E_NOW_MS: options.now ? String(options.now) : '',
      WXE_E2E_APPEARANCE_THEME: options.appearanceTheme || 'light'
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (options.now) await page.clock.setFixedTime(options.now)
  return {
    app,
    page,
    userData,
    close: async () => {
      if (!page.isClosed() && closeDelayMs > 0) await page.waitForTimeout(closeDelayMs)
      await app.close().catch(() => undefined)
      if (ownsDirectory) rmSync(userData, { recursive: true, force: true })
    }
  }
}
