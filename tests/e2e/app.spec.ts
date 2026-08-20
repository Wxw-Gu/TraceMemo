import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import { launchTestApp } from './support/electron'

async function dismissFirstUseWelcome(page: import('@playwright/test').Page): Promise<void> {
  const welcome = page.getByRole('dialog', { name: '开始探索你的微信' })
  await expect(welcome).toBeVisible()
  await welcome.getByRole('button', { name: '关闭' }).click()
  await expect(welcome).toHaveCount(0)
}

test('APP-01 first launch renders a usable connection screen without uncaught errors', async () => {
  const fixture = await launchTestApp({ mode: 'disconnected' })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize({ width: 820, height: 600 })
    await expect(fixture.page.getByRole('heading', { name: 'TraceMemo（迹忆）' })).toBeVisible()
    await expect(fixture.page.getByRole('main')).not.toBeEmpty()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
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
    await dismissFirstUseWelcome(fixture.page)
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
    const verifyConnection = fixture.page.getByRole('button', {
      name: '验证连接',
      exact: true
    })
    await expect(verifyConnection).toBeEnabled()
    await verifyConnection.click()
    await dismissFirstUseWelcome(fixture.page)
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

test('CHAT-01 archive More menu is keyboard-safe and keeps the page usable', async () => {
  const fixture = await launchTestApp()
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize({ width: 820, height: 600 })
    const conversationSearch = fixture.page.getByRole('searchbox', { name: '搜索会话' })
    await conversationSearch.fill('产品')
    await expect(fixture.page.getByText('产品测试群', { exact: true })).toBeVisible()
    await conversationSearch.fill('')
    await fixture.page.getByRole('button', { name: '刷新会话列表' }).click()
    await fixture.page.getByText('产品测试群', { exact: true }).click()
    const moreButton = fixture.page.getByRole('button', { name: '更多' })
    await moreButton.click()
    await expect(fixture.page.getByRole('menuitem', { name: '刷新数据' })).toBeVisible()
    await fixture.page.keyboard.press('Escape')
    await expect(fixture.page.getByRole('menuitem', { name: '刷新数据' })).toHaveCount(0)
    await expect(moreButton).toBeFocused()

    await moreButton.click()
    await fixture.page.getByRole('menuitem', { name: '刷新数据' }).click()
    await expect(fixture.page.getByRole('heading', { name: '产品测试群' })).toBeVisible()

    await fixture.page.getByRole('button', { name: '搜索当前聊天' }).click()
    const searchInput = fixture.page.getByRole('textbox', { name: '搜索当前聊天内容' })
    await expect(searchInput).toBeFocused()
    await searchInput.fill('测试')
    await expect(searchInput).toHaveValue('测试')
    expect(
      await fixture.page
        .locator('.chat-archive-header')
        .evaluate((element) => element.scrollWidth <= element.clientWidth)
    ).toBe(true)
    await fixture.page.getByRole('button', { name: '关闭搜索' }).click()
    await expect(searchInput).toHaveCount(0)

    const avatarSwitch = fixture.page.getByRole('switch', { name: '显示头像' })
    await expect(avatarSwitch).toBeChecked()
    await avatarSwitch.click()
    await expect(avatarSwitch).not.toBeChecked()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('CHAT-02 personal WeChat send dialog is keyboard-safe and fits the viewport', async () => {
  test.skip(process.platform !== 'darwin', 'Personal WeChat sending is currently macOS-only')
  const fixture = await launchTestApp()
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize({ width: 820, height: 600 })
    await fixture.page.getByText('产品测试群', { exact: true }).click()
    const trigger = fixture.page.getByRole('button', { name: '发送消息' })
    await trigger.click()
    const dialog = fixture.page.getByRole('dialog', { name: '个人微信测试发送' })
    await expect(dialog).toBeVisible()
    await expect(
      dialog.locator('.personal-wechat-send-status strong').filter({ hasText: '个人微信已绑定' })
    ).toBeVisible()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    )
    const bounds = await dialog.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(600)
    expect(pageErrors).toEqual([])

    const imageMode = dialog.getByRole('radio', { name: '图片' })
    const voiceMode = dialog.getByRole('radio', { name: '语音' })
    await imageMode.focus()
    await fixture.page.keyboard.press('ArrowRight')
    await expect(voiceMode).toBeFocused()
    await fixture.page.keyboard.press('Space')
    await expect(voiceMode).toBeChecked()
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    )

    await fixture.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
  } finally {
    await fixture.close()
  }
})

test('GUIDE-01 first-use welcome is keyboard-safe and fits the viewport', async () => {
  const fixture = await launchTestApp()
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize({ width: 1000, height: 650 })
    const guideButton = fixture.page.getByRole('button', { name: '新手引导' })
    await guideButton.click()
    const dialog = fixture.page.getByRole('dialog', { name: '开始探索你的微信' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: /试试 AI 群聊日报/ })).toBeVisible()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])

    await fixture.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(guideButton).toBeFocused()
  } finally {
    await fixture.close()
  }
})

