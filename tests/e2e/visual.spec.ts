import { expect, test } from '@playwright/test'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { launchTestApp } from './support/electron'

const baselineDirectory = resolve(`tests/e2e/__screenshots__/${process.platform}/visual.spec.ts`)
const visualViewport = { width: 1000, height: 650 }
const visualNow = Date.parse('2026-08-19T14:46:40+08:00')

async function clearScreenshotFocus(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
}

test.skip(
  !existsSync(baselineDirectory) && process.env.WXE_UPDATE_VISUAL_BASELINES !== '1',
  `No reviewed ${process.platform} visual baseline is committed yet`
)

test('NAV-01 login page visual @visual', async () => {
  const fixture = await launchTestApp({ mode: 'disconnected' })
  try {
    await fixture.setWindowContentSize(visualViewport)
    await expect(fixture.page.getByRole('heading', { name: 'TraceMemo（迹忆）' })).toBeVisible()
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('login-page.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})

test('ARCH-01 archive page visual @visual', async () => {
  const fixture = await launchTestApp({ now: visualNow })
  try {
    await fixture.setWindowContentSize(visualViewport)
    await fixture.page.getByText('产品测试群', { exact: true }).click()
    await expect(fixture.page.getByText('这是一条脱敏测试消息', { exact: true })).toBeVisible()
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('archive-page.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})

test('ASK-01 AI Search idle page visual @visual', async () => {
  const fixture = await launchTestApp({ now: visualNow })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize(visualViewport)
    await fixture.page.getByRole('button', { name: '问问微信' }).click()
    await expect(fixture.page.getByRole('heading', { name: '问问你的微信' })).toBeVisible()
    await expect(fixture.page.getByPlaceholder(/例如：技术交流群/)).toBeVisible()
    await expect(fixture.page.getByRole('main', { name: '问问微信' })).not.toBeEmpty()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('ai-search-idle-page.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})

test('ASK-03 AI Search result page visual @visual', async () => {
  const fixture = await launchTestApp({ now: visualNow })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize(visualViewport)
    await fixture.page.getByRole('button', { name: '问问微信' }).click()
    await fixture.page.getByPlaceholder(/例如：技术交流群/).fill('测试群讨论了什么？')
    await fixture.page.getByRole('button', { name: '开始分析' }).click()
    await expect(fixture.page.getByText(/固定假回答：测试数据中的核心流程正常/)).toBeVisible({
      timeout: 15_000
    })
    await expect(fixture.page.getByRole('button', { name: /选择证据 E1/ })).toBeVisible()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('ai-search-result-page.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})

test('API-01 Reader Skill preview visual @visual', async () => {
  const fixture = await launchTestApp({ now: visualNow })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize(visualViewport)
    await fixture.page.getByRole('button', { name: 'API' }).click()
    await fixture.page
      .locator('#api-reader-skill')
      .getByRole('button', { name: '预览 Skill' })
      .click()
    await expect(
      fixture.page.getByRole('dialog', { name: 'TraceMemo Reader Skill 预览' })
    ).toBeVisible()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('api-skill-preview.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})

test('CHAT-02 personal WeChat send dialog visual @visual', async () => {
  test.skip(process.platform !== 'darwin', 'Personal WeChat sending is currently macOS-only')
  const fixture = await launchTestApp({ now: visualNow })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize(visualViewport)
    await fixture.page.getByText('产品测试群', { exact: true }).click()
    await fixture.page.getByRole('button', { name: '发送消息' }).click()
    await expect(fixture.page.getByRole('dialog', { name: '个人微信测试发送' })).toBeVisible()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('personal-wechat-send-dialog.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})

test('CHAT-03 image viewer visual @visual', async () => {
  const fixture = await launchTestApp({ now: visualNow })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize(visualViewport)
    await fixture.page.getByText('产品测试群', { exact: true }).click()
    await fixture.page.getByRole('button', { name: '查看图片' }).click()
    await expect(fixture.page.getByRole('dialog', { name: '图片查看' })).toBeVisible()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('chat-image-viewer.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})

test('EXPORT-01 export workspace idle visual @visual', async () => {
  const fixture = await launchTestApp({ now: visualNow })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize(visualViewport)
    await fixture.page.getByRole('button', { name: '导出' }).click()
    await expect(fixture.page.getByRole('heading', { name: '导出设置' })).toBeVisible()
    await expect(fixture.page.getByRole('button', { name: '开始导出' })).toBeEnabled()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('export-workspace-idle.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})

test('THEME-01 archive page dark visual @visual', async () => {
  const fixture = await launchTestApp({ now: visualNow, appearanceTheme: 'dark' })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize(visualViewport)
    await fixture.page.getByText('产品测试群', { exact: true }).click()
    await expect(fixture.page.getByText('这是一条脱敏测试消息', { exact: true })).toBeVisible()
    await expect(fixture.page.locator('html')).toHaveAttribute('data-theme', 'dark')
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('archive-page-dark.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})

test('THEME-02 export workspace dark visual @visual', async () => {
  const fixture = await launchTestApp({ now: visualNow, appearanceTheme: 'dark' })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize(visualViewport)
    await fixture.page.getByRole('button', { name: '导出' }).click()
    await expect(fixture.page.getByRole('heading', { name: '导出设置' })).toBeVisible()
    await expect(fixture.page.locator('html')).toHaveAttribute('data-theme', 'dark')
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('export-workspace-dark.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})
