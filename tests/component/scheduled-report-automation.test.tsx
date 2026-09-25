import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '../../src/renderer/src/components/ui'
import {
  AutomationWorkspace,
  type AutomationOpenRuleRequest
} from '../../src/renderer/src/features/automation/AutomationWorkspace'
import { ScheduledReportsWorkspace } from '../../src/renderer/src/components/reports/ScheduledReportsWorkspace'
import {
  createDefaultDailyReportRule,
  createDefaultLeaveNotificationRule
} from '../../src/shared/automation'
import type { ScheduledReportTask } from '../../src/shared/scheduled-report'

/**
 * 「自动化 → 规则 → 定时日报」。
 *
 * 这一组测试要守住的核心不是"界面长什么样"，而是**边界**：
 * 任何写操作都不许落到真实定时日报系统上
 * （create / update / delete / setEnabled / runNow / retry / 异常通知开关）。
 */

const TASKS: ScheduledReportTask[] = [
  {
    id: 'task-1',
    name: 'TraceMemo 每日晚报',
    group: 'TraceMemo 交流群',
    scheduleTime: '18:21',
    reportRange: 'today',
    target: 'TraceMemo 管理群',
    enabled: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    nextRunAt: '2026-09-24T10:21:00.000Z'
  },
  {
    id: 'task-2',
    name: '技术交流群日报',
    group: '技术交流群',
    scheduleTime: '09:00',
    reportRange: 'yesterday',
    target: '技术交流群',
    enabled: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    nextRunAt: '2026-09-25T01:00:00.000Z'
  }
]

interface Spies {
  createScheduledReport: ReturnType<typeof vi.fn>
  updateScheduledReport: ReturnType<typeof vi.fn>
  deleteScheduledReport: ReturnType<typeof vi.fn>
  setScheduledReportEnabled: ReturnType<typeof vi.fn>
  runScheduledReportNow: ReturnType<typeof vi.fn>
  retryScheduledReportSend: ReturnType<typeof vi.fn>
  testScheduledReportErrorNotification: ReturnType<typeof vi.fn>
  listScheduledReports: ReturnType<typeof vi.fn>
}

/** 所有"写操作"的集合：任何一条被调用都说明界面越界了。 */
function writeSpies(spies: Spies): Array<[string, ReturnType<typeof vi.fn>]> {
  return [
    ['createScheduledReport', spies.createScheduledReport],
    ['updateScheduledReport', spies.updateScheduledReport],
    ['deleteScheduledReport', spies.deleteScheduledReport],
    ['setScheduledReportEnabled', spies.setScheduledReportEnabled],
    ['runScheduledReportNow', spies.runScheduledReportNow],
    ['retryScheduledReportSend', spies.retryScheduledReportSend],
    ['testScheduledReportErrorNotification', spies.testScheduledReportErrorNotification]
  ]
}

function installApi(tasks: ScheduledReportTask[] = TASKS): Spies {
  const spies: Spies = {
    listScheduledReports: vi.fn().mockResolvedValue(tasks),
    createScheduledReport: vi.fn(),
    updateScheduledReport: vi.fn(),
    deleteScheduledReport: vi.fn(),
    setScheduledReportEnabled: vi.fn(),
    runScheduledReportNow: vi.fn(),
    retryScheduledReportSend: vi.fn(),
    testScheduledReportErrorNotification: vi.fn()
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
      createDefaultLeaveNotificationRule(Date.now())
    ]),
    listAutomationGroups: vi.fn().mockResolvedValue([
      { id: 'g1', name: 'TraceMemo 交流群' },
      { id: 'g2', name: '技术交流群' },
      { id: 'g3', name: 'TraceMemo 管理群' }
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
    // 旧「日报 → 定时日报」页面 mount 时会读这几项；只读、与预览无关。
    listScheduledReportExecutions: vi.fn().mockResolvedValue([]),
    getPersonalWechatSendCapability: vi.fn().mockResolvedValue(null),
    getScheduledReportNotificationSettings: vi.fn().mockResolvedValue({ enabled: false }),
    ...spies
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
    // 列表态不该出现编辑器的保存按钮。
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('列表按真实字段渲染（触发 / 日报 / 来源 / 发送到 / 下次执行）', async () => {
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
      // target 与来源群不同 ⇒ 显示 target 的群名；相同时会显示「日报来源群」。
      ['发送到', 'TraceMemo 管理群'],
      ['下次执行', expect.any(String)]
    ])
    // 暂停的任务下一次执行显示破折号，而不是一个会误导的时间。
    const paused = (await screen.findByText('技术交流群日报')).closest('article') as HTMLElement
    expect(paused.textContent).toContain('已暂停')
    expect(within(paused).getByText('—')).toBeVisible()
    // 这条的 target 与来源群相同 ⇒ 用「日报来源群」这种语义文案，而不是重复群名。
    expect(paused.textContent).toContain('日报来源群')
  })
})

