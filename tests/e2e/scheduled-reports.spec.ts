import { expect, test, type Page } from '@playwright/test'
import { launchTestApp } from './support/electron'

/**
 * 定时日报的 E2E。
 *
 * 「定时日报」已从「日报 → 定时日报」独立页迁到「自动化 → 规则 → 定时日报」，
 * 本文件走的是**迁移后**的真实路径：
 *
 *   日报（提示条）→「去自动化配置 →」→ 自动化 · 定时日报（规则列表）→ 新建 → 编辑器
 *
 * 断言一律打在真实模型渲染出的**默认值与真实选项**上（范围 / 模板 / 成员名称 /
 * 消息类型 / 发送目标），而不是「页面上有个按钮」这种空转检查。
 */

/** fixture 约定的固定时刻：2026-08-27 08:30 (+08:00)。 */
const FIXTURE_NOW = Date.parse('2026-08-27T08:30:00+08:00')

/** 从时间线进入「自动化 → 定时日报」的规则列表。 */
async function openScheduledReportRuleList(page: Page): Promise<void> {
  await page.getByRole('button', { name: '日报' }).click()
  await page.getByRole('button', { name: '去自动化配置 →' }).click()
  await expect(page.getByRole('radiogroup', { name: '切换规则类型' })).toBeVisible()
}

/** 列表 → 新建 → 编辑器。 */
async function openScheduledReportEditor(page: Page): Promise<void> {
  await openScheduledReportRuleList(page)
  await page.getByRole('button', { name: '+ 新建定时日报' }).first().click()
  await expect(page.getByRole('heading', { name: '新建定时日报' })).toBeVisible()
}

