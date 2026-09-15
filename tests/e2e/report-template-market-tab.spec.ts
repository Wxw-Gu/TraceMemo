import { expect, test } from '@playwright/test'
import { launchTestApp } from './support/electron'

/**
 * 社区模板市场现在是日报工作区顶部的第三个标签页，也是模板市场的主入口：
 * 浏览、预览、安装、选用与卸载都在这里；生成页只保留选用与预览。
 */
test('REPORT-TEMPLATE-MARKET-TAB-01 browses and installs community templates from the report tabs', async () => {
  const fixture = await launchTestApp({ templateMarket: 'fixture' })
  const page = fixture.page
  const pageErrors: Error[] = []
  page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await page.getByRole('button', { name: '日报' }).click()
    await page.getByRole('button', { name: '开始生成日报' }).click()

    await page.getByRole('tab', { name: '社区模板市场' }).click()
    await expect(page.getByRole('heading', { name: '社区模板市场' })).toBeVisible()
    await expect(page.getByText('经典日报')).toBeVisible()
    await expect(page.getByText('微信信息流')).toBeVisible()
    await expect(page.getByText('已安装 0 个市场模板，另有 1 个可以安装。')).toBeVisible()

    // 投稿入口紧跟在标题下方，不需要滚到底部就能看到。
    const contributeLink = page.getByRole('link', { name: '前往提交模板' })
    await expect(contributeLink).toBeInViewport()
    await expect(contributeLink).toHaveAttribute(
      'href',
      'https://github.com/Wxw-Gu/TraceMemo-Templates'
    )
    await expect(page.getByText('想把你做的模板分享给其他人？')).toBeVisible()

    const marketRow = page.locator('.report-template-item').filter({ hasText: '霓光指挥日报' })
    await expect(marketRow).toBeVisible()
    await expect(marketRow.getByRole('button', { name: '安装' })).toBeEnabled()

    await marketRow.getByRole('button', { name: '安装' }).click()
    await expect(page.getByText('已安装 1 个市场模板，另有 0 个可以安装。')).toBeVisible()
    await expect(page.getByText('已安装市场模板')).toBeVisible()

    // 已安装后市场页提供卸载入口，未安装时只有安装。
    await expect(
      marketRow.getByRole('button', { name: '卸载' })
    ).toBeEnabled()

    await page.getByRole('tab', { name: '今日日报' }).click()
    await expect(page.getByRole('heading', { name: '生成群聊日报' })).toBeVisible()

    const templateSection = page.getByRole('heading', { name: '日报模板' }).locator('..')
    // 生成页只保留选用与预览：没有卸载，也不重复展示市场列表。
    await expect(templateSection.getByText('霓光指挥日报')).toBeVisible()
    await expect(templateSection.getByRole('button', { name: '卸载' })).toHaveCount(0)
    await expect(templateSection.getByRole('button', { name: '安装' })).toHaveCount(0)

    await page.getByRole('tab', { name: '社区模板市场' }).click()
    const roundTripRow = page.locator('.report-template-item').filter({ hasText: '霓光指挥日报' })
    await roundTripRow.getByRole('button', { name: '卸载' }).click()
    await expect(page.getByText('已安装 0 个市场模板，另有 1 个可以安装。')).toBeVisible()

    expect(pageErrors).toEqual([])
  } finally {
    await fixture.close()
  }
})