describe('定时日报 · 编辑器与预览联动', () => {
  it('点「+ 新建定时日报」进入编辑器（三段 + 预览）', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))

    expect(screen.getByRole('heading', { name: '1 · 什么时候触发' })).toBeVisible()
    expect(screen.getByRole('heading', { name: '2 · 生成什么日报' })).toBeVisible()
    expect(screen.getByRole('heading', { name: '3 · 生成后发送到哪里' })).toBeVisible()
    expect(screen.getByRole('heading', { name: '效果预览' })).toBeVisible()
    // 只有一个开关：规则级启停。
    expect(screen.getAllByRole('switch')).toHaveLength(1)
  })

  it('点卡片「编辑」进入编辑器，并带出该任务的值', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()

    const user = userEvent.setup()
    const card = (await screen.findByText('TraceMemo 每日晚报')).closest('article') as HTMLElement
    await user.click(within(card).getByRole('button', { name: '编辑' }))

    expect(screen.getByLabelText('定时日报任务名称')).toHaveValue('TraceMemo 每日晚报')
    expect(screen.getByLabelText('执行时间小时')).toHaveValue('18')
    expect(screen.getByLabelText('执行时间分钟')).toHaveValue('21')
    expect(
      within(screen.getByRole('radiogroup', { name: '日报来源' })).getByRole('radio', {
        name: 'TraceMemo 交流群'
      })
    ).toBeChecked()
  })

  /*
   * 任务里存的群名与群列表是两个数据源，不保证一致
   * （群被移出监控、或列表来源变了）。这时**必须回显当前值**，
   * 否则编辑已有任务会出现"一串群里没有任何一项被选中"。
   */
  it('来源群不在群列表里时，仍会作为候选项被选中', async () => {
    installApi([{ ...TASKS[0], group: '已不在列表的群', target: '已不在列表的群' }])
    renderWorkspace()
    await openScheduledTab()

    const user = userEvent.setup()
    const card = (await screen.findByText('TraceMemo 每日晚报')).closest('article') as HTMLElement
    await user.click(within(card).getByRole('button', { name: '编辑' }))

    expect(
      within(screen.getByRole('radiogroup', { name: '日报来源' })).getByRole('radio', {
        name: '已不在列表的群'
      })
    ).toBeChecked()
  })

  it('改执行时间 → 预览与「预计下次执行」同时更新', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))

    const hourInput = screen.getByLabelText('执行时间小时')
    await user.clear(hourInput)
    await user.type(hourInput, '07')
    const minuteInput = screen.getByLabelText('执行时间分钟')
    await user.clear(minuteInput)
    await user.type(minuteInput, '05')

    expect(screen.getByTestId('scheduled-next-run').textContent).toMatch(/0?7:05/)
    const facts = document.querySelector('.automation-preview-facts')?.textContent ?? ''
    expect(facts).toContain('每天 07:05')
  })

  it('改日报来源 → 预览的生成目标跟着变', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))

    await user.click(
      within(screen.getByRole('radiogroup', { name: '日报来源' })).getByRole('radio', {
        name: '技术交流群'
      })
    )

    const flow = document.querySelector('.automation-preview-flow')?.textContent ?? ''
    expect(flow).toContain('技术交流群')
    const facts = document.querySelector('.automation-preview-facts')?.textContent ?? ''
    expect(facts).toContain('技术交流群')
  })

  it('发送目标是四选一，且**没有**「指定群聊」这种"发到另一个群"的选项', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))

    const group = screen.getByRole('radiogroup', { name: '生成后发送到哪里' })
    const labels = Array.from(group.querySelectorAll('label')).map((el) => el.textContent?.trim())
    expect(labels).toEqual(['文件传输助手', '发送到日报来源群', '发给自己', '指定好友'])
    expect(screen.queryByRole('radio', { name: '指定群聊' })).toBeNull()

    // 新建默认 = 文件传输助手（不会误打扰群聊）。
    expect(screen.getByRole('radio', { name: '文件传输助手' })).toBeChecked()
  })

  it('保存只提示，不调用任何真实写接口', async () => {
    const spies = installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('UI 预览模式，配置暂未保存')).toBeVisible()
    for (const [name, spy] of writeSpies(spies)) {
      expect(spy, `${name} 不该被调用`).not.toHaveBeenCalled()
    }
  })

  it('「立即执行」不触发真实执行', async () => {
    const spies = installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    const card = (await screen.findByText('TraceMemo 每日晚报')).closest('article') as HTMLElement
    await user.click(within(card).getByRole('button', { name: '立即执行' }))

    expect(await screen.findByText('UI 预览模式，不会执行真实日报任务')).toBeVisible()
    for (const [name, spy] of writeSpies(spies)) {
      expect(spy, `${name} 不该被调用`).not.toHaveBeenCalled()
    }
  })

  it('toggle 只改本地状态并提示，不写回 store', async () => {
    const spies = installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    const card = (await screen.findByText('TraceMemo 每日晚报')).closest('article') as HTMLElement

    await user.click(within(card).getByRole('switch'))

    expect(await screen.findByText('UI 预览模式，配置暂未保存')).toBeVisible()
    expect(within(card).getByText('已暂停')).toBeVisible()
    expect(spies.setScheduledReportEnabled).not.toHaveBeenCalled()
    for (const [name, spy] of writeSpies(spies)) {
      expect(spy, `${name} 不该被调用`).not.toHaveBeenCalled()
    }
  })

  it('删除只是提示，不移除任务', async () => {
    const spies = installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    const card = (await screen.findByText('TraceMemo 每日晚报')).closest('article') as HTMLElement
    await user.click(within(card).getByRole('button', { name: '删除' }))

    expect(await screen.findByText('UI 预览模式，不会删除现有任务')).toBeVisible()
    expect(screen.getByText('TraceMemo 每日晚报')).toBeVisible()
    for (const [name, spy] of writeSpies(spies)) {
      expect(spy, `${name} 不该被调用`).not.toHaveBeenCalled()
    }
  })

  it('任务列表为空时给空态与新建入口', async () => {
    installApi([])
    renderWorkspace()
    await openScheduledTab()

    expect(await screen.findByText('还没有定时日报')).toBeVisible()
    expect(screen.getAllByRole('button', { name: '+ 新建定时日报' }).length).toBeGreaterThan(0)
  })
})

