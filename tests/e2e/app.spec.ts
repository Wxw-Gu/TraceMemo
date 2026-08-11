import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import { launchTestApp } from './support/electron'

test('APP-01 first launch renders a usable connection screen without uncaught errors', async () => {
  const fixture = await launchTestApp({ mode: 'disconnected' })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await expect(fixture.page.getByRole('heading', { name: 'TraceMemo（迹忆）' })).toBeVisible()
    await expect(fixture.page.getByRole('main')).not.toBeEmpty()
    expect(pageErrors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('KEY-01 KEY-02 invalid key remains recoverable and valid key enters the app', async () => {
  const fixture = await launchTestApp({ mode: 'disconnected' })
  try {
    await fixture.page.getByRole('tab', { name: /高级用户/ }).click()
    const keyInput = fixture.page.getByLabel('数据库密钥')
    await keyInput.fill('b'.repeat(64))
    await fixture.page.getByRole('button', { name: '连接数据库' }).click()
    await expect(fixture.page.getByText('数据库密钥无效')).toBeVisible()

    await expect(keyInput).toBeVisible()
    await keyInput.fill('a'.repeat(64))
    await fixture.page.getByRole('button', { name: '连接数据库' }).click()
    await expect(fixture.page.getByRole('navigation', { name: '一级导航' })).toBeVisible()
  } finally {
    await fixture.close()
  }
})

test('P0-01 an invalid directory can be corrected and retried without restarting', async () => {
  test.skip(process.platform !== 'win32', 'Manual database directory editing is Windows-only')
  const fixture = await launchTestApp({ mode: 'disconnected' })
  try {
    await fixture.page.getByRole('tab', { name: /高级用户/ }).click()
    await fixture.page.getByLabel('数据库密钥').fill('a'.repeat(64))
    await fixture.page.getByLabel('微信数据目录').fill('Z:\\missing-wechat-data')
    await fixture.page.getByRole('button', { name: '连接数据库' }).click()

    await expect(fixture.page.getByText('微信数据目录不存在，请重新选择目录')).toBeVisible()
    await expect(fixture.page.getByLabel('微信数据目录')).toBeEditable()
    await expect(fixture.page.getByRole('button', { name: '选择目录' })).toBeEnabled()

    await fixture.page.getByRole('button', { name: '选择目录' }).click()
    await expect(fixture.page.getByLabel('微信数据目录')).toHaveValue('fixture-account')
    await fixture.page.getByRole('button', { name: '连接数据库' }).click()
    await expect(fixture.page.getByRole('navigation', { name: '一级导航' })).toBeVisible()
  } finally {
    await fixture.close()
  }
})

test('P2-01 P2-02 guided connection exposes safe diagnostics and completes all stages', async () => {
  const fixture = await launchTestApp({ mode: 'disconnected' })
  try {
    await expect(fixture.page.getByText('4.1.9.57')).toBeVisible()
    await expect(fixture.page.getByText('微信 4.x（WCDB）')).toBeVisible()
    await expect(fixture.page.getByRole('button', { name: '复制脱敏诊断摘要' })).toBeEnabled()

    await fixture.page.getByRole('button', { name: '检查完成，继续' }).click()
    await fixture.page.getByRole('button', { name: '我已准备好' }).click()
    await fixture.page.getByRole('button', { name: '开始准备连接组件' }).click()
    await expect(fixture.page.getByRole('button', { name: '微信已登录，验证连接' })).toBeEnabled()
    await fixture.page.getByRole('button', { name: '微信已登录，验证连接' }).click()
    await expect(fixture.page.getByRole('navigation', { name: '一级导航' })).toBeVisible()
  } finally {
    await fixture.close()
  }
})

test('KEY-03 changing one key does not invalidate archive data or unrelated settings', async () => {
  const fixture = await launchTestApp()
  try {
    await expect(fixture.page.getByRole('navigation', { name: '一级导航' })).toBeVisible()
    const result = await fixture.page.evaluate(async () => {
      const before = await window.api.getContacts()
      const image = await window.api.saveImageKeyConfig({
        resourceRoot: 'fixture-account',
        xorKey: '0x41',
        aesKey: 'fedcba9876543210'
      })
      const after = await window.api.getContacts()
      const database = await window.api.getSavedDbKey()
      return { before, after, image, database }
    })
    expect(result.image.success).toBe(true)
    expect(result.before).toEqual(result.after)
    expect(result.database.saved).toBe(true)
  } finally {
    await fixture.close()
  }
})

test('NAV-01 NAV-02 every top-level page is unique and switchable', async () => {
  const fixture = await launchTestApp()
  const labels = ['档案', '问问微信', '日报', 'Agent', '导出', 'API', '设置']
  try {
    const navigation = fixture.page.getByRole('navigation', { name: '一级导航' })
    await expect(navigation).toBeVisible()
    for (const label of labels) {
      await expect(navigation.getByRole('button', { name: label })).toHaveCount(1)
      await navigation.getByRole('button', { name: label }).click()
      await expect(fixture.page.locator(`main.app-shell-main[aria-label="${label}"]`)).toBeVisible()
    }
  } finally {
    await fixture.close()
  }
})

test('API-01 masks, reveals, and confirms rotation of the local API token', async () => {
  const fixture = await launchTestApp()
  try {
    await fixture.page.getByRole('button', { name: 'API' }).click()
    await expect(fixture.page.getByText('API Token', { exact: true })).toBeVisible()
    await expect(fixture.page.getByText('••••••••••••••••')).toBeVisible()
    await expect(fixture.page.getByText('fixture-api-token')).toHaveCount(0)

    await fixture.page.getByRole('button', { name: '显示 Token' }).click()
    await expect(fixture.page.getByText('fixture-api-token')).toBeVisible()

    fixture.page.once('dialog', (dialog) => dialog.accept())
    await fixture.page.getByRole('button', { name: '重新生成 Token' }).click()
    await expect(fixture.page.getByText('Token 已生成')).toBeVisible()
  } finally {
    await fixture.close()
  }
})

test('EXPORT-01 multi-chat selection stays local to export and forces HTML', async () => {
  const fixture = await launchTestApp()
  try {
    const navigation = fixture.page.getByRole('navigation', { name: '一级导航' })
    await fixture.page.getByRole('button', { name: '联系人 (1)' }).click()
    await fixture.page.getByText('文件传输助手', { exact: true }).click()
    await expect(fixture.page.getByText('转发多条内容', { exact: true })).toBeVisible()

    await navigation.getByRole('button', { name: '导出' }).click()
    const contactList = fixture.page.locator('.export-contact-list')
    await expect(contactList.getByRole('button', { name: /文件传输助手/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await fixture.page.getByRole('button', { name: '+ 添加聊天' }).click()
    await contactList.getByRole('button', { name: /产品测试群/ }).click()

    await expect(fixture.page.getByText('已选 2 / 5 个')).toBeVisible()
    await expect(fixture.page.getByRole('button', { name: 'CSV' })).toBeDisabled()
    await expect(fixture.page.getByRole('button', { name: /HTML/ })).toHaveClass(/active/)
    await expect(fixture.page.getByText('文件传输助手、产品测试群 · 共 2 个聊天')).toBeVisible()
    await expect(
      fixture.page.locator('.export-preview-bubble').filter({ hasText: '这是一条脱敏测试消息' })
    ).toHaveCount(1)

    await navigation.getByRole('button', { name: '档案' }).click()
    await expect(fixture.page.getByText('转发多条内容', { exact: true })).toBeVisible()
  } finally {
    await fixture.close()
  }
})

test('ARCH-01 ARCH-02 folded chats and supported message types are represented explicitly', async () => {
  const fixture = await launchTestApp()
  try {
    await expect(fixture.page.getByText('产品测试群', { exact: true })).toBeVisible()
    await fixture.page.getByText('产品测试群', { exact: true }).click()
    await expect(fixture.page.getByText('这是一条脱敏测试消息', { exact: true })).toBeVisible()
    await expect(fixture.page.getByText('暂不支持此消息', { exact: true })).toBeVisible()
    await expect(fixture.page.getByAltText('图片')).toBeVisible()
    await fixture.page.locator('.image-bubble.image-loaded').click()
    await expect(fixture.page.getByText('图片查看', { exact: true })).toBeVisible()
    await fixture.page.locator('.image-viewer-overlay').click({ position: { x: 5, y: 5 } })

    await fixture.page.getByRole('button', { name: '折叠群聊 (1)' }).click()
    await expect(fixture.page.getByText('折叠群聊样本', { exact: true })).toBeVisible()
  } finally {
    await fixture.close()
  }
})

test('MEDIA-01 and merged forwards work on the first interaction', async () => {
  const fixture = await launchTestApp()
  try {
    await fixture.page.getByRole('button', { name: '联系人 (1)' }).click()
    await fixture.page.getByText('文件传输助手', { exact: true }).click()
    await expect(fixture.page.getByText('转发多条内容', { exact: true })).toBeVisible()
    await fixture.page.evaluate(() => {
      Object.defineProperty(window, '__wxePlayCount', {
        configurable: true,
        value: 0,
        writable: true
      })
      HTMLMediaElement.prototype.play = async function () {
        ;(window as Window & { __wxePlayCount: number }).__wxePlayCount += 1
      }
      HTMLMediaElement.prototype.pause = function () {
        return undefined
      }
      HTMLMediaElement.prototype.load = function () {
        return undefined
      }
    })
    await fixture.page.locator('.voice-message').click()
    await expect(fixture.page.locator('.voice-icon')).toHaveClass(/playing/)
    expect(
      await fixture.page.evaluate(
        () => (window as Window & { __wxePlayCount: number }).__wxePlayCount
      )
    ).toBe(1)
  } finally {
    await fixture.close()
  }
})

test('MEDIA-02 MEDIA-04 return accurate unsupported and HTTP 403 reasons', async () => {
  const fixture = await launchTestApp()
  try {
    const result = await fixture.page.evaluate(async () => ({
      image: await window.api.getImage('unsupported'),
      sticker: await window.api.getSticker(
        'https://fixture.invalid/403?token=secret',
        'b'.repeat(32)
      )
    }))
    expect(result.image).toMatchObject({ success: false, error: '不支持的 DAT 版本' })
    expect(result.sticker).toMatchObject({
      success: false,
      failureCode: 'access_denied',
      httpStatus: 403
    })
  } finally {
    await fixture.close()
  }
})

test('ASK-01 uses the local fixed AI service and keeps evidence in the UI', async () => {
  const fixture = await launchTestApp()
  try {
    await fixture.page.getByRole('button', { name: '问问微信' }).click()
    await fixture.page.getByPlaceholder(/例如：技术交流群/).fill('测试群讨论了什么？')
    await fixture.page.getByRole('button', { name: '开始分析' }).click()
    await expect(fixture.page.getByText(/固定假回答：测试数据中的核心流程正常/)).toBeVisible({
      timeout: 15_000
    })
  } finally {
    await fixture.close()
  }
})

test('ASK-02 AI failures are recoverable and do not break the archive', async () => {
  const fixture = await launchTestApp({ aiFailure: '429' })
  try {
    await fixture.page.getByRole('button', { name: '问问微信' }).click()
    await fixture.page.getByPlaceholder(/例如：技术交流群/).fill('测试')
    await fixture.page.getByRole('button', { name: '开始分析' }).click()
    await expect(fixture.page.getByText(/本地假服务错误 429/)).toBeVisible()
    await fixture.page.getByRole('button', { name: '档案' }).click()
    await expect(fixture.page.getByText('产品测试群', { exact: true })).toBeVisible()
  } finally {
    await fixture.close()
  }
})

test('REPORT-01 REPORT-02 generates a fixed report with non-empty local assets', async () => {
  const fixture = await launchTestApp()
  try {
    await fixture.page.getByRole('button', { name: '日报' }).click()
    await fixture.page.getByRole('button', { name: '开始生成日报' }).click()
    await expect(fixture.page.getByRole('heading', { name: '生成群聊日报' })).toBeVisible()
    await fixture.page.locator('.report-source-item').filter({ hasText: '产品测试群' }).click()
    await fixture.page.getByRole('button', { name: '近 7 天' }).click()
    const generate = fixture.page.getByRole('button', { name: '开始生成日报' })
    await expect(generate).toBeEnabled()
    await generate.click()
    await expect(fixture.page.getByAltText('产品测试群 群聊日报')).toBeVisible({
      timeout: 15_000
    })

    const exported = await fixture.page.evaluate(async () =>
      window.api.exportGroupReport({
        report: {} as never,
        metadata: {} as never,
        templateId: 'v1'
      })
    )
    expect(exported.success).toBe(true)
    expect(exported.imageDataUrl).toMatch(/^data:image\/png;base64,/)
    expect(existsSync(exported.htmlPath!)).toBe(true)
    expect(existsSync(exported.pngPath!)).toBe(true)
    expect(statSync(exported.pngPath!).size).toBeGreaterThan(20)
  } finally {
    await fixture.close()
  }
})

test('REPORT-03 report failure is retryable and leaves other pages usable', async () => {
  const fixture = await launchTestApp({ aiFailure: '401' })
  try {
    await fixture.page.getByRole('button', { name: '日报' }).click()
    await fixture.page.getByRole('button', { name: '开始生成日报' }).click()
    await fixture.page.locator('.report-source-item').filter({ hasText: '产品测试群' }).click()
    await fixture.page.getByRole('button', { name: '近 7 天' }).click()
    await fixture.page.getByRole('button', { name: '开始生成日报' }).click()
    await expect(fixture.page.getByText(/本地假服务错误 401/).first()).toBeVisible()
    await expect(fixture.page.getByRole('button', { name: '重试' })).toBeEnabled()
    await fixture.page.getByRole('button', { name: '档案' }).click()
    await expect(fixture.page.locator('main.app-shell-main[aria-label="档案"]')).toBeVisible()
    await expect(
      fixture.page.locator('.conversation-item-name').filter({ hasText: '产品测试群' }).first()
    ).toBeVisible()
  } finally {
    await fixture.close()
  }
})

test('CACHE-01 corrupt startup cache degrades to native fixture data', async () => {
  const fixture = await launchTestApp({ corruptCache: true })
  try {
    await expect(fixture.page.getByRole('navigation', { name: '一级导航' })).toBeVisible()
    await expect(fixture.page.getByText('产品测试群', { exact: true })).toBeVisible()
  } finally {
    await fixture.close()
  }
})

test('PERF-01 repeated startup with 1500 sessions remains bounded and responsive', async () => {
  test.setTimeout(60_000)
  const userData = mkdtempSync(resolve(tmpdir(), 'wxe-e2e-perf-'))
  try {
    for (let run = 0; run < 2; run += 1) {
      const startedAt = Date.now()
      const fixture = await launchTestApp({ userData, largeContacts: 1500 })
      try {
        await expect(fixture.page.getByRole('navigation', { name: '一级导航' })).toBeVisible({
          timeout: 10_000
        })
        expect(Date.now() - startedAt).toBeLessThan(10_000)
        await fixture.page
          .getByRole('navigation', { name: '一级导航' })
          .getByRole('button', { name: '设置' })
          .click()
        await expect(fixture.page.locator('main.app-shell-main[aria-label="设置"]')).toBeVisible()
      } finally {
        await fixture.close()
      }
    }
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})

test('KEY-04 e2e diagnostic log does not contain a supplied key', async () => {
  const fixture = await launchTestApp()
  const key = 'c'.repeat(64)
  try {
    await fixture.page.evaluate(
      (databaseKey) =>
        window.api.writeAppLog({
          level: 'error',
          scope: 'key-test',
          message: `fixture key=${databaseKey}`
        }),
      key
    )
    const logPath = resolve(fixture.userData, 'logs/e2e.log')
    const content = readFileSync(logPath, 'utf8')
    expect(content).not.toContain(key)
  } finally {
    await fixture.close()
  }
})
