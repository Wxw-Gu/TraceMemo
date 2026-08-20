import { expect, test } from '@playwright/test'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { launchTestApp } from './support/electron'

const baselineDirectory = resolve(`tests/e2e/__screenshots__/${process.platform}/visual.spec.ts`)
const visualViewport = { width: 1400, height: 772 }
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

test('CHAT-01 archive search controls visual @visual', async () => {
  const fixture = await launchTestApp({ now: visualNow })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize(visualViewport)
    await fixture.page.getByText('产品测试群', { exact: true }).click()
    await fixture.page.getByRole('button', { name: '搜索当前聊天' }).click()
    const searchInput = fixture.page.getByRole('textbox', { name: '搜索当前聊天内容' })
    await searchInput.fill('测试')
    await expect(searchInput).toHaveValue('测试')
    expect(
      await fixture.page
        .locator('.chat-archive-header')
        .evaluate((element) => element.scrollWidth <= element.clientWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('chat-content-search.png', {
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

test('ASK-04 AI Search idle page dark visual @visual', async () => {
  const fixture = await launchTestApp({ now: visualNow, appearanceTheme: 'dark' })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize(visualViewport)
    await fixture.page.getByRole('button', { name: '问问微信' }).click()
    await expect(fixture.page.getByRole('heading', { name: '问问你的微信' })).toBeVisible()
    await expect(fixture.page.locator('html')).toHaveAttribute('data-theme', 'dark')
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('ai-search-idle-page-dark.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})

test('ASK-05 AI Search result page dark visual @visual', async () => {
  const fixture = await launchTestApp({ now: visualNow, appearanceTheme: 'dark' })
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
    await expect(fixture.page.locator('html')).toHaveAttribute('data-theme', 'dark')
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('ai-search-result-page-dark.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})

test('API-00 Reader Skill page visual @visual', async () => {
  const fixture = await launchTestApp({ now: visualNow })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize(visualViewport)
    await fixture.page.getByRole('button', { name: 'API' }).click()
    await expect(fixture.page.getByRole('heading', { name: 'TraceMemo Reader' })).toBeVisible()
    await expect(fixture.page.getByText('API Token', { exact: true })).toBeVisible()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('api-center-page.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})

test('API-00 Reader Skill page dark visual @visual', async () => {
  const fixture = await launchTestApp({ now: visualNow, appearanceTheme: 'dark' })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize(visualViewport)
    await fixture.page.getByRole('button', { name: 'API' }).click()
    await expect(fixture.page.getByRole('heading', { name: 'TraceMemo Reader' })).toBeVisible()
    await expect(fixture.page.getByText('API Token', { exact: true })).toBeVisible()
    await expect(fixture.page.locator('html')).toHaveAttribute('data-theme', 'dark')
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('api-center-page-dark.png', {
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

test('API-02 Agent target segmented control visual @visual', async () => {
  const fixture = await launchTestApp({ now: visualNow })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize(visualViewport)
    await fixture.page.getByRole('button', { name: 'API' }).click()
    const targetGroup = fixture.page.getByRole('radiogroup', { name: '选择目标 Agent' })
    await targetGroup.evaluate((element) => element.scrollIntoView({ block: 'center' }))
    const codexTarget = fixture.page.getByRole('radio', { name: 'Codex' })
    await expect(codexTarget).toBeChecked()
    await codexTarget.focus()
    await fixture.page.keyboard.press('ArrowRight')
    const claudeTarget = fixture.page.getByRole('radio', { name: 'Claude Code' })
    await expect(claudeTarget).toBeFocused()
    await fixture.page.keyboard.press('Space')
    await expect(claudeTarget).toBeChecked()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('api-agent-target.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})

for (const appearanceTheme of ['light', 'dark'] as const) {
  test(`REPORT-00 report configuration controls ${appearanceTheme} visual @visual`, async () => {
    const fixture = await launchTestApp({ now: visualNow, appearanceTheme })
    const pageErrors: Error[] = []
    fixture.page.on('pageerror', (error) => pageErrors.push(error))
    try {
      await fixture.setWindowContentSize(visualViewport)
      await fixture.page.getByRole('button', { name: '日报' }).click()
      await fixture.page.getByRole('button', { name: '开始生成日报' }).click()
      await fixture.page.locator('.report-source-item').filter({ hasText: '产品测试群' }).click()
      await expect(fixture.page.getByRole('heading', { name: '生成群聊日报' })).toBeVisible()
      await expect(fixture.page.getByRole('radiogroup', { name: '总结范围' })).toBeVisible()
      expect(
        await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
      expect(pageErrors).toEqual([])
      await clearScreenshotFocus(fixture.page)
      await expect(fixture.page).toHaveScreenshot(
        `${appearanceTheme === 'light' ? 'report-config-page' : 'report-config-page-dark'}.png`,
        {
          animations: 'disabled',
          caret: 'hide'
        }
      )

      const modelHeading = fixture.page.getByRole('heading', { name: '模型配置' })
      await modelHeading.scrollIntoViewIfNeeded()
      await expect(modelHeading).toBeVisible()
      await clearScreenshotFocus(fixture.page)
      await expect(fixture.page).toHaveScreenshot(
        `${appearanceTheme === 'light' ? 'report-model-controls' : 'report-model-controls-dark'}.png`,
        {
          animations: 'disabled',
          caret: 'hide'
        }
      )

      if (appearanceTheme === 'light') {
        const templateSection = fixture.page
          .getByRole('heading', { name: '日报模板' })
          .locator('..')
        await templateSection.getByRole('button', { name: '查看版式' }).first().click()
        const templateDialog = fixture.page.getByRole('dialog', { name: '经典日报' })
        await expect(templateDialog).toBeVisible()
        await clearScreenshotFocus(fixture.page)
        await expect(fixture.page).toHaveScreenshot('report-template-dialog.png', {
          animations: 'disabled',
          caret: 'hide'
        })
      }
    } finally {
      await fixture.close()
    }
  })
}

for (const appearanceTheme of ['light', 'dark'] as const) {
  test(`REPORT-01 report retry controls ${appearanceTheme} visual @visual`, async () => {
    const fixture = await launchTestApp({
      now: visualNow,
      aiFailure: '401',
      appearanceTheme,
      stableUserData: '/tmp/tracememo-e2e-report-user-data'
    })
    const pageErrors: Error[] = []
    fixture.page.on('pageerror', (error) => pageErrors.push(error))
    try {
      await fixture.setWindowContentSize(visualViewport)
      await fixture.page.getByRole('button', { name: '日报' }).click()
      await fixture.page.getByRole('button', { name: '开始生成日报' }).click()
      await fixture.page.locator('.report-source-item').filter({ hasText: '产品测试群' }).click()
      await fixture.page.getByRole('radio', { name: '近 7 天' }).click()
      await fixture.page.getByRole('button', { name: '开始生成日报' }).click()
      await expect(fixture.page.getByText(/本地假服务错误 401/).first()).toBeVisible()
      await expect(fixture.page.getByRole('combobox', { name: '切换模型' })).toBeVisible()
      await expect(fixture.page.getByRole('button', { name: '使用所选模型重新生成' })).toBeEnabled()
      expect(
        await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
      expect(pageErrors).toEqual([])
      await clearScreenshotFocus(fixture.page)
      await expect(fixture.page).toHaveScreenshot(
        `${appearanceTheme === 'light' ? 'report-retry-controls' : 'report-retry-controls-dark'}.png`,
        {
          animations: 'disabled',
          caret: 'hide'
        }
      )
    } finally {
      await fixture.close()
    }
  })
}

for (const appearanceTheme of ['light', 'dark'] as const) {
  test(`CHAT-02 personal WeChat send dialog ${appearanceTheme} visual @visual`, async () => {
    test.skip(process.platform !== 'darwin', 'Personal WeChat sending is currently macOS-only')
    const fixture = await launchTestApp({ now: visualNow, appearanceTheme })
    const pageErrors: Error[] = []
    fixture.page.on('pageerror', (error) => pageErrors.push(error))
    try {
      await fixture.setWindowContentSize(visualViewport)
      await fixture.page.getByText('产品测试群', { exact: true }).click()
      await fixture.page.getByRole('button', { name: '发送消息' }).click()
      const dialog = fixture.page.getByRole('dialog', { name: '个人微信测试发送' })
      await expect(dialog).toBeVisible()
      await expect(fixture.page.locator('html')).toHaveAttribute('data-theme', appearanceTheme)
      expect(
        await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
      expect(pageErrors).toEqual([])
      await fixture.page.mouse.move(0, 0)
      await fixture.page.waitForTimeout(700)
      await clearScreenshotFocus(fixture.page)
      const screenshotName =
        appearanceTheme === 'light'
          ? 'personal-wechat-send-dialog.png'
          : 'personal-wechat-send-dialog-dark.png'
      await expect(fixture.page).toHaveScreenshot(screenshotName, {
        animations: 'disabled',
        caret: 'hide'
      })

      await dialog.getByRole('radio', { name: '语音' }).click()
      await expect(dialog.getByRole('textbox', { name: '要生成的文字' })).toBeVisible()
      await dialog.locator('footer').scrollIntoViewIfNeeded()
      await clearScreenshotFocus(fixture.page)
      await expect(fixture.page).toHaveScreenshot(
        `personal-wechat-voice-controls-${appearanceTheme}.png`,
        {
          animations: 'disabled',
          caret: 'hide'
        }
      )
    } finally {
      await fixture.close()
    }
  })
}

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

test('SETTINGS-02 basic settings controls visual @visual', async () => {
  const fixture = await launchTestApp({ now: visualNow })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize(visualViewport)
    await fixture.page
      .getByRole('navigation', { name: '一级导航' })
      .getByRole('button', { name: '设置' })
      .click()

    await expect(fixture.page.getByRole('heading', { name: '账号与数据库' })).toBeVisible()
    await expect(fixture.page.getByRole('switch', { name: '启动时自动连接数据库' })).toBeVisible()
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('settings-account-database.png', {
      animations: 'disabled',
      caret: 'hide'
    })

    await fixture.page.getByRole('button', { name: '缓存与清理' }).click()
    await expect(fixture.page.getByRole('heading', { name: '缓存与清理' })).toBeVisible()
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('settings-cache-cleanup.png', {
      animations: 'disabled',
      caret: 'hide'
    })

    await fixture.page.getByRole('button', { name: '高级' }).click()
    await expect(fixture.page.getByRole('switch', { name: '显示诊断日志' })).toBeVisible()
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('settings-advanced.png', {
      animations: 'disabled',
      caret: 'hide'
    })

    await fixture.page.getByRole('button', { name: '关于' }).click()
    await expect(fixture.page.getByRole('button', { name: '检查更新' })).toBeVisible()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('settings-about.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})

test('SETTINGS-03 database key controls visual @visual', async () => {
  const fixture = await launchTestApp({ now: visualNow })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize(visualViewport)
    await fixture.page
      .getByRole('navigation', { name: '一级导航' })
      .getByRole('button', { name: '设置' })
      .click()
    await fixture.page.getByRole('button', { name: '数据库密钥' }).click()
    await expect(fixture.page.getByRole('heading', { name: '数据库密钥' })).toBeVisible()
    await expect(fixture.page.getByRole('button', { name: '重新验证' })).toBeVisible()
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('settings-database-key.png', {
      animations: 'disabled',
      caret: 'hide'
    })

    const clearKey = fixture.page.getByRole('button', { name: '清除密钥' })
    await clearKey.scrollIntoViewIfNeeded()
    await expect(clearKey).toBeVisible()
    expect(pageErrors).toEqual([])
    await clearScreenshotFocus(fixture.page)
    await expect(fixture.page).toHaveScreenshot('settings-database-key-danger.png', {
      animations: 'disabled',
      caret: 'hide'
    })
  } finally {
    await fixture.close()
  }
})

for (const appearanceTheme of ['light', 'dark'] as const) {
  test(`SETTINGS-08 recall protection ${appearanceTheme} visual @visual`, async () => {
    const fixture = await launchTestApp({ now: visualNow, appearanceTheme })
    const pageErrors: Error[] = []
    fixture.page.on('pageerror', (error) => pageErrors.push(error))
    try {
      await fixture.setWindowContentSize(visualViewport)
      await fixture.page
        .getByRole('navigation', { name: '一级导航' })
        .getByRole('button', { name: '设置' })
        .click()
      await fixture.page.getByRole('button', { name: '防撤回' }).click()
      await expect(fixture.page.getByRole('switch', { name: '开启防撤回' })).toBeVisible()
      await expect(fixture.page.locator('html')).toHaveAttribute('data-theme', appearanceTheme)
      expect(
        await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
      expect(pageErrors).toEqual([])
      await clearScreenshotFocus(fixture.page)
      await expect(fixture.page).toHaveScreenshot(
        `settings-recall-protection-${appearanceTheme}.png`,
        {
          animations: 'disabled',
          caret: 'hide'
        }
      )
    } finally {
      await fixture.close()
    }
  })
}

for (const appearanceTheme of ['light', 'dark'] as const) {
  test(`SETTINGS-04 image decryption controls ${appearanceTheme} visual @visual`, async () => {
    const fixture = await launchTestApp({ now: visualNow, appearanceTheme })
    const pageErrors: Error[] = []
    fixture.page.on('pageerror', (error) => pageErrors.push(error))
    try {
      await fixture.setWindowContentSize(visualViewport)
      await fixture.page
        .getByRole('navigation', { name: '一级导航' })
        .getByRole('button', { name: '设置' })
        .click()
      await fixture.page.getByRole('button', { name: '图片解密' }).click()
      await expect(
        fixture.page.getByRole('heading', { name: '图片解密', exact: true })
      ).toBeVisible()
      const filterGroup = fixture.page.getByRole('radiogroup', { name: '会话类型筛选' })
      await filterGroup.scrollIntoViewIfNeeded()
      await expect(filterGroup.getByRole('radio', { name: '全部 3' })).toBeChecked()
      expect(
        await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
      expect(pageErrors).toEqual([])
      await clearScreenshotFocus(fixture.page)
      await expect(fixture.page).toHaveScreenshot(
        `settings-image-decryption-${appearanceTheme}.png`,
        {
          animations: 'disabled',
          caret: 'hide'
        }
      )
    } finally {
      await fixture.close()
    }
  })
}

for (const appearanceTheme of ['light', 'dark'] as const) {
  test(`SETTINGS-05 AI model editor ${appearanceTheme} visual @visual`, async () => {
    const fixture = await launchTestApp({ now: visualNow, appearanceTheme })
    const pageErrors: Error[] = []
    fixture.page.on('pageerror', (error) => pageErrors.push(error))
    try {
      await fixture.setWindowContentSize(visualViewport)
      await fixture.page
        .getByRole('navigation', { name: '一级导航' })
        .getByRole('button', { name: '设置' })
        .click()
      await fixture.page.getByRole('button', { name: 'AI 模型' }).click()
      await fixture.page.getByRole('button', { name: '添加供应商' }).click()
      await expect(fixture.page.getByRole('heading', { name: '新增供应商' })).toBeVisible()
      await fixture.page.getByLabel('供应商 ID').fill('fixture-new-provider')
      await expect(fixture.page.getByRole('combobox', { name: '快速模板' })).toBeVisible()
      // Pin the screenshot after fill() auto-scroll to avoid half-pixel capture drift.
      await fixture.page
        .locator('.settings-page-scroll')
        .evaluate((element) => (element.scrollTop = 396))
      expect(
        await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
      expect(pageErrors).toEqual([])
      await clearScreenshotFocus(fixture.page)
      await expect(fixture.page).toHaveScreenshot(
        `settings-ai-model-editor-${appearanceTheme}.png`,
        {
          animations: 'disabled',
          caret: 'hide'
        }
      )
    } finally {
      await fixture.close()
    }
  })
}

for (const appearanceTheme of ['light', 'dark'] as const) {
  test(`SETTINGS-06 text-to-speech controls ${appearanceTheme} visual @visual`, async () => {
    const fixture = await launchTestApp({ now: visualNow, appearanceTheme })
    const pageErrors: Error[] = []
    fixture.page.on('pageerror', (error) => pageErrors.push(error))
    try {
      await fixture.setWindowContentSize(visualViewport)
      await fixture.page
        .getByRole('navigation', { name: '一级导航' })
        .getByRole('button', { name: '设置' })
        .click()
      await fixture.page.getByRole('button', { name: '文字转语音' }).click()
      const modelSelect = fixture.page.getByRole('combobox', { name: '合成模型' })
      await modelSelect.scrollIntoViewIfNeeded()
      await expect(modelSelect).toBeVisible()
      await expect(fixture.page.getByRole('searchbox', { name: '按音色名称搜索' })).toBeDisabled()
      await expect(fixture.page.locator('html')).toHaveAttribute('data-theme', appearanceTheme)
      expect(
        await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
      expect(pageErrors).toEqual([])
      await clearScreenshotFocus(fixture.page)
      await expect(fixture.page).toHaveScreenshot(
        `settings-text-to-speech-controls-${appearanceTheme}.png`,
        {
          animations: 'disabled',
          caret: 'hide'
        }
      )
    } finally {
      await fixture.close()
    }
  })
}

for (const appearanceTheme of ['light', 'dark'] as const) {
  test(`SETTINGS-07 voice recognition controls ${appearanceTheme} visual @visual`, async () => {
    const fixture = await launchTestApp({ now: visualNow, appearanceTheme })
    const pageErrors: Error[] = []
    fixture.page.on('pageerror', (error) => pageErrors.push(error))
    try {
      await fixture.setWindowContentSize(visualViewport)
      await fixture.page
        .getByRole('navigation', { name: '一级导航' })
        .getByRole('button', { name: '设置' })
        .click()
      await fixture.page.getByRole('button', { name: '语音转文字' }).click()
      const categoryTabs = fixture.page.getByRole('tablist', { name: '会话类别' })
      await categoryTabs.scrollIntoViewIfNeeded()
      await expect(categoryTabs).toBeVisible()
      await expect(fixture.page.getByRole('combobox', { name: '语音转写时间范围' })).toBeVisible()
      await expect(fixture.page.locator('html')).toHaveAttribute('data-theme', appearanceTheme)
      expect(
        await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
      expect(pageErrors).toEqual([])
      await clearScreenshotFocus(fixture.page)
      await expect(fixture.page).toHaveScreenshot(
        `settings-voice-recognition-controls-${appearanceTheme}.png`,
        {
          animations: 'disabled',
          caret: 'hide'
        }
      )
    } finally {
      await fixture.close()
    }
  })
}

for (const appearanceTheme of ['light', 'dark'] as const) {
  test(`AGENT-01 Agent Hub ${appearanceTheme} visual @visual`, async () => {
    const fixture = await launchTestApp({ now: visualNow, appearanceTheme })
    const pageErrors: Error[] = []
    fixture.page.on('pageerror', (error) => pageErrors.push(error))
    try {
      await fixture.setWindowContentSize(visualViewport)
      await fixture.page.getByRole('button', { name: 'Agent' }).click()
      await expect(fixture.page.getByRole('heading', { name: 'Agent Hub' })).toBeVisible()
      await expect(fixture.page.getByText('Agent Hub 未运行')).toBeVisible()
      await expect(fixture.page.getByRole('combobox', { name: '筛选日志来源' })).toBeVisible()
      expect(
        await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
      expect(pageErrors).toEqual([])
      await clearScreenshotFocus(fixture.page)
      await expect(fixture.page).toHaveScreenshot(`agent-hub-${appearanceTheme}.png`, {
        animations: 'disabled',
        caret: 'hide'
      })
    } finally {
      await fixture.close()
    }
  })
}

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