describe('定时日报 · 完整日报配置（不丢旧能力）', () => {
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
  })

  it('纳入的消息类型用旧页面的真实类型与说明（默认全选）', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))

    expect(screen.getByText('纳入的消息类型')).toBeVisible()
    expect(screen.getByText('至少选择一种')).toBeVisible()

    // 七类都来自 SUMMARY_TYPE_OPTIONS，不是新写的一套。
    for (const label of ['文本', '图片', '表情包', '视频', '语音', '分享/引用', '系统消息']) {
      expect(screen.getByRole('checkbox', { name: label })).toBeVisible()
    }
    // 旧页面默认全选。
    expect(screen.getByRole('checkbox', { name: '文本' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '系统消息' })).toBeChecked()
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

describe('定时日报 · 返回与四选一发送目标', () => {
  it('新建页有「← 返回定时日报」，点击回到规则列表', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))

    await user.click(screen.getByRole('button', { name: '← 返回定时日报' }))
    // 回到「定时日报」列表，而不是自动化首页。
    expect(await screen.findByText('2 条规则')).toBeVisible()
    expect(screen.getByRole('radio', { name: '定时日报' })).toBeChecked()
  })

  it('编辑页也有返回入口，点击回到规则列表', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    const card = (await screen.findByText('TraceMemo 每日晚报')).closest('article') as HTMLElement
    await user.click(within(card).getByRole('button', { name: '编辑' }))
    expect(screen.getByRole('button', { name: '← 返回定时日报' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: '← 返回定时日报' }))
    expect(await screen.findByText('2 条规则')).toBeVisible()
  })

  it('只有「指定好友」才展开好友选择器', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))

    for (const label of ['文件传输助手', '发送到日报来源群', '发给自己']) {
      await user.click(screen.getByRole('radio', { name: label }))
      expect(screen.queryByPlaceholderText('搜索好友')).toBeNull()
    }

    await user.click(screen.getByRole('radio', { name: '指定好友' }))
    expect(screen.getByPlaceholderText('搜索好友')).toBeVisible()
  })

  it('Preview 随发送目标变化，且「发送到日报来源群」显示来源群名', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))

    await user.click(
      within(screen.getByRole('radiogroup', { name: '日报来源' })).getByRole('radio', {
        name: '技术交流群'
      })
    )

    const targetOf = (): string => {
      const rows = Array.from(document.querySelectorAll('.automation-preview-facts > div'))
      const row = rows.find((item) => item.querySelector('dt')?.textContent === '发送目标')
      return row?.querySelector('dd')?.textContent ?? ''
    }

    expect(targetOf()).toBe('文件传输助手')
    await user.click(screen.getByRole('radio', { name: '发送到日报来源群' }))
    expect(targetOf()).toBe('技术交流群')
    await user.click(screen.getByRole('radio', { name: '发给自己' }))
    expect(targetOf()).toBe('我')
  })

  it('Preview 随来源群与模板变化', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '+ 新建定时日报' }))

    await user.click(
      within(screen.getByRole('radiogroup', { name: '日报来源' })).getByRole('radio', {
        name: '技术交流群'
      })
    )
    const flow = document.querySelector('.automation-preview-flow')?.textContent ?? ''
    expect(flow).toContain('技术交流群')
    expect(flow).toContain('经典日报')

    await user.click(screen.getByLabelText('日报模板'))
    // 选项文案来自 REPORT_TEMPLATES 的 `label · name`。
    await user.click(await screen.findByRole('option', { name: /Mobile 01/ }))
    expect(document.querySelector('.automation-preview-flow')?.textContent).not.toContain('经典日报')
  })
})

