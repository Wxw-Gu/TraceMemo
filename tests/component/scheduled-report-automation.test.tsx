import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '../../src/renderer/src/components/ui'
import {
  AutomationWorkspace,
  type AutomationOpenRuleRequest
} from '../../src/renderer/src/features/automation/AutomationWorkspace'
import {
  createDefaultDailyReportRule,
  createDefaultLeaveNotificationRule,
  createDefaultScheduledReportRule,
  normalizeScheduledReportConfig,
  type AutomationRule
} from '../../src/shared/automation'
import { SUMMARY_TYPE_OPTIONS } from '../../src/renderer/src/utils/group-report'

/**
 * 「自动化 → 规则 → 定时日报」。
 *
 * 迁移前这一组测试守的是**边界**（"任何写操作都不许落盘"）。
 * 迁移后 `scheduled_report` 已经是真实的自动化规则类型，边界随之反转：
 * 现在要守的是**写真的发生、且写在正确的通道上**：
 * - 保存 → `createAutomationRule` / `updateAutomationRule`，且 `ruleType === 'scheduled_report'`；
 * - 立即执行 → `runScheduledReportRule`（与 scheduler 同一条链路）；
 * - 启停 → `setAutomationRuleEnabled`；
 * - 删除 → `deleteAutomationRule`；
 * - 且**没有任何** `scheduled-report:*` 旧通道残留。
 */

const RULES_FIXTURE: AutomationRule[] = [
  createDefaultScheduledReportRule(Date.now(), {
    id: 'rule-1',
    name: 'TraceMemo 每日晚报',
    config: normalizeScheduledReportConfig({
      schedule: { time: '18:21' },
      report: {
        sourceConversationId: 'g1@chatroom',
        range: 'today',
        messageTypes: ['text', 'image'],
        templateId: 'v1',
        memberNameMode: 'groupNickname',
        timeoutSeconds: 300
      },
      target: { type: 'source_chat' }
    })
  }),
  createDefaultScheduledReportRule(Date.now(), {
    id: 'rule-2',
    name: '技术交流群日报',
    enabled: false,
    config: normalizeScheduledReportConfig({
      schedule: { time: '09:00' },
      report: {
        sourceConversationId: 'g2@chatroom',
        range: 'yesterday',
        templateId: 'v1',
        memberNameMode: 'groupNickname',
        timeoutSeconds: 300
      },
      target: { type: 'file_transfer' }
    })
  })
]

interface Spies {
  createRule: ReturnType<typeof vi.fn>
  updateRule: ReturnType<typeof vi.fn>
  deleteRule: ReturnType<typeof vi.fn>
  setEnabled: ReturnType<typeof vi.fn>
  runScheduled: ReturnType<typeof vi.fn>
  setNotification: ReturnType<typeof vi.fn>
}

