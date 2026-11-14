import { expect, test } from '@playwright/test'
import { launchTestApp } from './support/electron'

test('selects a ChatGPT subscription model for a manual text report', async () => {
  const fixture = await launchTestApp({ chatGPTPlan: true })
  try {
    const { page } = fixture
    await page.getByRole('button', { name: '日报' }).click()
    await page.getByRole('button', { name: '开始生成日报' }).click()

    const textModel = page.getByRole('combobox', { name: '文字总结模型' })
    await expect(textModel).toContainText('固定响应模型')
    await textModel.click()
    await page.getByRole('option', { name: /ChatGPT 订阅.*订阅测试模型/ }).click()
    await expect(textModel).toContainText('订阅测试模型')

    const visionModel = page.getByRole('combobox', { name: '图片理解模型' })
    await visionModel.click()
    await expect(page.getByRole('option')).toHaveCount(1)
    await expect(page.getByRole('option')).toContainText('固定图片识别模型')
    await page.keyboard.press('Escape')

    await page.locator('.report-source-item').filter({ hasText: '产品测试群' }).click()
    await page.getByRole('radio', { name: '近 7 天' }).click()
    await page.getByRole('button', { name: '开始生成日报' }).click()
    await expect(page.getByAltText('产品测试群 群聊日报')).toBeVisible({ timeout: 15_000 })
  } finally {
    await fixture.close()
  }
})
