import { expect, test } from '@playwright/test'
import { launchTestApp } from './support/electron'

const debugNotificationEnabled = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.VITE_SCHEDULED_REPORT_DEBUG || '')
    .trim()
    .toLowerCase()
)

test('SCHEDULED-REPORT-UI-01 opens the scheduled report dialog without viewport overflow', async () => {
  test.skip(
    process.platform !== 'darwin' && process.platform !== 'win32',
    'The scheduled report send capability requires macOS or Windows'
  )
  const fixture = await launchTestApp({ now: Date.parse('2026-08-27T08:30:00+08:00') })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize({ width: 820, height: 600 })
    await fixture.page.getByRole('button', { name: '日报' }).click()
    await fixture.page.getByRole('tab', { name: '定时日报' }).click()
    await expect(fixture.page.getByRole('heading', { name: '定时日报', exact: true })).toBeVisible()
    await expect(fixture.page.getByText('✓ 微信发送能力已就绪')).toBeVisible()

    const createButton = fixture.page.getByRole('button', { name: /新建定时日报/ }).first()
    await expect(createButton).toBeEnabled()
    await createButton.click()

    const dialog = fixture.page.getByRole('dialog', { name: '新建定时日报' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: /产品测试群 .*微信群聊/ })).toBeVisible()
    await expect(dialog.getByPlaceholder('搜索群聊')).toBeVisible()
    await expect(dialog.getByRole('button', { name: '创建定时日报' })).toBeVisible()

    const customRange = dialog.locator('[aria-disabled="true"]')
    await expect(customRange).toHaveCount(1)
    const customLabel = customRange.getByText('自定义', { exact: true })
    const customHint = customRange.getByText('即将支持', { exact: true })
    await expect(customLabel).toHaveCSS('white-space', 'nowrap')
    await expect(customHint).toHaveCSS('white-space', 'nowrap')
    expect((await customLabel.boundingBox())?.height).toBeLessThanOrEqual(20)
    expect((await customHint.boundingBox())?.height).toBeLessThanOrEqual(20)

    const selects = dialog.getByRole('combobox')
    await expect(selects).toHaveCount(2)
    await selects.nth(0).click()
    const templateOption = fixture.page.getByRole('option', { name: /Mobile 01.*微信信息流/ })
    await expect(templateOption).toBeVisible()
    await templateOption.click()
    await expect(selects.nth(0)).toContainText('微信信息流')

    await selects.nth(1).click()
    const memberOption = fixture.page.getByRole('option', { name: '微信昵称' })
    await expect(memberOption).toBeVisible()
    await memberOption.click()
    await expect(selects.nth(1)).toContainText('微信昵称')

    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    const bounds = await dialog.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(600)

    await dialog.getByPlaceholder('例如：技术交流 · 每日日报').fill('E2E 定时日报')
    await dialog.getByRole('radio', { name: '今日' }).click()
    await dialog.getByRole('button', { name: '创建定时日报' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(fixture.page.getByText('E2E 定时日报', { exact: true })).toBeVisible()
    await expect(fixture.page.getByText('今日', { exact: true })).toBeVisible()

    await fixture.page.getByRole('button', { name: '设置' }).click()
    await fixture.page.getByRole('button', { name: '微信发送', exact: true }).click()
    await expect(fixture.page.getByRole('heading', { name: '微信发送' })).toBeVisible()
    await expect(fixture.page.getByRole('heading', { name: '发送能力' })).toBeVisible()

    expect(pageErrors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('SCHEDULED-REPORT-UI-02 keeps notification switch off when Agent Hub is offline', async () => {
  test.skip(
    process.platform !== 'darwin' && process.platform !== 'win32',
    'The scheduled report send capability requires macOS or Windows'
  )
  const fixture = await launchTestApp({ now: Date.parse('2026-08-27T08:30:00+08:00') })
  try {
    await fixture.page.getByRole('button', { name: '日报' }).click()
    await fixture.page.getByRole('tab', { name: '定时日报' }).click()
    const notificationSwitch = fixture.page.getByRole('switch', { name: '微信异常通知' })
    await expect(notificationSwitch).toHaveAttribute('aria-checked', 'false')
    await notificationSwitch.click()
    await expect(
      fixture.page
        .getByRole('alert')
        .getByText('需要先连接 Agent Hub 微信机器人，才能接收异常通知。')
    ).toBeVisible()
    await expect(notificationSwitch).toHaveAttribute('aria-checked', 'false')
    await fixture.page.getByRole('button', { name: '前往 Agent Hub' }).click()
    await expect(
      fixture.page.getByRole('heading', { name: 'Agent Hub', exact: true })
    ).toBeVisible()
  } finally {
    await fixture.close()
  }
})

test('SCHEDULED-REPORT-UI-03 sends a simulated error notification in debug mode', async () => {
  test.skip(
    (process.platform !== 'darwin' && process.platform !== 'win32') || !debugNotificationEnabled,
    'The scheduled report debug action requires a supported platform and VITE_SCHEDULED_REPORT_DEBUG=true'
  )
  const fixture = await launchTestApp({ now: Date.parse('2026-08-27T08:30:00+08:00') })
  try {
    await fixture.page.getByRole('button', { name: '日报' }).click()
    await fixture.page.getByRole('tab', { name: '定时日报' }).click()
    await fixture.page
      .getByRole('button', { name: /新建定时日报/ })
      .first()
      .click()

    const dialog = fixture.page.getByRole('dialog', { name: '新建定时日报' })
    await dialog.getByPlaceholder('例如：技术交流 · 每日日报').fill('调试定时日报')
    await dialog.getByRole('button', { name: '创建定时日报' }).click()
    await expect(dialog).toHaveCount(0)

    const debugButton = fixture.page.getByRole('button', { name: '测试错误信息发送' })
    await expect(debugButton).toBeVisible()
    await debugButton.click()
    await expect(
      fixture.page.getByText('测试错误信息已发送到 Agent Hub 微信通知接收者')
    ).toBeVisible()
    await expect(fixture.page.getByText('定时日报错误通知测试')).toBeVisible()
  } finally {
    await fixture.close()
  }
})