function installApi(rules: AutomationRule[] = RULES_FIXTURE): Spies {
  const spies: Spies = {
    createRule: vi.fn().mockImplementation((draft: unknown) =>
      Promise.resolve({
        ...(draft as AutomationRule),
        id: 'rule-new',
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
    ),
    updateRule: vi.fn().mockImplementation((id: string, draft: unknown) =>
      Promise.resolve({ ...(draft as AutomationRule), id, createdAt: 0, updatedAt: 0 })
    ),
    deleteRule: vi.fn().mockResolvedValue(true),
    setEnabled: vi.fn().mockImplementation((id: string, enabled: boolean) => {
      const found = rules.find((rule) => rule.id === id)
      return Promise.resolve(found ? { ...found, enabled } : null)
    }),
    runScheduled: vi.fn().mockResolvedValue({
      success: true,
      data: { executed: true, executionId: 'exec-1', status: 'success', reportGenerated: true }
    }),
    setNotification: vi.fn().mockResolvedValue({ success: true, data: { enabled: true } })
  }

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
    listAutomationRules: vi.fn().mockResolvedValue([
      createDefaultDailyReportRule(Date.now()),
      createDefaultLeaveNotificationRule(Date.now()),
      ...rules
    ]),
    createAutomationRule: spies.createRule,
    updateAutomationRule: spies.updateRule,
    deleteAutomationRule: spies.deleteRule,
    setAutomationRuleEnabled: spies.setEnabled,
    listAutomationGroups: vi.fn().mockResolvedValue([
      { id: 'g1@chatroom', name: 'TraceMemo 交流群' },
      { id: 'g2@chatroom', name: '技术交流群' },
      { id: 'g3@chatroom', name: 'TraceMemo 管理群' }
    ]),
    listAutomationExecutions: vi.fn().mockResolvedValue([]),
    listSendableContacts: vi.fn().mockResolvedValue([]),
    getGroupExitMonitorState: vi.fn().mockResolvedValue({
      events: [],
      enabled: true,
      running: true,
      nativeMonitorActive: true,
      monitoredGroupCount: 2,
      monitorSelectionConfigured: true,
      monitoredRoomIds: [],
      lastReadAt: 0,
      unreadCount: 0
    }),
    onGroupExitMonitorState: vi.fn(() => () => undefined),
    runScheduledReportRule: spies.runScheduled,
    listScheduledReportLegacyExecutions: vi.fn().mockResolvedValue([]),
    getScheduledReportNotificationSettings: vi.fn().mockResolvedValue({ enabled: false }),
    getScheduledReportNotificationCapability: vi.fn().mockResolvedValue({
      ready: false,
      error: '需要先连接 Agent Hub 微信机器人，才能接收异常通知。'
    }),
    setScheduledReportNotificationEnabled: spies.setNotification,
    testScheduledReportErrorNotification: vi.fn().mockResolvedValue({ success: true })
  } as unknown as typeof window.api

  return spies
}

const renderWorkspace = (request?: AutomationOpenRuleRequest): void => {
  render(
    <ToastProvider>
      <AutomationWorkspace
        dbReady
        openRuleRequest={request ?? null}
        onOpenModelSettings={() => {}}
      />
    </ToastProvider>
  )
}

/** 打开「规则 → 定时日报」。 */
async function openScheduledTab(): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '新建自动化' }))
  await user.click(screen.getByRole('radio', { name: '定时日报' }))
}

describe('自动化 · 规则类型 Tab（定时日报）', () => {
  it('Tab 有三项，顺序是 消息 → 时间 → 系统事件', async () => {
    installApi()
    renderWorkspace()

    await screen.findByText('退群通知')
    await userEvent.setup().click(screen.getAllByRole('button', { name: '新建自动化' })[0])

    const tabs = Array.from(
      document.querySelectorAll('.automation-rule-type-tabs [role="radio"]')
    ).map((el) => el.textContent?.trim())
    expect(tabs).toEqual(['@我生成日报', '定时日报', '退群通知'])
  })

  it('切到定时日报先给规则列表，不直接进编辑器', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()

    expect(await screen.findByRole('heading', { name: '定时日报' })).toBeVisible()
    expect(screen.getByText('按设定时间自动生成日报，并发送到指定微信会话。')).toBeVisible()
    expect(screen.getByText('2 条规则')).toBeVisible()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('列表层有「返回规则列表」入口，不切 tab 也能退出', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()

    /*
     * 这里以前是个死胡同：定时日报先落列表，而列表只有新建/编辑/立即执行/删除，
     * 页面级「新建自动化」又因编辑态被隐藏，顶部 规则/执行日志 切换条同样被隐藏 ——
     * 唯一的出路竟然是切到别的规则类型 tab，再从那边的「取消」绕回来。
     */
    const back = await screen.findByRole('button', { name: /返回规则列表/ })
    await user.click(back)

    // 回到规则面板（三个类型卡片），本类型的 tab 条随之消失。
    expect(await screen.findByText('退群通知')).toBeVisible()
    expect(screen.queryByRole('radio', { name: '定时日报' })).toBeNull()
  })

  it('列表按真实规则字段渲染（触发 / 日报 / 来源 / 模板 / 发送到）', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()

    const card = (await screen.findByText('TraceMemo 每日晚报')).closest('article') as HTMLElement
    const meta = Array.from(card.querySelectorAll('dl > div')).map((row) => [
      row.querySelector('dt')?.textContent?.trim(),
      row.querySelector('dd')?.textContent?.trim()
    ])

    expect(meta).toEqual([
      ['触发', '每天 18:21'],
      ['日报', '今日'],
      ['来源', 'TraceMemo 交流群'],
      ['模板', '经典日报'],
      ['发送到', '发送到日报来源群（TraceMemo 交流群）'],
      ['下次执行', expect.any(String)]
    ])

    // 暂停的规则不再给出"下次执行"时间，避免误导。
    const paused = (await screen.findByText('技术交流群日报')).closest('article') as HTMLElement
    expect(paused.textContent).toContain('已暂停')
    expect(within(paused).getByText('—')).toBeVisible()
    expect(paused.textContent).toContain('文件传输助手')
  })
})

