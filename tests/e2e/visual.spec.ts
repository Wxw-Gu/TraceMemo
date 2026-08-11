import { expect, test } from '@playwright/test'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { launchTestApp } from './support/electron'

const baselineDirectory = resolve(`tests/e2e/__screenshots__/${process.platform}/visual.spec.ts`)
const visualViewport = { width: 1000, height: 650 }
test.skip(
  !existsSync(baselineDirectory) && process.env.WXE_UPDATE_VISUAL_BASELINES !== '1',
  `No reviewed ${process.platform} visual baseline is committed yet`
)

test('NAV-01 login page visual @visual', async () => {
  const fixture = await launchTestApp({ mode: 'disconnected' })
  try {
    await fixture.page.setViewportSize(visualViewport)
    await expect(fixture.page.getByRole('heading', { name: 'TraceMemo（迹忆）' })).toBeVisible()
    await expect(fixture.page).toHaveScreenshot('login-page.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})

test('ARCH-01 archive page visual @visual', async () => {
  const fixture = await launchTestApp()
  try {
    await fixture.page.setViewportSize(visualViewport)
    await fixture.page.getByText('产品测试群', { exact: true }).click()
    await expect(fixture.page.getByText('这是一条脱敏测试消息', { exact: true })).toBeVisible()
    await expect(fixture.page).toHaveScreenshot('archive-page.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})