test('SCHEDULED-REPORT-UI-01 creates a scheduled report rule from the automation workspace without viewport overflow', async () => {
  test.skip(
    process.platform !== 'darwin' && process.platform !== 'win32',
    'The scheduled report send capability requires macOS or Windows'
  )
  const fixture = await launchTestApp({ now: FIXTURE_NOW })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  const page = fixture.page
  try {
    await openScheduledReportRuleList(page)

    // 深链把「定时日报」这个类型选中，并且先给列表而不是直接甩一个空表单。
    await expect(page.getByRole('radio', { name: '定时日报' })).toBeChecked()
    await expect(page.getByText('还没有定时日报')).toBeVisible()

    await page.getByRole('button', { name: '+ 新建定时日报' }).first().click()
    await expect(page.getByRole('heading', { name: '新建定时日报' })).toBeVisible()

    // 编辑器是内嵌面板（不是弹窗），三段结构齐全。
    for (const heading of ['1 · 什么时候触发', '2 · 生成什么日报', '3 · 生成后发送到哪里']) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    }

    // 触发段：默认 18:30，且「预计下次执行」按本地时区算出当日槽位。
    await expect(page.getByRole('textbox', { name: '执行时间小时' })).toHaveValue('18')
    await expect(page.getByRole('textbox', { name: '执行时间分钟' })).toHaveValue('30')
    await expect(page.getByTestId('scheduled-next-run')).toHaveText('今日 18:30')

    // 还没填必填项就必须**说不出原因地**拦住保存。
    const saveButton = page.getByRole('button', { name: '保存', exact: true })
    await expect(saveButton).toBeDisabled()
    await expect(page.getByTestId('scheduled-save-blocker')).toHaveText('请填写任务名称')

    /*
     * 「自定义」区间在旧页面是 aria-disabled 的占位，新编辑器直接把范围收成一个下拉 ——
     * 所以这里不再断言那个占位，改成断言下拉本身接的是真实取值。
     */
    await expect(page.getByRole('combobox', { name: '日报范围' })).toHaveText('今日')

    // 来源群候选来自真实群列表，且搜索框真的过滤。
    await expect(page.getByRole('radio', { name: '产品测试群' })).toBeVisible()
    await expect(page.getByRole('radio', { name: '折叠群聊样本' })).toBeVisible()
    await page.getByRole('textbox', { name: '搜索群聊' }).fill('折叠')
    await expect(page.getByRole('radio', { name: '产品测试群' })).toHaveCount(0)
    await expect(page.getByRole('radio', { name: '折叠群聊样本' })).toBeVisible()
    await page.getByRole('textbox', { name: '搜索群聊' }).fill('')
    await expect(page.getByRole('radio', { name: '产品测试群' })).toBeVisible()

    // 模板下拉：默认经典日报，能切到社区模板。
    const templateSelect = page.getByRole('combobox', { name: '日报模板' })
    await expect(templateSelect).toHaveText('经典日报')
    await templateSelect.click()
    await page.getByRole('option', { name: 'Mobile 01 · 微信信息流' }).click()
    await expect(templateSelect).toHaveText('Mobile 01 · 微信信息流')

    // 成员名称下拉：默认群昵称，能切到微信昵称。
    const memberSelect = page.getByRole('combobox', { name: '成员名称' })
    await expect(memberSelect).toHaveText('群昵称')
    await memberSelect.click()
    await page.getByRole('option', { name: '微信昵称' }).click()
    await expect(memberSelect).toHaveText('微信昵称')

    await expect(page.getByRole('textbox', { name: '日报生成超时' })).toHaveValue('300')

    // 发送目标四选一，默认「文件传输助手」。
    await expect(page.getByRole('radio', { name: '文件传输助手' })).toBeChecked()

    // 整页不允许出现横向滚动条（布局回归的硬门槛）。
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)

    /*
     * 阻断原因是**逐级**暴露的：填了名称就轮到来源群，选了群才放行。
     * 这里按顺序走一遍，确认拦的是真实缺失项而不是一个笼统的"保存失败"。
     */
    await page.getByRole('textbox', { name: '定时日报任务名称' }).fill('E2E 定时日报')
    await expect(page.getByTestId('scheduled-save-blocker')).toHaveText('请选择日报来源群')
    await expect(saveButton).toBeDisabled()

    await page.getByRole('radio', { name: '产品测试群' }).click()
    await expect(page.getByTestId('scheduled-save-blocker')).toHaveCount(0)
    await expect(saveButton).toBeEnabled()
    await saveButton.click()

    // toast 必须 `exact`：Radix 的无障碍播报节点文案是 `Notification 已创建「…」`，子串会命中 2 个。
    await expect(page.getByText('已创建「E2E 定时日报」', { exact: true })).toBeVisible()

    // 回到列表，卡片渲染的是**保存回来的规则**，不是草稿。
    await expect(page.getByRole('heading', { name: 'E2E 定时日报' })).toBeVisible()
    await expect(page.getByText('每天 18:30')).toBeVisible()
    await expect(page.getByRole('button', { name: '+ 新建定时日报' }).first()).toBeVisible()

    // 发送能力状态仍是设置页里的同一份事实。
    await page.getByRole('button', { name: '设置' }).click()
    await page.getByRole('button', { name: '微信发送', exact: true }).click()
    await expect(page.getByRole('heading', { name: '微信发送' })).toBeVisible()
    /*
     * 这一页的区块标题按平台分叉：macOS 用「配置状态」（SetupGuide 统一展示），
     * Windows 才额外有「发送能力」卡。旧断言写死了「发送能力」，在 macOS 上恒假。
     *
     * `exact: true` 不能省：Windows 上同一页还有「发送能力授权」，
     * 子串匹配会同时命中 —— 这正是 CI 上 strict mode violation 的来源。
     */
    await expect(
      page.getByRole('heading', {
        name: process.platform === 'darwin' ? '配置状态' : '发送能力',
        exact: true
      })
    ).toBeVisible()

    expect(pageErrors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('SCHEDULED-REPORT-UI-02 keeps the notification switch off and explains why when Agent Hub is offline', async () => {
  test.skip(
    process.platform !== 'darwin' && process.platform !== 'win32',
    'The scheduled report send capability requires macOS or Windows'
  )
  const fixture = await launchTestApp({ now: FIXTURE_NOW })
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  const page = fixture.page
  try {
    await openScheduledReportEditor(page)

    // 异常通知挂在编辑器侧栏，是「定时日报」的全局能力，不是单条规则的配置。
    await expect(page.getByRole('heading', { name: '微信异常通知' })).toBeVisible()
    await expect(
      page.getByText('需要先连接 Agent Hub 微信机器人，才能接收异常通知。')
    ).toBeVisible()

    /*
     * Agent Hub 离线 ⇒ 开关**禁用**（不是"能点但点了没反应"）。
     * 迁移前这里是个点了会弹报错的开关；新实现把不可用前置成禁用 + 原因 + 去处，
     * 所以断言的是禁用状态与原因文案，而不是点击后的错误提示。
     */
    const notificationSwitch = page.getByRole('switch', { name: '开启微信异常通知' })
    await expect(notificationSwitch).toHaveAttribute('aria-checked', 'false')
    await expect(notificationSwitch).toBeDisabled()

    // 能力未就绪时不给「发送测试」—— 不给一个点了必然失败的按钮。
    await expect(page.getByRole('button', { name: '发送测试' })).toHaveCount(0)

    await page.getByRole('button', { name: '去连接 Agent Hub' }).click()
    await expect(page.getByRole('heading', { name: 'Agent Hub', exact: true })).toBeVisible()

    expect(pageErrors).toEqual([])
  } finally {
    await fixture.close()
  }
})
