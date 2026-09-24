import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '../../src/renderer/src/components/ui'
import {
  AutomationWorkspace,
  type AutomationOpenRuleRequest
} from '../../src/renderer/src/features/automation/AutomationWorkspace'
import {
  BUILTIN_DAILY_REPORT_RULE_ID,
  createDefaultDailyReportRule,
  createDefaultLeaveNotificationRule,
  type AutomationRule
} from '../../src/shared/automation'

/**
 * 规则类型切换的**目标归属**回归。
 *
 * 真实事故：从「退群通知」卡片进编辑器（编辑器内部记的是"没有具体目标"），
 * 切到「@我生成日报」Tab 后保存 —— 结果改掉了**内置日报**（用户看到的就是
 * "我编辑退群通知，保存却改到了另一条日报上"）。
 *
 * 根因两条，都要锁死：
 * 1. 切换类型时继承了上一个类型的 `mode`，留下 `mode='edit'` 却没有目标的中间态；
 * 2. 编辑目标**不可见** —— 表单不显示它在改哪条规则。
 */

const DAILY_NAME = '我的日报'

function installApi(): {
  rules: AutomationRule[]
  updateAutomationRule: ReturnType<typeof vi.fn>
  createAutomationRule: ReturnType<typeof vi.fn>
  saveLeaveNotificationRule: ReturnType<typeof vi.fn>
} {
  const renamedDaily: AutomationRule = {
    ...createDefaultDailyReportRule(Date.now()),
    name: DAILY_NAME
  }
  const leaveRule = createDefaultLeaveNotificationRule(Date.now())
  const rules = [renamedDaily, leaveRule]

  const updateAutomationRule = vi.fn(async (id: string, draft: AutomationRule) => ({
    ...renamedDaily,
    ...draft,
    id
  }))
  const createAutomationRule = vi.fn(async (draft: AutomationRule) => ({
    ...renamedDaily,
    ...draft,
    id: 'created-rule'
  }))
  const saveLeaveNotificationRule = vi.fn(async (draft: AutomationRule) => draft)

  window.api = {
    getAutomationStatus: vi.fn().mockResolvedValue({
      listening: true,
      listeningDegraded: false,
      todayExecutions: 0,
      todaySuccesses: 0,
      sendCapability: {
        supported: true,
        ready: true,
        canSendText: true,
        canSendImage: true,
        message: 'ready'
      }
    }),
    listAutomationRules: vi.fn().mockResolvedValue(rules),
    listAutomationGroups: vi.fn().mockResolvedValue([]),
    listAutomationExecutions: vi.fn().mockResolvedValue([]),
    listSendableContacts: vi.fn().mockResolvedValue([]),
    getGroupExitMonitorState: vi.fn().mockResolvedValue({
      events: [],
      enabled: true,
      running: true,
      nativeMonitorActive: true,
      monitoredGroupCount: 3,
      monitorSelectionConfigured: true,
      monitoredRoomIds: [],
      lastReadAt: 0,
      unreadCount: 0
    }),
    onGroupExitMonitorState: vi.fn(() => () => undefined),
    updateAutomationRule,
    createAutomationRule,
    saveLeaveNotificationRule
  } as unknown as typeof window.api

  return { rules, updateAutomationRule, createAutomationRule, saveLeaveNotificationRule }
}

const renderWorkspace = (): void => {
  render(
    <ToastProvider>
      <AutomationWorkspace dbReady onOpenExitMonitorGroups={() => {}} />
    </ToastProvider>
  )
}

const editingTarget = (): string =>
  screen.getByTestId('automation-editing-target').textContent ?? ''

const leaveCard = async (): Promise<HTMLElement> =>
  (await screen.findByText('退群通知')).closest('article') as HTMLElement