describe('定时日报 · 不向用户暴露内部标识', () => {
  it('列表把 room id / hash 解析成显示名，绝不显示裸 id', async () => {
    // 合成值：形态与真实 room id / hash 相同（纯数字 + @chatroom、32 位十六进制），
    // 但取值本身可一眼辨认是假数据。与仓库其它测试保持一致。
    const FAKE_ROOM_ID = '12345678@chatroom'
    const FAKE_GROUP_HASH = '0123456789abcdef0123456789abcdef'

    installApi([
      { ...TASKS[0], group: FAKE_ROOM_ID, target: FAKE_ROOM_ID },
      { ...TASKS[1], group: FAKE_GROUP_HASH }
    ])
    renderWorkspace()
    await openScheduledTab()

    await screen.findByText('TraceMemo 每日晚报')
    const body = document.body.textContent ?? ''
    expect(body).not.toContain(FAKE_ROOM_ID)
    expect(body).not.toContain(FAKE_GROUP_HASH.slice(0, 12))
    // 对不上群名时给中性文案，而不是把 id 当名字。
    expect(screen.getAllByText('未知群聊').length).toBeGreaterThan(0)
  })
})

describe('定时日报 · 首页汇总卡', () => {
  it('首页把它当"多条规则"汇总，而不是一条 singleton', async () => {
    installApi()
    renderWorkspace()

    const card = (await screen.findByText('定时日报')).closest('article') as HTMLElement
    expect(card.textContent).toContain('2 条规则 · 1 条运行中')
    expect(card.textContent).toContain('按设定时间')
    // 汇总卡不该有单个启停开关。
    expect(within(card).queryByRole('switch')).toBeNull()

    await userEvent.setup().click(within(card).getByRole('button', { name: '管理定时日报 →' }))
    expect(await screen.findByText('2 条规则')).toBeVisible()
  })
})

describe('定时日报 · 深链与旧页面', () => {
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

  it('旧「日报 → 定时日报」页面仍在，且入口能触发跳转', async () => {
    installApi()
    const onOpenAutomation = vi.fn()

    render(
      <ToastProvider>
        <ScheduledReportsWorkspace
          contacts={[]}
          onOpenWechatSettings={() => {}}
          onOpenAgentHub={() => {}}
          onNotice={() => {}}
          onOpenAutomation={onOpenAutomation}
        />
      </ToastProvider>
    )

    expect(screen.getByRole('heading', { name: '定时日报' })).toBeVisible()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '在自动化中配置 →' }))
    expect(onOpenAutomation).toHaveBeenCalledTimes(1)
  })
})

/** 让 `waitFor` 在本文件被使用（空态/异步断言需要）。 */
describe('定时日报 · 异步加载', () => {
  it('加载完成后不再显示 loading', async () => {
    installApi()
    renderWorkspace()
    await openScheduledTab()

    await waitFor(() => expect(screen.queryByText('正在读取定时日报…')).toBeNull())
  })
})
