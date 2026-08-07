import { expect, test } from '@playwright/test'
import { execFileSync } from 'child_process'
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'
import { ZipArchive } from 'archiver'
import { renderExportPage } from '../../src/main/export-html-template'
import type { Message } from '../../src/shared/types'

const archiveMessage = (
  id: string,
  conversationId: string,
  conversationName: string,
  content: string,
  createTime: number
): Message => ({
  id,
  from: 'user',
  type: '普通文本',
  datetime: '',
  content,
  isSender: false,
  name: '脱敏成员',
  createTime,
  exportConversationId: conversationId,
  exportConversationName: conversationName
})

const zipDirectory = async (
  sourceDir: string,
  zipPath: string,
  folderName: string
): Promise<void> => {
  const output = createWriteStream(zipPath)
  const archive = new ZipArchive({ zlib: { level: 6 } })
  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve)
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    archive.directory(sourceDir, folderName)
    void archive.finalize().catch(reject)
  })
}

test('EXPORT-ARCHIVE-00 shows a loading state while archive data is still loading', async ({
  page
}, testInfo) => {
  let releaseData!: () => void
  const dataReady = new Promise<void>((resolve) => {
    releaseData = resolve
  })

  await page.route('http://archive.test/**', async (route) => {
    if (route.request().url().endsWith('/data/messages.js')) {
      await dataReady
      await route.fulfill({
        contentType: 'application/javascript',
        body: `window.__WECHAT_EXPORT__ = ${JSON.stringify({
          version: 1,
          sourceId: 'loading-fixture',
          name: '大量消息',
          exportedAt: '2026-08-05T00:00:00.000Z',
          messages: [
            archiveMessage('loading-1', 'loading-fixture', '大量消息', '加载完成', 1_767_225_600)
          ]
        })};`
      })
      return
    }

    await route.fulfill({
      contentType: 'text/html',
      body: renderExportPage('大量消息')
    })
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  const navigation = page.goto('http://archive.test/index.html')
  const loading = page.locator('#archive-loading')
  await expect(loading).toBeVisible()
  await expect(loading).toContainText('正在加载聊天档案')
  await expect(loading).toHaveAttribute('aria-busy', 'true')
  await page.screenshot({ path: testInfo.outputPath('archive-loading-1440.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(loading).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('archive-loading-390.png') })

  releaseData()
  await navigation
  await expect(loading).toBeHidden()
  await expect(page.getByText('加载完成')).toBeVisible()
})

test('EXPORT-ARCHIVE-01 merged v2 archive is usable offline on desktop and mobile', async ({
  page
}, testInfo) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'wxe-merged-archive-e2e-'))
  const outputDir = join(fixtureRoot, 'source')
  try {
    const dataPath = join(outputDir, 'data', 'messages.js')
    mkdirSync(dirname(dataPath), { recursive: true })
    writeFileSync(join(outputDir, 'index.html'), renderExportPage('合并聊天档案'), 'utf8')
    writeFileSync(
      dataPath,
      `window.__WECHAT_EXPORT__ = ${JSON.stringify({
        version: 2,
        name: '合并聊天档案',
        exportedAt: '2026-08-04T00:00:00.000Z',
        conversations: [
          {
            id: 'alpha',
            name: '项目群',
            type: 'group',
            avatarUrl:
              "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath fill='%23176b57' d='M0 0h10v10H0z'/%3E%3C/svg%3E",
            messageCount: 3
          },
          {
            id: 'beta',
            name: '文件传输助手',
            type: 'user',
            avatarUrl:
              "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath fill='%23d9f0e2' d='M0 0h10v10H0z'/%3E%3C/svg%3E",
            messageCount: 1
          }
        ],
        messages: [
          archiveMessage('alpha-1', 'alpha', '项目群', '项目群第一条', 1_764_547_200),
          archiveMessage('beta-1', 'beta', '文件传输助手', '个人聊天消息', 1_769_904_000),
          archiveMessage('alpha-2', 'alpha', '项目群', '项目群第二条', 1_769_990_400),
          {
            ...archiveMessage(
              'alpha-sent',
              'alpha',
              'Jamie',
              '那边多少度呀 热不，这是用于验证移动端右侧头像不会被裁切的消息',
              1_775_315_283
            ),
            isSender: true,
            name: 'Nanin'
          }
        ]
      })};\n`,
      'utf8'
    )
    const zipPath = join(fixtureRoot, 'merged-archive.zip')
    const extractedDir = join(fixtureRoot, 'extracted')
    await zipDirectory(outputDir, zipPath, '合并聊天档案')
    mkdirSync(extractedDir, { recursive: true })
    execFileSync('unzip', ['-q', zipPath, '-d', extractedDir])
    const offlineIndex = join(extractedDir, '合并聊天档案', 'index.html')

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(pathToFileURL(offlineIndex).href)
    const conversationTrigger = page.getByRole('button', { name: '筛选聊天' })
    const conversationMenu = page.getByRole('listbox', { name: '选择聊天' })
    const chooseConversation = async (name: string): Promise<void> => {
      await conversationTrigger.click()
      await conversationMenu.getByRole('option', { name, exact: true }).click()
    }
    await expect(conversationTrigger).toHaveAttribute('aria-expanded', 'false')
    await expect(conversationMenu).toBeHidden()
    await expect(conversationTrigger.locator('.conversation-switch-icon')).toBeVisible()
    await expect(
      conversationTrigger.locator('.conversation-trigger-name + .conversation-switch-icon')
    ).toBeVisible()
    await expect(conversationTrigger.locator('.conversation-chevron')).toHaveCount(0)
    await expect(page.locator('#conversation-trigger-name')).toHaveText('全部聊天')
    await expect(page.locator('#conversation-trigger-avatar img')).toHaveCount(2)
    await expect(page.locator('#archive-title')).toBeHidden()
    await expect(page.locator('.archive-heading #conversation-filter')).toBeVisible()
    await expect(page.locator('#archive-meta')).toHaveCount(0)
    await expect(page.locator('.message')).toHaveCount(4)
    await expect(page.locator('.conversation-source')).toHaveCount(4)
    const desktopSwitcherBounds = await page.evaluate(() => {
      const trigger = document.querySelector('#conversation-trigger')!.getBoundingClientRect()
      const name = document.querySelector('#conversation-trigger-name')!.getBoundingClientRect()
      const icon = document.querySelector('.conversation-switch-icon')!.getBoundingClientRect()
      return { triggerWidth: trigger.width, nameToIcon: icon.left - name.right }
    })
    expect(desktopSwitcherBounds.triggerWidth).toBeLessThan(200)
    expect(desktopSwitcherBounds.nameToIcon).toBeLessThanOrEqual(12)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    await conversationTrigger.click()
    await expect(conversationTrigger).toHaveAttribute('aria-expanded', 'true')
    await expect(conversationMenu).toBeVisible()
    await expect(conversationMenu.getByRole('option')).toHaveCount(3)
    await expect(conversationMenu.getByRole('option', { name: '全部聊天' })).toBeVisible()
    await expect(conversationMenu.getByRole('option', { name: '项目群' })).toBeVisible()
    await expect(conversationMenu.getByRole('option', { name: '文件传输助手' })).toBeVisible()
    await expect(conversationMenu).not.toContainText('条消息')
    await expect(conversationMenu.getByRole('option', { name: '全部聊天' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(conversationTrigger).toHaveCSS('border-top-width', '0px')
    await page.screenshot({ path: testInfo.outputPath('conversation-menu-1440.png') })
    await page.keyboard.press('Escape')
    await expect(conversationMenu).toBeHidden()
    await page.screenshot({ path: testInfo.outputPath('merged-archive-1440.png'), fullPage: true })

    await chooseConversation('文件传输助手')
    await expect(page.locator('.message')).toHaveCount(1)
    await expect(page.locator('#conversation-trigger-name')).toHaveText('文件传输助手')
    await expect(page.locator('#conversation-trigger-avatar img')).toHaveCount(1)
    await expect(page.locator('.conversation-source')).toHaveCount(0)

    await chooseConversation('全部聊天')
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('.timeline-year')).toHaveCount(2)
    await expect(page.locator('.timeline-year').first()).toBeVisible()
    await expect(page.locator('.timeline-year').first()).toHaveText('2025 年')
    const positions = await page.evaluate(() => {
      const conversations = document.querySelector('#conversation-filter')!.getBoundingClientRect()
      const toolbar = document.querySelector('.toolbar')!.getBoundingClientRect()
      const timeline = document.querySelector('#timeline')!.getBoundingClientRect()
      return {
        conversationTop: conversations.top,
        conversationBottom: conversations.bottom,
        toolbarTop: toolbar.top,
        toolbarBottom: toolbar.bottom,
        timelineTop: timeline.top,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth
      }
    })
    expect(positions.conversationTop).toBeGreaterThanOrEqual(positions.toolbarTop)
    expect(positions.conversationBottom).toBeLessThanOrEqual(positions.toolbarBottom)
    expect(positions.timelineTop).toBeGreaterThanOrEqual(positions.toolbarBottom)
    expect(positions.documentWidth).toBeLessThanOrEqual(positions.viewportWidth)
    await expect(page.locator('.message')).toHaveCount(4)
    const searchInput = page.getByLabel('搜索消息')
    await expect(conversationTrigger).toBeVisible()
    const compactControlBounds = await page.evaluate(() => {
      const conversations = document.querySelector('#conversation-filter')!.getBoundingClientRect()
      const search = document.querySelector('#query')!.getBoundingClientRect()
      return {
        conversationTop: conversations.top,
        conversationBottom: conversations.bottom,
        conversationWidth: conversations.width,
        searchTop: search.top,
        searchBottom: search.bottom,
        searchWidth: search.width,
        searchFontSize: getComputedStyle(document.querySelector('#query')!).fontSize
      }
    })
    expect(
      Math.abs(compactControlBounds.conversationTop - compactControlBounds.searchTop)
    ).toBeLessThanOrEqual(1)
    expect(
      Math.abs(compactControlBounds.conversationBottom - compactControlBounds.searchBottom)
    ).toBeLessThanOrEqual(1)
    expect(compactControlBounds.searchWidth).toBeGreaterThan(compactControlBounds.conversationWidth)
    expect(compactControlBounds.searchFontSize).toBe('16px')
    const personalMessageContent = page
      .locator('.message')
      .filter({ hasText: '个人聊天消息' })
      .locator('.content')
    const expectPersonalMessageOnOneLine = async (): Promise<void> => {
      const metrics = await personalMessageContent.evaluate((element) => {
        const styles = getComputedStyle(element)
        return {
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(styles.lineHeight)
        }
      })
      expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight + 1)
    }
    await expectPersonalMessageOnOneLine()
    await expect(conversationTrigger.locator('.conversation-switch-icon')).toHaveCSS(
      'width',
      '13px'
    )
    await conversationTrigger.click()
    await expect(conversationMenu).toBeVisible()
    const mobileMenuBounds = await conversationMenu.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return { left: bounds.left, right: bounds.right, viewportWidth: window.innerWidth }
    })
    expect(mobileMenuBounds.left).toBeGreaterThanOrEqual(0)
    expect(mobileMenuBounds.right).toBeLessThanOrEqual(mobileMenuBounds.viewportWidth)
    await page.screenshot({ path: testInfo.outputPath('conversation-menu-390.png') })
    await conversationMenu.getByRole('option', { name: '文件传输助手' }).click()
    await expect(page.locator('.message')).toHaveCount(1)
    await chooseConversation('全部聊天')
    await expect(page.locator('.message')).toHaveCount(4)
    await expect(searchInput).toBeVisible()
    await searchInput.fill('个人聊天消息')
    await expect(page.locator('.search-highlight')).toHaveText('个人聊天消息')
    await expectPersonalMessageOnOneLine()
    const mobileSearchResult = page.locator('.message')
    const mobileLocateButton = mobileSearchResult.getByRole('button', {
      name: '定位到聊天位置'
    })
    await mobileSearchResult.hover()
    await expect(mobileLocateButton).toHaveCSS('opacity', '1')
    await page.screenshot({
      path: testInfo.outputPath('search-highlight-390.png'),
      animations: 'disabled'
    })
    await mobileLocateButton.click()
    await expect(searchInput).toHaveValue('')
    await expect(page.locator('.message.located')).toContainText('个人聊天消息')
    const mobileFilterButtons = page.locator('.filter-button:visible')
    await expect(mobileFilterButtons).toHaveCount(7)
    const filterButtonTops = await mobileFilterButtons.evaluateAll((buttons) =>
      buttons.map((button) => button.getBoundingClientRect().top)
    )
    expect(Math.max(...filterButtonTops) - Math.min(...filterButtonTops)).toBeLessThanOrEqual(1)
    const countTop = await page
      .locator('#count')
      .evaluate((element) => element.getBoundingClientRect().top)
    const filterBottom = await mobileFilterButtons
      .first()
      .evaluate((element) => element.getBoundingClientRect().bottom)
    expect(countTop).toBeGreaterThanOrEqual(filterBottom)
    expect(positions.toolbarBottom - positions.toolbarTop).toBeLessThanOrEqual(150)
    await page.getByRole('button', { name: '文字', exact: true }).click()
    const messageList = page.locator('#messages')
    const sentMessageBounds = await page.locator('.message.sent').evaluate((element) => {
      const list = element.parentElement!.getBoundingClientRect()
      const message = element.getBoundingClientRect()
      const row = element.querySelector('.row')!.getBoundingClientRect()
      const avatar = element.querySelector('.avatar')!.getBoundingClientRect()
      return {
        listLeft: list.left,
        listRight: list.right,
        messageLeft: message.left,
        messageRight: message.right,
        rowLeft: row.left,
        rowRight: row.right,
        avatarLeft: avatar.left,
        avatarRight: avatar.right
      }
    })
    expect(Math.abs(sentMessageBounds.rowLeft - sentMessageBounds.messageLeft)).toBeLessThanOrEqual(
      1
    )
    expect(
      Math.abs(sentMessageBounds.rowRight - sentMessageBounds.messageRight)
    ).toBeLessThanOrEqual(1)
    expect(sentMessageBounds.rowLeft).toBeGreaterThanOrEqual(sentMessageBounds.listLeft)
    expect(sentMessageBounds.rowRight).toBeLessThanOrEqual(sentMessageBounds.listRight)
    expect(sentMessageBounds.avatarLeft).toBeGreaterThanOrEqual(sentMessageBounds.listLeft)
    expect(sentMessageBounds.avatarRight).toBeLessThanOrEqual(sentMessageBounds.listRight)
    const mobileScrollBehavior = await messageList.evaluate((element) => {
      const styles = getComputedStyle(element)
      return {
        overflowX: styles.overflowX,
        overscrollBehaviorX: styles.overscrollBehaviorX,
        touchAction: styles.touchAction
      }
    })
    expect(mobileScrollBehavior).toEqual({
      overflowX: 'hidden',
      overscrollBehaviorX: 'none',
      touchAction: 'pan-y'
    })
    await messageList.hover()
    await page.mouse.wheel(80, 120)
    await expect.poll(() => messageList.evaluate((element) => element.scrollLeft)).toBe(0)
    await page.screenshot({ path: testInfo.outputPath('merged-archive-390.png'), fullPage: true })
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('EXPORT-ARCHIVE-02 legacy single-chat archive keeps its original layout', async ({
  page
}, testInfo) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'wxe-single-archive-e2e-'))
  try {
    const dataPath = join(outputDir, 'data', 'messages.js')
    mkdirSync(dirname(dataPath), { recursive: true })
    writeFileSync(join(outputDir, 'index.html'), renderExportPage('单聊天档案'), 'utf8')
    writeFileSync(
      dataPath,
      `window.__WECHAT_EXPORT__ = ${JSON.stringify({
        version: 1,
        sourceId: 'single',
        name: '单聊天档案',
        exportedAt: '2026-08-04T00:00:00.000Z',
        messages: [archiveMessage('single-1', 'single', '单聊天档案', '单聊天消息', 1_767_225_600)]
      })};\n`,
      'utf8'
    )

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(pathToFileURL(join(outputDir, 'index.html')).href)
    await expect(page.locator('#conversation-filter')).toBeHidden()
    await expect(page.locator('#archive-title')).toBeVisible()
    await expect(page.locator('#archive-title')).toHaveText('单聊天档案')
    await expect(page.locator('#archive-meta')).toHaveCount(0)
    await expect(page.locator('.archive-layout')).toHaveClass(/single-conversation/)
    await expect(page.locator('.message')).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('single-archive-1440.png'), fullPage: true })

    await page.setViewportSize({ width: 390, height: 844 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    await expect(page.locator('.message')).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('single-archive-390.png'), fullPage: true })
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('EXPORT-ARCHIVE-04 timeline follows the latest visible month after changing tabs', async ({
  page
}, testInfo) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'wxe-timeline-sync-e2e-'))
  try {
    const dataPath = join(outputDir, 'data', 'messages.js')
    mkdirSync(dirname(dataPath), { recursive: true })
    writeFileSync(join(outputDir, 'index.html'), renderExportPage('时间轴同步档案'), 'utf8')
    const oldVoiceMessages = Array.from({ length: 240 }, (_, index) => ({
      ...archiveMessage(
        `old-voice-${index}`,
        'timeline',
        '时间轴同步档案',
        `旧语音-${index}`,
        Date.UTC(2006 + Math.floor(index / 12), index % 12, 1) / 1000
      ),
      type: '语音'
    }))
    writeFileSync(
      dataPath,
      `window.__WECHAT_EXPORT__ = ${JSON.stringify({
        version: 1,
        sourceId: 'timeline',
        name: '时间轴同步档案',
        exportedAt: '2026-08-04T00:00:00.000Z',
        messages: [
          ...oldVoiceMessages,
          {
            ...archiveMessage(
              'latest-voice',
              'timeline',
              '时间轴同步档案',
              '最新语音',
              1_775_520_000
            ),
            type: '语音'
          }
        ]
      })};\n`,
      'utf8'
    )

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(pathToFileURL(join(outputDir, 'index.html')).href)
    await page.getByRole('button', { name: '语音', exact: true }).click()

    const messages = page.locator('#messages')
    const activeMonth = page.locator('.timeline-month.active')
    await expect(activeMonth).toHaveAttribute('data-month', '2026-04')
    const expandedYear = page.locator('.timeline-year[aria-expanded="true"]')
    const latestYear = page.locator('.timeline-year[data-year="2026"]')
    await expect(expandedYear).toHaveCount(1)
    await expect(expandedYear).toHaveText('2026 年')
    await expect(page.locator('.timeline-month:visible')).toHaveCount(1)
    await latestYear.click()
    await expect(latestYear).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.timeline-month:visible')).toHaveCount(0)
    await latestYear.click()
    await expect(latestYear).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.timeline-month:visible')).toHaveCount(1)
    await expect(page.locator('#archive-loading')).toBeHidden()
    await page.screenshot({ path: testInfo.outputPath('timeline-collapsed-1440.png') })
    expect(
      await messages.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    ).toBeLessThanOrEqual(2)
    const timelinePosition = await activeMonth.evaluate((element) => {
      const button = element.getBoundingClientRect()
      const timeline = element.parentElement!.getBoundingClientRect()
      return {
        buttonTop: button.top,
        buttonBottom: button.bottom,
        timelineTop: timeline.top,
        timelineBottom: timeline.bottom
      }
    })
    expect(timelinePosition.buttonTop).toBeGreaterThanOrEqual(timelinePosition.timelineTop)
    expect(timelinePosition.buttonBottom).toBeLessThanOrEqual(timelinePosition.timelineBottom + 1)

    const selectedYear = page.locator('.timeline-year[data-year="2020"]')
    await selectedYear.click()
    await expect(expandedYear).toHaveText('2020 年')
    await expect(selectedYear).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.timeline-year[data-year="2026"]')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    await expect(page.locator('.timeline-month:visible')).toHaveCount(12)
    const selectedMonth = page.locator('.timeline-month[data-month="2020-07"]')
    await selectedMonth.click()
    await expect(selectedMonth).toHaveClass(/active/)
    await expect(activeMonth).toHaveAttribute('data-month', '2020-07')
    const visibleMonths = await messages.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const anchor = bounds.top + Math.min(24, bounds.height / 4)
      const items = Array.from(element.querySelectorAll<HTMLElement>('.message'))
      return {
        firstVisible: items.find((item) => item.getBoundingClientRect().bottom > bounds.top)
          ?.dataset.month,
        firstAnchored: items.find((item) => item.getBoundingClientRect().bottom > anchor)?.dataset
          .month
      }
    })
    expect(visibleMonths).toEqual({ firstVisible: '2020-06', firstAnchored: '2020-07' })

    await messages.evaluate((element) => {
      element.scrollTop = 0
    })
    await expect(activeMonth).toHaveAttribute('data-month', '2006-01')
    await expect(expandedYear).toHaveText('2006 年')
    await expect(page.locator('.timeline-month:visible')).toHaveCount(12)
    await page.setViewportSize({ width: 390, height: 844 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    const mobileLayoutBounds = await page.evaluate(() => {
      const layout = document.querySelector('.archive-layout')!.getBoundingClientRect()
      const messages = document.querySelector('#messages')!.getBoundingClientRect()
      return {
        viewportWidth: window.innerWidth,
        layoutLeft: layout.left,
        layoutRight: layout.right,
        messagesLeft: messages.left,
        messagesRight: messages.right
      }
    })
    expect(mobileLayoutBounds.layoutLeft).toBeGreaterThanOrEqual(0)
    expect(mobileLayoutBounds.layoutRight).toBeLessThanOrEqual(mobileLayoutBounds.viewportWidth)
    expect(mobileLayoutBounds.messagesLeft).toBeGreaterThanOrEqual(0)
    expect(mobileLayoutBounds.messagesRight).toBeLessThanOrEqual(mobileLayoutBounds.viewportWidth)
    await expect(expandedYear).toHaveText('2006 年')
    await page.screenshot({ path: testInfo.outputPath('timeline-collapsed-390.png') })
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('EXPORT-ARCHIVE-05 each message tab restores its previous scroll anchor', async ({ page }) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'wxe-tab-position-e2e-'))
  try {
    const dataPath = join(outputDir, 'data', 'messages.js')
    mkdirSync(dirname(dataPath), { recursive: true })
    writeFileSync(join(outputDir, 'index.html'), renderExportPage('Tab 位置档案'), 'utf8')
    const messages = Array.from({ length: 600 }, (_, index) => ({
      ...archiveMessage(
        `message-${index}`,
        'tab-position',
        'Tab 位置档案',
        `${index % 2 === 0 ? '文字' : '语音'}消息-${index}`,
        1_735_689_600 + index * 86_400
      ),
      type: index % 2 === 0 ? '普通文本' : '语音'
    }))
    writeFileSync(
      dataPath,
      `window.__WECHAT_EXPORT__ = ${JSON.stringify({
        version: 1,
        sourceId: 'tab-position',
        name: 'Tab 位置档案',
        exportedAt: '2026-08-04T00:00:00.000Z',
        messages
      })};\n`,
      'utf8'
    )

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(pathToFileURL(join(outputDir, 'index.html')).href)
    await page.getByRole('button', { name: '文字', exact: true }).click()

    const messageList = page.locator('#messages')
    const target = page.locator('.message[data-index="100"]')
    await target.evaluate((element) => {
      const list = element.parentElement!
      list.scrollTop += element.getBoundingClientRect().top - list.getBoundingClientRect().top - 37
    })
    await expect(target).toBeInViewport()
    const before = await target.evaluate((element) => {
      const message = element.getBoundingClientRect()
      const list = element.parentElement!.getBoundingClientRect()
      return message.top - list.top
    })

    await page.getByRole('button', { name: '语音', exact: true }).click()
    await page.getByRole('button', { name: '文字', exact: true }).click()

    await expect(target).toBeInViewport()
    const after = await target.evaluate((element) => {
      const message = element.getBoundingClientRect()
      const list = element.parentElement!.getBoundingClientRect()
      return message.top - list.top
    })
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1)
    expect(
      await messageList.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight
      )
    ).toBeGreaterThan(100)
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('EXPORT-ARCHIVE-03 renders shares and locations, and groups payments under system', async ({
  page
}, testInfo) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'wxe-structured-archive-e2e-'))
  try {
    const dataPath = join(outputDir, 'data', 'messages.js')
    mkdirSync(dirname(dataPath), { recursive: true })
    writeFileSync(join(outputDir, 'index.html'), renderExportPage('结构化消息档案'), 'utf8')
    const message = (
      id: string,
      type: string,
      createTime: number,
      contentData: Message['contentData']
    ): Message => ({
      ...archiveMessage(id, 'structured', '结构化消息档案', '', createTime),
      type,
      contentData
    })
    writeFileSync(
      dataPath,
      `window.__WECHAT_EXPORT__ = ${JSON.stringify({
        version: 1,
        sourceId: 'structured',
        name: '结构化消息档案',
        exportedAt: '2026-08-04T12:57:32.000Z',
        messages: [
          message('article', '公众号链接', 1_775_000_001, {
            type: 'share',
            typeVal: '5',
            title: '真正的公众号标题',
            des: '文章摘要与关键内容',
            appname: '示例公众号',
            url: 'https://example.com/article?a=1&amp;b=2'
          }),
          message('mini', '小程序', 1_775_000_002, {
            type: 'miniProgram',
            title: '小程序商品标题',
            description: '商品的真实描述',
            appName: '示例小程序'
          }),
          message('channel', '视频号', 1_775_000_003, {
            type: 'share',
            typeVal: '51',
            title: '当前微信版本不支持展示该内容，请升级至最新版本。',
            des: '视频号真实标题\n视频号正文内容',
            url: 'https://example.com/channel'
          }),
          message('forward', '合并转发', 1_775_000_004, {
            type: 'forwardBundle',
            title: '项目群的聊天记录',
            description: '项目成员: 项目结论',
            items: [
              {
                messageType: 1,
                sender: '项目成员',
                sentAt: '2026-08-04 20:00',
                text: '项目结论已经确认'
              }
            ]
          }),
          message('red-packet', '微信红包', 1_775_000_005, {
            type: 'redPacket',
            title: '微信红包',
            description: '我给你发了一个红包'
          }),
          message('transfer', '转账', 1_775_000_006, {
            type: 'share',
            typeVal: '2000',
            title: '微信转账',
            des: '收到转账￥1000.00元',
            url: ''
          }),
          message('voip', '通话', 1_775_000_007, {
            type: 'voip',
            status: '通话时长 2分15秒'
          }),
          message('location', '位置', 1_775_000_008, {
            type: 'location',
            poiname: '望和公园南园',
            label: '北京市朝阳区望京街道北四环东路41号望和公园',
            lat: 39.986984,
            lng: 116.448578
          }),
          {
            ...message('legacy-recall', '系统消息', 1_775_000_009, {
              type: 'system',
              content: '"联系人" 撤回了一条消息'
            }),
            from: 'system',
            content: '"联系人" 撤回了一条消息',
            name: ''
          },
          {
            ...message('structured-recall', '系统消息', 1_775_000_010, {
              type: 'system',
              content: '你撤回了一条消息',
              recall: {
                targetId: 'fixture-target',
                replacement: '你撤回了一条消息',
                actor: '你'
              }
            }),
            from: 'system',
            content: '你撤回了一条消息',
            name: ''
          },
          {
            ...message('location-sharing-ended', '系统消息', 1_775_000_011, {
              type: 'system',
              content: '位置共享已经结束'
            }),
            from: 'system',
            content: '位置共享已经结束',
            name: ''
          }
        ]
      })};\n`,
      'utf8'
    )

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(pathToFileURL(join(outputDir, 'index.html')).href)
    await expect(page.locator('[data-rich-kind="share"]')).toHaveCount(2)
    await expect(page.getByText('真正的公众号标题')).toBeVisible()
    await expect(page.getByText('文章摘要与关键内容')).toBeVisible()
    await expect(page.getByText('小程序商品标题')).toBeVisible()
    await expect(page.getByText('视频号真实标题')).toBeVisible()
    await expect(page.getByText('当前微信版本不支持展示该内容，请升级至最新版本。')).toHaveCount(0)
    await expect(page.getByText('项目群的聊天记录')).toBeVisible()
    await page.getByText('展开 1 条消息').click()
    await expect(page.getByText('项目结论已经确认')).toBeVisible()

    const searchInput = page.getByLabel('搜索消息')
    await searchInput.fill('真正的公众号标题')
    await expect(page.locator('.message')).toHaveCount(1)
    await expect(page.locator('.search-highlight')).toHaveText('真正的公众号标题')
    const searchResult = page.locator('.message')
    await searchResult.hover()
    await page.screenshot({
      path: testInfo.outputPath('search-highlight-1440.png'),
      animations: 'disabled'
    })
    await searchResult.getByRole('button', { name: '定位到聊天位置' }).click()
    await expect(searchInput).toHaveValue('')
    await expect(page.getByRole('button', { name: '全部', exact: true })).toHaveClass(/active/)
    await expect(page.locator('.search-highlight')).toHaveCount(0)
    await expect(page.locator('.message.located')).toContainText('真正的公众号标题')

    await page.getByRole('button', { name: '分享', exact: true }).click()
    await expect(page.locator('.message')).toHaveCount(5)
    await expect(page.locator('[data-rich-kind="forwardBundle"]')).toHaveCount(1)
    const locationCard = page.locator('[data-rich-kind="location"]')
    await expect(locationCard).toHaveCount(1)
    await expect(locationCard.getByText('望和公园南园')).toBeVisible()
    await expect(locationCard.getByText('北京市朝阳区望京街道北四环东路41号望和公园')).toBeVisible()
    await expect(locationCard.getByText('39.986984, 116.448578')).toBeVisible()
    await expect(locationCard.getByText('在地图中打开')).toBeVisible()
    await expect(locationCard.locator('xpath=ancestor::a')).toHaveAttribute(
      'href',
      /^https:\/\/maps\.apple\.com\/\?q=.*&ll=39\.986984,116\.448578$/
    )
    await expect(page.locator('.content', { hasText: '[位置]' })).toHaveCount(0)
    await expect(page.locator('[data-rich-kind="transfer"]')).toHaveCount(0)
    const locationMessage = locationCard.locator('xpath=ancestor::article')
    const locateButton = locationMessage.getByRole('button', { name: '定位到聊天位置' })
    const locateLabel = locateButton.locator('.locate-label')
    await page.mouse.move(0, 0)
    await expect(locateButton).toHaveCSS('opacity', '0')
    await locationMessage.hover()
    await expect(locateButton).toHaveCSS('opacity', '1')
    await expect(locateLabel).toHaveCSS('opacity', '0')
    await locateButton.hover()
    await expect(locateLabel).toHaveCSS('opacity', '1')
    await page.screenshot({ path: testInfo.outputPath('locate-hover-1440.png') })
    await locateButton.click()
    await expect(page.getByRole('button', { name: '全部', exact: true })).toHaveClass(/active/)
    await expect(page.locator('.message.located')).toContainText('望和公园南园')
    const locatedPosition = await page.locator('.message.located').evaluate((element) => {
      const messageRect = element.getBoundingClientRect()
      const listRect = element.parentElement!.getBoundingClientRect()
      return {
        messageTop: messageRect.top,
        messageBottom: messageRect.bottom,
        listTop: listRect.top,
        listBottom: listRect.bottom
      }
    })
    expect(locatedPosition.messageBottom).toBeGreaterThan(locatedPosition.listTop)
    expect(locatedPosition.messageTop).toBeLessThan(locatedPosition.listBottom)
    await page.locator('#messages').evaluate((element) => {
      element.scrollTop = 0
    })
    await page.screenshot({
      path: testInfo.outputPath('structured-archive-1440.png'),
      fullPage: true
    })

    await page.getByRole('button', { name: '系统', exact: true }).click()
    await expect(page.locator('.message')).toHaveCount(6)
    await expect(page.getByText('我给你发了一个红包')).toBeVisible()
    await expect(page.getByText('收到转账￥1000.00元')).toBeVisible()
    await expect(page.getByText('通话时长 2分15秒')).toBeVisible()
    const systemNotices = page.locator('.message.system')
    await expect(systemNotices).toHaveCount(3)
    const recallNotices = systemNotices.filter({ hasText: '撤回了一条消息' })
    await expect(recallNotices).toHaveCount(2)
    await expect(recallNotices.locator('.avatar')).toHaveCount(0)
    await expect(recallNotices.locator('.sender').first()).toBeHidden()
    const recallLineMetrics = await recallNotices
      .first()
      .locator('.content')
      .evaluate((element) => {
        const styles = window.getComputedStyle(element)
        return {
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(styles.lineHeight)
        }
      })
    expect(recallLineMetrics.height).toBeLessThanOrEqual(recallLineMetrics.lineHeight + 1)
    const locationNotice = systemNotices.filter({ hasText: '位置共享已经结束' })
    await expect(locationNotice).toHaveCount(1)
    await expect(locationNotice.locator('.avatar')).toHaveCount(0)
    const recallAlignment = await recallNotices.first().evaluate((element) => {
      const messageRect = element.getBoundingClientRect()
      const bubbleRect = element.querySelector('.bubble')!.getBoundingClientRect()
      return Math.abs(
        messageRect.left + messageRect.width / 2 - (bubbleRect.left + bubbleRect.width / 2)
      )
    })
    expect(recallAlignment).toBeLessThan(1)
    await page.setViewportSize({ width: 390, height: 844 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    await page.screenshot({
      path: testInfo.outputPath('structured-archive-390.png'),
      fullPage: true
    })
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})