describe('规则类型切换 · 编辑目标归属', () => {
  it('从退群通知进编辑器时，「正在编辑」显示退群通知', async () => {
    const user = userEvent.setup()
    installApi()
    renderWorkspace()

    await user.click(within(await leaveCard()).getByRole('button', { name: '编辑' }))

    expect(editingTarget()).toContain('退群通知')
  })

  /*
   * 事故核心：切到日报后，界面必须**明说**现在改的是哪条。
   * 以前这里什么都不显示，用户以为还在改退群通知。
   */
  it('切到日报后，「正在编辑」显示那条日报的名字（不再隐式指向未知目标）', async () => {
    const user = userEvent.setup()
    installApi()
    renderWorkspace()

    await user.click(within(await leaveCard()).getByRole('button', { name: '编辑' }))
    await user.click(screen.getByRole('radio', { name: '@我生成日报' }))

    expect(editingTarget()).toContain(DAILY_NAME)
    expect(editingTarget()).not.toContain('退群通知')
  })

  it('切到日报后保存：只更新那一条日报，退群通知与新建都不受影响', async () => {
    const user = userEvent.setup()
    const api = installApi()
    renderWorkspace()

    await user.click(within(await leaveCard()).getByRole('button', { name: '编辑' }))
    await user.click(screen.getByRole('radio', { name: '@我生成日报' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(api.updateAutomationRule).toHaveBeenCalledTimes(1))
    // 必须更新"屏幕上显示的那条"。
    expect(api.updateAutomationRule.mock.calls[0][0]).toBe(BUILTIN_DAILY_REPORT_RULE_ID)
    // 绝不能顺手新建一条重复规则，也不能动退群通知。
    expect(api.createAutomationRule).not.toHaveBeenCalled()
    expect(api.saveLeaveNotificationRule).not.toHaveBeenCalled()
  })

  it('从日报卡片进入并保存：更新日报，且不会误存到退群通知', async () => {
    const user = userEvent.setup()
    const api = installApi()
    renderWorkspace()

    const dailyCard = (await screen.findByText(DAILY_NAME)).closest('article') as HTMLElement
    await user.click(within(dailyCard).getByRole('button', { name: '编辑' }))
    expect(editingTarget()).toContain(DAILY_NAME)

    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(api.updateAutomationRule).toHaveBeenCalledTimes(1))
    expect(api.saveLeaveNotificationRule).not.toHaveBeenCalled()
  })

  it('从日报切到退群通知后保存：走退群通知通道，不改日报', async () => {
    const user = userEvent.setup()
    const api = installApi()
    renderWorkspace()

    const dailyCard = (await screen.findByText(DAILY_NAME)).closest('article') as HTMLElement
    await user.click(within(dailyCard).getByRole('button', { name: '编辑' }))
    await user.click(screen.getByRole('radio', { name: '退群通知' }))

    expect(editingTarget()).toContain('退群通知')

    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(api.saveLeaveNotificationRule).toHaveBeenCalledTimes(1))
    expect(api.updateAutomationRule).not.toHaveBeenCalled()
  })

  it('内置日报不存在时切到日报：显示「新建自动化」，保存走新建而不是更新', async () => {
    const user = userEvent.setup()
    const api = installApi()
    // 只剩退群通知（等价于用户把内置日报删掉了）。
    ;(window.api.listAutomationRules as ReturnType<typeof vi.fn>).mockResolvedValue([
      createDefaultLeaveNotificationRule(Date.now())
    ])
    renderWorkspace()

    await user.click(within(await leaveCard()).getByRole('button', { name: '编辑' }))
    await user.click(screen.getByRole('radio', { name: '@我生成日报' }))

    expect(editingTarget()).toContain('新建自动化')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.createAutomationRule).toHaveBeenCalledTimes(1))
    expect(api.updateAutomationRule).not.toHaveBeenCalled()
    expect(api.saveLeaveNotificationRule).not.toHaveBeenCalled()
  })

  /*
   * 日报可以有多条。切走再切回时必须回到**刚才那条**，
   * 否则用户会在不知情的情况下被带到内置日报上（等于换个方式误改规则）。
   */
  it('从别的日报进入，切走再切回仍指向那条日报，不会被换回内置日报', async () => {
    const user = userEvent.setup()
    const api = installApi()
    const OTHER_NAME = '我的另一条日报'
    ;(window.api.listAutomationRules as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...createDefaultDailyReportRule(Date.now()), name: DAILY_NAME },
      {
        ...createDefaultDailyReportRule(Date.now()),
        id: 'custom-daily',
        name: OTHER_NAME
      },
      createDefaultLeaveNotificationRule(Date.now())
    ])
    renderWorkspace()

    const otherCard = (await screen.findByText(OTHER_NAME)).closest('article') as HTMLElement
    await user.click(within(otherCard).getByRole('button', { name: '编辑' }))
    expect(editingTarget()).toContain(OTHER_NAME)

    await user.click(screen.getByRole('radio', { name: '退群通知' }))
    await user.click(screen.getByRole('radio', { name: '@我生成日报' }))

    expect(editingTarget()).toContain(OTHER_NAME)
    expect(editingTarget()).not.toContain(DAILY_NAME)

    // 保存也必须落在这一条上。
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.updateAutomationRule).toHaveBeenCalledTimes(1))
    expect(api.updateAutomationRule.mock.calls[0][0]).toBe('custom-daily')
  })

  /*
   * 同类 bug 的第二处：`mode === 'edit' || !target ? createRule : updateRule` ——
   * "编辑态但没有目标"被静默当成"新建"，用户以为在改 A，结果多出一条新规则。
   * 现在必须明确报错，且不能给 User 一个看起来能保存的空表单。
   */
  it('编辑态但目标规则已不存在：不给新建入口，明确提示', async () => {
    const api = installApi()
    // 内置日报不存在（等价于用户把它删掉了）。
    ;(window.api.listAutomationRules as ReturnType<typeof vi.fn>).mockResolvedValue([
      createDefaultLeaveNotificationRule(Date.now())
    ])

    function DeepLinkHarness(): React.ReactElement {
      const [request] = React.useState<AutomationOpenRuleRequest>({
        ruleType: 'daily_report',
        requestId: 1
      })
      return <AutomationWorkspace dbReady openRuleRequest={request} />
    }

    render(
      <ToastProvider>
        <DeepLinkHarness />
      </ToastProvider>
    )

    expect(await screen.findByText(/要编辑的规则已不存在/)).toBeVisible()
    // 关键：没有可点的「保存」——否则用户点下去就会凭空新建一条规则。
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    expect(api.createAutomationRule).not.toHaveBeenCalled()
    expect(api.updateAutomationRule).not.toHaveBeenCalled()
  })

  it('切类型不会静默新建出重复规则', async () => {
    const user = userEvent.setup()
    const api = installApi()
    renderWorkspace()

    await user.click(within(await leaveCard()).getByRole('button', { name: '编辑' }))
    for (const label of ['@我生成日报', '退群通知', '@我生成日报', '退群通知']) {
      await user.click(screen.getByRole('radio', { name: label }))
    }

    expect(api.createAutomationRule).not.toHaveBeenCalled()
    expect(api.updateAutomationRule).not.toHaveBeenCalled()
    expect(api.saveLeaveNotificationRule).not.toHaveBeenCalled()
  })

  it('Tab 文案说明它是「切换规则类型」，不是改当前规则的类型', async () => {
    const user = userEvent.setup()
    installApi()
    renderWorkspace()

    await user.click(within(await leaveCard()).getByRole('button', { name: '编辑' }))

    expect(screen.getByText('切换规则类型')).toBeVisible()
    expect(
      screen.getByRole('radiogroup', { name: '切换规则类型' }) as HTMLElement
    ).toBeInTheDocument()
  })
})