describe('定时日报 · 真写入', () => {
  it('保存新规则 → createAutomationRule，且 ruleType 与完整配置都对', async () => {
    const spies = installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))

    await user.type(screen.getByLabelText('定时日报任务名称'), '新的定时日报')
    await user.click(
      within(screen.getByRole('radiogroup', { name: '日报来源' })).getByRole('radio', {
        name: '技术交流群'
      })
    )
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(spies.createRule).toHaveBeenCalledTimes(1))
    const draft = spies.createRule.mock.calls[0][0] as {
      name: string
      ruleType: string
      scheduledReport: { report: { sourceConversationId: string }; target: { type: string } }
    }
    expect(draft.name).toBe('新的定时日报')
    expect(draft.ruleType).toBe('scheduled_report')
    // 来源群存的是**稳定会话 id**，不是群名。
    expect(draft.scheduledReport.report.sourceConversationId).toBe('g2@chatroom')
    // 新建默认发到文件传输助手（不会误打扰群聊）。
    expect(draft.scheduledReport.target.type).toBe('file_transfer')
    expect(spies.updateRule).not.toHaveBeenCalled()
  })

  it('编辑既有规则 → updateAutomationRule（不是新建）', async () => {
    const spies = installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    const card = (await screen.findByText('TraceMemo 每日晚报')).closest('article') as HTMLElement
    await user.click(within(card).getByRole('button', { name: '编辑' }))

    expect(screen.getByLabelText('定时日报任务名称')).toHaveValue('TraceMemo 每日晚报')
    expect(screen.getByLabelText('执行时间小时')).toHaveValue('18')
    expect(screen.getByLabelText('执行时间分钟')).toHaveValue('21')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(spies.updateRule).toHaveBeenCalledTimes(1))
    expect(spies.updateRule.mock.calls[0][0]).toBe('rule-1')
    expect(spies.createRule).not.toHaveBeenCalled()
  })

  it('缺名称 / 缺来源群时**不允许保存**，并说明原因', async () => {
    const spies = installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))

    expect(screen.getByTestId('scheduled-save-blocker')).toHaveTextContent('请填写任务名称')
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()

    await user.type(screen.getByLabelText('定时日报任务名称'), '有名字了')
    expect(screen.getByTestId('scheduled-save-blocker')).toHaveTextContent('请选择日报来源群')
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()

    expect(spies.createRule).not.toHaveBeenCalled()
  })

  it('「立即执行」走 runScheduledReportRule（与 scheduler 同一条链路）', async () => {
    const spies = installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    const card = (await screen.findByText('TraceMemo 每日晚报')).closest('article') as HTMLElement
    await user.click(within(card).getByRole('button', { name: '立即执行' }))

    await waitFor(() => expect(spies.runScheduled).toHaveBeenCalledWith('rule-1'))
  })

  it('toggle 真写 setAutomationRuleEnabled', async () => {
    const spies = installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    const card = (await screen.findByText('TraceMemo 每日晚报')).closest('article') as HTMLElement

    await user.click(within(card).getByRole('switch'))
    await waitFor(() => expect(spies.setEnabled).toHaveBeenCalledWith('rule-1', false))
  })

  it('删除要经过确认弹层，确认后才真删', async () => {
    const spies = installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    const card = (await screen.findByText('TraceMemo 每日晚报')).closest('article') as HTMLElement
    await user.click(within(card).getByRole('button', { name: '删除' }))

    const dialog = await screen.findByRole('alertdialog', { name: '删除自动化' })
    expect(dialog).toHaveTextContent('删除「TraceMemo 每日晚报」？')
    expect(spies.deleteRule).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(spies.deleteRule).toHaveBeenCalledWith('rule-1'))
  })

  it('不再有任何旧的 scheduled-report:* 通道被调用', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()

    const api = window.api as unknown as Record<string, unknown>
    for (const legacy of [
      'listScheduledReports',
      'createScheduledReport',
      'updateScheduledReport',
      'deleteScheduledReport',
      'setScheduledReportEnabled',
      'runScheduledReportNow',
      'retryScheduledReportSend'
    ]) {
      expect(api[legacy], `旧通道 ${legacy} 仍然存在于 preload 契约里`).toBeUndefined()
    }
  })
})

