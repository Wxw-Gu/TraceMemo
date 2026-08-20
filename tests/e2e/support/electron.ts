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
  setWindowContentSize: (size: { width: number; height: number }) => Promise<void>
  close: () => Promise<void>
}

export async function launchTestApp(
  options: {
    mode?: 'connected' | 'disconnected'
    userData?: string
    largeContacts?: number
    corruptCache?: boolean
    aiFailure?: string
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
      WXE_E2E_NOW_MS: options.now ? String(options.now) : '',
      WXE_E2E_APPEARANCE_THEME: options.appearanceTheme || 'light'
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const setWindowContentSize = async (size: { width: number; height: number }): Promise<void> => {
    await app.evaluate(({ BrowserWindow, screen }, nextSize) => {
      const [window] = BrowserWindow.getAllWindows()
      if (!window) throw new Error('E2E BrowserWindow is unavailable')
      const { workArea } = screen.getPrimaryDisplay()
      window.setPosition(workArea.x + 40, workArea.y + 40)
      window.setContentSize(nextSize.width, nextSize.height)
    }, size)
    await page.waitForFunction(
      (nextSize) => window.innerWidth === nextSize.width && window.innerHeight === nextSize.height,
      size
    )
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
  }
  return {
    app,
    page,
    userData,
    setWindowContentSize,
    close: async () => {
      if (!page.isClosed() && closeDelayMs > 0) await page.waitForTimeout(closeDelayMs)
      await app.close().catch(() => undefined)
      if (ownsDirectory) rmSync(userData, { recursive: true, force: true })
    }
  }
}