test('SETTINGS-01 supported WeChat versions dialog is keyboard-safe and fits the viewport', async () => {
  test.skip(process.platform !== 'darwin', 'The personal WeChat runtime is currently macOS-only')
  const fixture = await launchTestApp()
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize({ width: 820, height: 600 })
    await fixture.page
      .getByRole('navigation', { name: '一级导航' })
      .getByRole('button', { name: '设置' })
      .click()
    await fixture.page.getByRole('button', { name: '文字转语音' }).click()

    const trigger = fixture.page.getByRole('button', { name: '查看支持版本' })
    await expect(trigger).toBeVisible()
    await trigger.click()
    const dialog = fixture.page.getByRole('dialog', { name: '支持的微信版本' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('4.1.6.12')).toBeVisible()
    await expect(dialog.getByText('4.1.11.53')).toBeVisible()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])

    await fixture.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()

    const modelSelect = fixture.page.getByRole('combobox', { name: '合成模型' })
    await modelSelect.scrollIntoViewIfNeeded()
    await modelSelect.click()
    await expect(fixture.page.getByRole('option', { name: 's2.1-pro', exact: true })).toBeVisible()
    await fixture.page.keyboard.press('Escape')
    await expect(modelSelect).toBeFocused()
    await expect(fixture.page.getByRole('searchbox', { name: '按音色名称搜索' })).toBeDisabled()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('SETTINGS-02 basic settings controls fit a narrow viewport and keep their semantics', async () => {
  const fixture = await launchTestApp()
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize({ width: 820, height: 600 })
    await fixture.page
      .getByRole('navigation', { name: '一级导航' })
      .getByRole('button', { name: '设置' })
      .click()

    await expect(fixture.page.getByRole('heading', { name: '账号与数据库' })).toBeVisible()
    const autoLoginSwitch = fixture.page.getByRole('switch', { name: '启动时自动连接数据库' })
    await expect(autoLoginSwitch).toBeVisible()
    await autoLoginSwitch.click()
    await expect(autoLoginSwitch).toBeChecked()

    await fixture.page.getByRole('button', { name: '缓存与清理' }).click()
    await expect(fixture.page.getByRole('heading', { name: '缓存与清理' })).toBeVisible()
    await expect(fixture.page.getByRole('button', { name: '清理全部' })).toBeEnabled()

    await fixture.page.getByRole('button', { name: '高级' }).click()
    const debugSwitch = fixture.page.getByRole('switch', { name: '显示诊断日志' })
    await expect(debugSwitch).toBeVisible()
    await debugSwitch.click()
    await expect(debugSwitch).toBeChecked()

    await fixture.page.getByRole('button', { name: '防撤回' }).click()
    const recallSwitch = fixture.page.getByRole('switch', { name: '开启防撤回' })
    await expect(recallSwitch).toBeVisible()
    await recallSwitch.click()
    await expect(recallSwitch).toBeChecked()

    await fixture.page.getByRole('button', { name: '关于' }).click()
    await expect(fixture.page.getByRole('button', { name: '检查更新' })).toBeVisible()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('SETTINGS-03 database key actions keep destructive confirmation keyboard-safe', async () => {
  const fixture = await launchTestApp()
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize({ width: 820, height: 600 })
    await fixture.page
      .getByRole('navigation', { name: '一级导航' })
      .getByRole('button', { name: '设置' })
      .click()
    await fixture.page.getByRole('button', { name: '数据库密钥' }).click()
    await expect(fixture.page.getByRole('heading', { name: '数据库密钥' })).toBeVisible()
    await expect(fixture.page.getByRole('button', { name: '重新验证' })).toBeVisible()

    const clearKey = fixture.page.getByRole('button', { name: '清除密钥' })
    await clearKey.scrollIntoViewIfNeeded()
    await clearKey.click()
    const dialog = fixture.page.getByRole('alertdialog', { name: '确认清除数据库密钥？' })
    await expect(dialog).toBeVisible()
    await fixture.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(clearKey).toBeFocused()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('SETTINGS-04 image decryption controls keep filtering and selection keyboard-safe', async () => {
  const fixture = await launchTestApp()
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize({ width: 820, height: 600 })
    await fixture.page
      .getByRole('navigation', { name: '一级导航' })
      .getByRole('button', { name: '设置' })
      .click()
    await fixture.page.getByRole('button', { name: '图片解密' }).click()
    await expect(fixture.page.getByRole('heading', { name: '图片解密', exact: true })).toBeVisible()

    const filterGroup = fixture.page.getByRole('radiogroup', { name: '会话类型筛选' })
    await filterGroup.scrollIntoViewIfNeeded()
    const allFilter = filterGroup.getByRole('radio', { name: '全部 3' })
    await expect(allFilter).toBeChecked()
    await allFilter.focus()
    await fixture.page.keyboard.press('ArrowRight')
    const groupFilter = filterGroup.getByRole('radio', { name: '群聊 2' })
    await expect(groupFilter).toBeFocused()
    await fixture.page.keyboard.press('Space')
    await expect(groupFilter).toBeChecked()

    await fixture.page.getByRole('searchbox', { name: '搜索会话' }).fill('产品')
    const conversationSelect = fixture.page.getByRole('combobox', { name: '选择会话' })
    await conversationSelect.click()
    await expect(fixture.page.getByRole('option', { name: '产品测试群' })).toBeVisible()
    await expect(fixture.page.getByRole('option', { name: '折叠群聊样本' })).toHaveCount(0)
    await fixture.page.keyboard.press('Escape')
    await expect(conversationSelect).toBeFocused()

    await conversationSelect.click()
    await fixture.page.getByRole('option', { name: '产品测试群' }).click()
    await expect(conversationSelect).toContainText('产品测试群')
    const testAction = fixture.page.getByRole('button', { name: '测试图片解析' })
    await expect(testAction).toBeEnabled()
    await testAction.click()
    await expect(fixture.page.getByText('图片可以读取')).toBeVisible()

    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(
      await fixture.page
        .locator('.settings-page-scroll')
        .evaluate((element) => element.scrollWidth <= element.clientWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('SETTINGS-05 AI model editor keeps provider and capability semantics', async () => {
  const fixture = await launchTestApp()
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize({ width: 820, height: 600 })
    await fixture.page
      .getByRole('navigation', { name: '一级导航' })
      .getByRole('button', { name: '设置' })
      .click()
    await fixture.page.getByRole('button', { name: 'AI 模型' }).click()
    await expect(fixture.page.getByRole('heading', { name: 'AI 模型' })).toBeVisible()
    await expect(fixture.page.getByRole('button', { name: '当前默认' })).toBeDisabled()

    await fixture.page.getByRole('button', { name: '添加供应商' }).click()
    await expect(fixture.page.getByRole('heading', { name: '新增供应商' })).toBeVisible()
    await expect(fixture.page.getByLabel('供应商名称')).toBeFocused()
    await fixture.page.getByLabel('供应商 ID').fill('fixture-new-provider')

    const presetSelect = fixture.page.getByRole('combobox', { name: '快速模板' })
    await presetSelect.click()
    await fixture.page.getByRole('option', { name: 'OpenAI', exact: true }).click()
    await expect(fixture.page.getByLabel('供应商名称')).toHaveValue('OpenAI')
    await expect(fixture.page.getByLabel('模型名称')).toHaveValue('gpt-4o-mini')

    const providerType = fixture.page.getByRole('combobox', { name: '供应商类型' })
    await providerType.click()
    await expect(fixture.page.getByRole('option', { name: 'Anthropic Messages' })).toBeVisible()
    await fixture.page.keyboard.press('Escape')
    await expect(providerType).toBeFocused()

    const vision = fixture.page.getByRole('checkbox', { name: '图片理解 gpt-4o-mini' })
    const ocr = fixture.page.getByRole('checkbox', { name: '图片文字识别 gpt-4o-mini' })
    await vision.click()
    await expect(vision).toBeChecked()
    await expect(ocr).toBeChecked()
    await expect(fixture.page.getByRole('radio', { name: '默认 gpt-4o-mini' })).toBeChecked()

    await fixture.page.getByText('高级设置', { exact: true }).click()
    await expect(fixture.page.getByLabel('请求超时（ms）')).toHaveValue('120000')
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(
      await fixture.page
        .locator('.settings-page-scroll')
        .evaluate((element) => element.scrollWidth <= element.clientWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('SETTINGS-07 voice recognition controls keep selection semantics at a narrow viewport', async () => {
  const fixture = await launchTestApp()
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize({ width: 820, height: 600 })
    await fixture.page
      .getByRole('navigation', { name: '一级导航' })
      .getByRole('button', { name: '设置' })
      .click()
    await fixture.page.getByRole('button', { name: '语音转文字' }).click()
    await expect(fixture.page.getByRole('heading', { name: '语音转文字' })).toBeVisible()

    const categoryTabs = fixture.page.getByRole('tablist', { name: '会话类别' })
    await categoryTabs.scrollIntoViewIfNeeded()
    await expect(categoryTabs.getByRole('tab', { name: /群聊/ })).toHaveAttribute(
      'data-state',
      'active'
    )
    const conversation = fixture.page.getByRole('checkbox', { name: /产品测试群/ })
    await conversation.click()
    await expect(conversation).toBeChecked()

    const rangeSelect = fixture.page.getByRole('combobox', { name: '语音转写时间范围' })
    await rangeSelect.click()
    await expect(fixture.page.getByRole('option', { name: '所选会话全部历史' })).toBeVisible()
    await fixture.page.keyboard.press('Escape')
    await expect(rangeSelect).toBeFocused()
    await expect(fixture.page.getByRole('button', { name: '开始转写' })).toBeDisabled()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(
      await fixture.page
        .locator('.settings-page-scroll')
        .evaluate((element) => element.scrollWidth <= element.clientWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('AGENT-01 Agent Hub controls stay usable in the offline narrow layout', async () => {
  const fixture = await launchTestApp()
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize({ width: 820, height: 600 })
    await fixture.page.getByRole('button', { name: 'Agent' }).click()
    await expect(fixture.page.getByRole('heading', { name: 'Agent Hub' })).toBeVisible()
    await expect(fixture.page.getByText('Agent Hub 未运行')).toBeVisible()
    await expect(fixture.page.getByRole('button', { name: '扫码登录微信机器人' })).toBeDisabled()

    const logSource = fixture.page.getByRole('combobox', { name: '筛选日志来源' })
    await logSource.scrollIntoViewIfNeeded()
    await logSource.click()
    await expect(fixture.page.getByRole('option', { name: '微信连接器' })).toBeVisible()
    await fixture.page.keyboard.press('Escape')
    await expect(logSource).toBeFocused()
    await expect(fixture.page.getByRole('button', { name: '复制日志' })).toBeDisabled()
    await fixture.page.getByRole('button', { name: '清空' }).click()

    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(
      await fixture.page
        .locator('.agent-hub-workspace')
        .evaluate((element) => element.scrollWidth <= element.clientWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('API-01 manages the local API token and previews the Reader Skill safely', async () => {
  const fixture = await launchTestApp()
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize({ width: 1000, height: 650 })
    await fixture.page.getByRole('button', { name: 'API' }).click()
    await expect(fixture.page.getByText('API Token', { exact: true })).toBeVisible()
    await expect(fixture.page.getByText('••••••••••••••••')).toBeVisible()
    await expect(fixture.page.getByText('fixture-api-token')).toHaveCount(0)

    await fixture.page.getByRole('button', { name: '显示 Token' }).click()
    await expect(fixture.page.getByText('fixture-api-token')).toBeVisible()

    fixture.page.once('dialog', (dialog) => dialog.accept())
    await fixture.page.getByRole('button', { name: '重新生成 Token' }).click()
    await expect(fixture.page.getByText('Token 已生成')).toBeVisible()

    const moreTrigger = fixture.page
      .locator('#api-reader-skill')
      .getByRole('button', { name: '更多' })
    await moreTrigger.click()
    await expect(fixture.page.getByRole('menuitem', { name: '打开本地文件夹' })).toBeVisible()
    await fixture.page.keyboard.press('Escape')
    await expect(fixture.page.getByRole('menu')).toHaveCount(0)
    await expect(moreTrigger).toBeFocused()

    const previewTrigger = fixture.page
      .locator('#api-reader-skill')
      .getByRole('button', { name: '预览 Skill' })
    await expect(previewTrigger).toBeEnabled()
    await previewTrigger.click()
    const previewDialog = fixture.page.getByRole('dialog', {
      name: 'TraceMemo Reader Skill 预览'
    })
    await expect(previewDialog).toBeVisible()
    await expect(previewDialog.getByRole('heading', { name: '能力' })).toBeVisible()
    await previewDialog.getByRole('button', { name: '原始文本' }).click()
    await expect(previewDialog.getByText(/# TraceMemo Reader/)).toBeVisible()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(
      await previewDialog.evaluate((element) => element.scrollWidth <= element.clientWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])

    await fixture.page.keyboard.press('Escape')
    await expect(previewDialog).toHaveCount(0)
    await expect(previewTrigger).toBeFocused()
  } finally {
    await fixture.close()
  }
})

test('EXPORT-01 multi-chat selection stays local to export and forces HTML', async () => {
  const fixture = await launchTestApp()
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize({ width: 1000, height: 650 })
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
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])

    await navigation.getByRole('button', { name: '档案' }).click()
    await expect(fixture.page.getByText('转发多条内容', { exact: true })).toBeVisible()
  } finally {
    await fixture.close()
  }
})

test('EXPORT-02 large contact list stays bounded and searchable', async () => {
  const fixture = await launchTestApp({ largeContacts: 1500 })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize({ width: 1400, height: 772 })
    await fixture.page.getByRole('button', { name: '导出' }).click()
    await expect(fixture.page.getByText('共 1,503 个')).toBeVisible()

    const contactList = fixture.page.locator('.export-contact-list')
    expect(await contactList.getByRole('button').count()).toBeLessThan(50)

    const compositeButtons = [
      fixture.page.getByRole('button', { name: /^全部导出/ }),
      fixture.page.getByRole('button', { name: /HTML/ }),
      fixture.page.locator('.export-workspace > aside:first-child > button:last-child')
    ]
    for (const button of compositeButtons) {
      await expect(button).toBeVisible()
      expect(
        await button.evaluate(
          (element) => element.scrollHeight <= element.clientHeight && element.clientHeight > 32
        )
      ).toBe(true)
    }

    const previewGeometryIsStable = await fixture.page
      .locator('.export-workspace > aside:last-child')
      .evaluate((previewPanel) => {
        const scrollRegion = previewPanel.children.item(1)
        const statistics = previewPanel.children.item(2)
        if (!(scrollRegion instanceof HTMLElement) || !(statistics instanceof HTMLElement)) {
          return false
        }
        const panelRect = previewPanel.getBoundingClientRect()
        const scrollRect = scrollRegion.getBoundingClientRect()
        const statisticsRect = statistics.getBoundingClientRect()
        return (
          scrollRect.bottom <= statisticsRect.top &&
          statisticsRect.bottom <= panelRect.bottom &&
          statistics.scrollHeight <= statistics.clientHeight
        )
      })
    expect(previewGeometryIsStable).toBe(true)

    await fixture.page.getByRole('textbox', { name: '搜索聊天' }).fill('性能样本 1499')
    const target = contactList.getByRole('button', { name: /性能样本 1499/ })
    await expect(target).toBeVisible()
    await target.click()
    await expect(target).toHaveAttribute('aria-pressed', 'true')
    expect(pageErrors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('LAYOUT-01 core workspaces fit a narrow desktop viewport without page errors', async () => {
  const fixture = await launchTestApp()
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize({ width: 820, height: 600 })
    const navigation = fixture.page.getByRole('navigation', { name: '一级导航' })
    for (const pageName of ['档案', '问问微信', '日报', '导出', 'API', '设置']) {
      await navigation.getByRole('button', { name: pageName }).click()
      await expect(fixture.page.locator('main.app-shell-main')).not.toBeEmpty()
      expect(
        await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
    }
    expect(pageErrors).toEqual([])
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
    const imageTrigger = fixture.page.getByRole('button', { name: '查看图片' })
    await imageTrigger.click()
    const imageDialog = fixture.page.getByRole('dialog', { name: '图片查看' })
    await expect(imageDialog).toBeVisible()
    await imageDialog.getByRole('button', { name: '放大' }).click()
    await expect(imageDialog.getByText('110%')).toBeVisible()
    await imageDialog.getByRole('button', { name: '右旋转' }).click()
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    await fixture.page.keyboard.press('Escape')
    await expect(imageDialog).toHaveCount(0)
    await expect(imageTrigger).toBeFocused()

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
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await fixture.setWindowContentSize({ width: 820, height: 600 })
    await fixture.page.getByRole('button', { name: '问问微信' }).click()
    await fixture.page.getByPlaceholder(/例如：技术交流群/).fill('测试群讨论了什么？')
    await fixture.page.getByRole('button', { name: '开始分析' }).click()
    await expect(fixture.page.getByText(/固定假回答：测试数据中的核心流程正常/)).toBeVisible({
      timeout: 15_000
    })
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    expect(pageErrors).toEqual([])
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
    const textModel = fixture.page.getByRole('combobox', { name: '文字总结模型' })
    const visionModel = fixture.page.getByRole('combobox', { name: '图片理解模型' })
    await expect(textModel).toContainText('固定响应模型')
    await expect(visionModel).toContainText('固定图片识别模型')
    await textModel.click()
    await expect(fixture.page.getByRole('option')).toHaveCount(2)
    await fixture.page.keyboard.press('Escape')
    await expect(textModel).toBeFocused()
    await visionModel.click()
    await expect(fixture.page.getByRole('option')).toHaveCount(1)
    await fixture.page.keyboard.press('Escape')
    await expect(visionModel).toBeFocused()
    await fixture.page.locator('.report-source-item').filter({ hasText: '产品测试群' }).click()
    await fixture.page.getByRole('radio', { name: '近 7 天' }).click()
    const generate = fixture.page.getByRole('button', { name: '开始生成日报' })
    await expect(generate).toBeEnabled()
    await generate.click()
    await expect(fixture.page.getByAltText('产品测试群 群聊日报')).toBeVisible({
      timeout: 15_000
    })
    await expect(fixture.page.getByText('文字模型')).toBeVisible()
    await expect(fixture.page.getByText('固定响应模型')).toBeVisible()
    await expect(fixture.page.getByText('图片模型')).toBeVisible()
    await expect(fixture.page.getByText('固定图片识别模型')).toBeVisible()
    await expect(fixture.page.getByRole('menuitem', { name: '生成微信卡片' })).toHaveCount(0)
    const moreButton = fixture.page.getByRole('button', { name: '更多' })
    await moreButton.click()
    await fixture.page.getByRole('menuitem', { name: '生成微信卡片' }).click()
    const shareDialog = fixture.page.getByRole('dialog', { name: '生成微信分享卡片' })
    await expect(shareDialog).toBeVisible()
    await expect(shareDialog.locator('input').first()).toHaveValue(/产品测试群日报/)
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    await fixture.page.keyboard.press('Escape')
    await expect(shareDialog).toHaveCount(0)
    await expect(moreButton).toBeFocused()

    await fixture.setWindowContentSize({ width: 1024, height: 760 })
    const reportTitle = fixture.page.getByRole('heading', { name: '产品测试群 群聊日报' })
    await expect(reportTitle).toBeVisible()
    expect((await reportTitle.boundingBox())?.width || 0).toBeGreaterThan(170)
    await expect(fixture.page.getByRole('button', { name: '放大' })).toBeEnabled()
    await fixture.page.getByRole('button', { name: '放大' }).click()

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
    await fixture.page.getByRole('radio', { name: '近 7 天' }).click()
    await fixture.page.getByRole('button', { name: '开始生成日报' }).click()
    await expect(fixture.page.getByText(/本地假服务错误 401/).first()).toBeVisible()
    await expect(fixture.page.getByRole('button', { name: '使用所选模型重新生成' })).toBeEnabled()
    await expect(fixture.page.getByText(/从第三步继续/)).toBeVisible()
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