describe('定时日报 · 完整日报配置（不丢旧能力）', () => {
  it('新建时「纳入的消息类型」默认只勾选文本', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))

    // 逐个断言，而不是只看"有没有被勾"：默认值改了方向的话，全选也是"有被勾"。
    for (const option of SUMMARY_TYPE_OPTIONS) {
      const box = screen.getByRole('checkbox', { name: option.label })
      if (option.value === 'text') expect(box).toBeChecked()
      else expect(box).not.toBeChecked()
    }
  })

  it('Section 2 承载旧「定时日报」的全部日报配置', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))

    expect(screen.getByLabelText('定时日报任务名称')).toBeVisible()
    expect(screen.getByRole('radiogroup', { name: '日报来源' })).toBeVisible()
    expect(screen.getByLabelText('日报范围')).toBeVisible()
    expect(screen.getByLabelText('日报模板')).toBeVisible()
    expect(screen.getByLabelText('成员名称')).toBeVisible()
    expect(screen.getByLabelText('日报生成超时')).toBeVisible()
    expect(screen.getByText('模型配置')).toBeVisible()
    expect(screen.getByText('更改模型')).toBeVisible()
    expect(screen.getByText('日报内容')).toBeVisible()
    expect(screen.getByText('纳入的消息类型')).toBeVisible()
  })

  it('成员名称保留旧页面的三个选项', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))

    await user.click(screen.getByLabelText('成员名称'))
    expect(await screen.findByRole('option', { name: '群昵称' })).toBeVisible()
    expect(screen.getByRole('option', { name: '微信昵称' })).toBeVisible()
    expect(screen.getByRole('option', { name: '通讯录备注' })).toBeVisible()
  })
})

describe('定时日报 · 四选一发送目标', () => {
  it('只有四选一，且**没有**「指定群聊」这种"发到另一个群"的选项', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))

    const group = screen.getByRole('radiogroup', { name: '生成后发送到哪里' })
    const labels = Array.from(group.querySelectorAll('label')).map((el) => el.textContent?.trim())
    expect(labels).toEqual([
      '发送到日报来源群',
      '文件传输助手',
      '发给自己',
      '指定好友'
    ])
    expect(screen.queryByRole('radio', { name: '指定群聊' })).toBeNull()
    expect(screen.getByRole('radio', { name: '文件传输助手' })).toBeChecked()
  })

  it('只有「指定好友」才展开好友选择器', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))
    // 先把名称 / 来源群补齐：阻断提示是有优先级的（名称 → 来源群 → 指定好友），
    // 否则这里看到的是「请填写任务名称」，断言就打偏了。
    await user.type(screen.getByLabelText('定时日报任务名称'), '发给指定好友的日报')
    await user.click(
      within(screen.getByRole('radiogroup', { name: '日报来源' })).getByRole('radio', {
        name: '技术交流群'
      })
    )

    for (const label of ['文件传输助手', '发送到日报来源群', '发给自己']) {
      await user.click(screen.getByRole('radio', { name: label }))
      expect(screen.queryByPlaceholderText('搜索好友')).toBeNull()
    }

    await user.click(screen.getByRole('radio', { name: '指定好友' }))
    expect(screen.getByPlaceholderText('搜索好友')).toBeVisible()
    // 选了「指定好友」却没选人 → 不允许保存（否则运行期必然失败）。
    expect(screen.getByTestId('scheduled-save-blocker')).toHaveTextContent(
      '请选择要发送的指定好友'
    )
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })
})

describe('定时日报 · 迁移遗留与内部标识', () => {
  it('targetNeedsReview 的规则在列表上明确提示"需要重选目标"', async () => {
    const needsReview = createDefaultScheduledReportRule(Date.now(), {
      id: 'rule-review',
      name: '旧规则',
      enabled: false,
      config: {
        ...normalizeScheduledReportConfig({}),
        target: { type: 'source_chat' },
        targetNeedsReview: true,
        legacyTarget: '某个旧群'
      }
    })
    installApi([needsReview])
    renderWorkspace()
    await openScheduledTab()

    const card = (await screen.findByText('旧规则')).closest('article') as HTMLElement
    expect(card.textContent).toContain('发送目标需要重新选择')
    expect(card.textContent).toContain('某个旧群')
    // 目标待重选时不允许执行（执行必然失败）。
    expect(within(card).getByRole('button', { name: '立即执行' })).toBeDisabled()
  })

  it('列表把 room id / hash 解析成显示名，绝不显示裸 id', async () => {
    const FAKE_ROOM_ID = '12345678@chatroom'
    const FAKE_GROUP_HASH = '0123456789abcdef0123456789abcdef'
    installApi([
      createDefaultScheduledReportRule(Date.now(), {
        id: 'rule-internal',
        name: '内部标识规则',
        config: normalizeScheduledReportConfig({
          report: { sourceConversationId: FAKE_ROOM_ID, messageTypes: ['text'] }
        })
      }),
      createDefaultScheduledReportRule(Date.now(), {
        id: 'rule-internal-2',
        name: '内部标识规则 2',
        config: normalizeScheduledReportConfig({
          report: { sourceConversationId: FAKE_GROUP_HASH, messageTypes: ['text'] }
        })
      })
    ])
    renderWorkspace()
    await openScheduledTab()

    await screen.findByText('内部标识规则')
    const body = document.body.textContent ?? ''
    expect(body).not.toContain(FAKE_ROOM_ID)
    expect(body).not.toContain(FAKE_GROUP_HASH.slice(0, 12))
    expect(screen.getAllByText('未知群聊').length).toBeGreaterThan(0)
  })
})

describe('定时日报 · 微信异常通知入口', () => {
  it('编辑器里保留异常通知开关，并给出 Agent Hub 的去处', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))

    expect(screen.getByRole('heading', { name: '微信异常通知' })).toBeVisible()
    expect(
      screen.getByText('需要先连接 Agent Hub 微信机器人，才能接收异常通知。')
    ).toBeVisible()
  })
})

describe('定时日报 · 首页汇总卡', () => {
  it('首页把它当"多条规则"汇总，而不是一条 singleton', async () => {
    installApi()
    renderWorkspace()

    const card = (await screen.findByText('定时日报')).closest('article') as HTMLElement
    expect(card.textContent).toContain('2 条规则 · 1 条运行中')
    expect(card.textContent).toContain('按设定时间')
    expect(within(card).queryByRole('switch')).toBeNull()

    await userEvent.setup().click(within(card).getByRole('button', { name: '管理定时日报 →' }))
    expect(await screen.findByText('2 条规则')).toBeVisible()
  })
})

describe('定时日报 · 深链', () => {
  it('深链直接落到「自动化 → 规则 → 定时日报」', async () => {
    installApi()

    function Harness(): React.ReactElement {
      const [request] = React.useState<AutomationOpenRuleRequest>({
        ruleType: 'scheduled_report',
        requestId: 1
      })
      return <AutomationWorkspace dbReady openRuleRequest={request} />
    }

    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>
    )

    expect(await screen.findByText('2 条规则')).toBeVisible()
    expect(screen.getByRole('radio', { name: '定时日报' })).toBeChecked()
  })
})

describe('定时日报 · 空态', () => {
  it('没有规则时给空态与新建入口', async () => {
    installApi([])
    renderWorkspace()
    await openScheduledTab()

    expect(await screen.findByText('还没有定时日报')).toBeVisible()
    expect(screen.getAllByRole('button', { name: '+ 新建定时日报' }).length).toBeGreaterThan(0)
  })
})
