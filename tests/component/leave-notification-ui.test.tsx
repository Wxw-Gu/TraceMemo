import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ToastProvider, TooltipProvider } from '../../src/renderer/src/components/ui'
import {
  AutomationWorkspace,
  type AutomationOpenRuleRequest
} from '../../src/renderer/src/features/automation/AutomationWorkspace'
import { GroupExitMonitorWorkspace } from '../../src/renderer/src/features/group-exit-monitor/GroupExitMonitorWorkspace'
import {
  BUILTIN_LEAVE_NOTIFICATION_RULE_ID,
  createDefaultDailyReportRule,
  createDefaultLeaveNotificationRule,
  type AutomationRule
} from '../../src/shared/automation'
import type { GroupExitMonitorState } from '../../src/shared/group-exit-monitor'

/**
 * 「自动化 → 规则 → 退群通知」现在是**真实配置页**。
 *
 * 这组测试锁的是「真实化」之后的契约：
 * - 已监控群聊数量来自退群监控（不是硬编码的 243）；
 * - 好友清单来自 main 侧的可发送联系人接口（不是 mock 的张三李四）；
 * - 保存真的会调用 singleton upsert；
 * - **效果预览永远不发送**；
 * - 退群监控里旧的通知群聊列与模板入口已经不存在。
 */

const MONITOR_STATE: GroupExitMonitorState = {
  events: [],
  enabled: true,
  running: true,
  nativeMonitorActive: true,
  monitoredGroupCount: 7,
  monitorSelectionConfigured: true,
  monitoredRoomIds: ['a@chatroom', 'b@chatroom', 'c@chatroom'],
  lastReadAt: 0,
  unreadCount: 0
}

const SENDABLE_CONTACTS = [
  { id: 'wxid_friend_a', name: '好友甲' },
  { id: 'wxid_friend_b', name: '好友乙' }
]

interface ApiSpies {
  saveLeaveNotificationRule: ReturnType<typeof vi.fn>
  createAutomationRule: ReturnType<typeof vi.fn>
  updateAutomationRule: ReturnType<typeof vi.fn>
  deleteAutomationRule: ReturnType<typeof vi.fn>
  setAutomationRuleEnabled: ReturnType<typeof vi.fn>
  setGroupExitMonitorGroups: ReturnType<typeof vi.fn>
  listSendableContacts: ReturnType<typeof vi.fn>
  listAutomationRules: ReturnType<typeof vi.fn>
}

function installApi(
  overrides: { leaveRule?: AutomationRule } = {}
): { spies: ApiSpies; rules: AutomationRule[] } {
  const leaveRule = overrides.leaveRule ?? createDefaultLeaveNotificationRule(Date.now())
  const rules = [createDefaultDailyReportRule(Date.now()), leaveRule]
  const spies: ApiSpies = {
    saveLeaveNotificationRule: vi.fn(async (draft: AutomationRule) => ({
      ...leaveRule,
      ...draft,
      id: BUILTIN_LEAVE_NOTIFICATION_RULE_ID
    })),
    createAutomationRule: vi.fn().mockResolvedValue(null),
    updateAutomationRule: vi.fn().mockResolvedValue(null),
    deleteAutomationRule: vi.fn().mockResolvedValue(false),
    setAutomationRuleEnabled: vi.fn().mockResolvedValue(null),
    setGroupExitMonitorGroups: vi.fn().mockResolvedValue(MONITOR_STATE),
    listSendableContacts: vi.fn().mockResolvedValue(SENDABLE_CONTACTS),
    listAutomationRules: vi.fn().mockResolvedValue(rules)
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
        message: '个人微信发送能力已就绪'
      }
    }),
    listAutomationRules: spies.listAutomationRules,
    listAutomationGroups: vi.fn().mockResolvedValue([]),
    listAutomationExecutions: vi.fn().mockResolvedValue([]),
    listSendableContacts: spies.listSendableContacts,
    getGroupExitMonitorState: vi.fn().mockResolvedValue(MONITOR_STATE),
    onGroupExitMonitorState: vi.fn(() => () => undefined),
    saveLeaveNotificationRule: spies.saveLeaveNotificationRule,
    createAutomationRule: spies.createAutomationRule,
    updateAutomationRule: spies.updateAutomationRule,
    deleteAutomationRule: spies.deleteAutomationRule,
    setAutomationRuleEnabled: spies.setAutomationRuleEnabled,
    setGroupExitMonitorGroups: spies.setGroupExitMonitorGroups
  } as unknown as typeof window.api

  return { spies, rules }
}

const renderWithProviders = (element: ReactElement): void => {
  render(<ToastProvider>{element}</ToastProvider>)
}

const renderMonitorWithProviders = (element: ReactElement): void => {
  render(
    <TooltipProvider>
      <ToastProvider>{element}</ToastProvider>
    </TooltipProvider>
  )
}

/** 找到首页那张「退群通知」卡片（现在有两张卡，都有「编辑」）。 */
async function leaveNotificationCard(): Promise<HTMLElement> {
  return (await screen.findByText('退群通知')).closest('article') as HTMLElement
}

/** 从自动化首页那张退群通知卡片的「编辑」进编辑器。 */
async function openLeaveNotificationEditor(overrides: {
  leaveRule?: AutomationRule
} = {}): Promise<{ spies: ApiSpies }> {
  const user = userEvent.setup()
  const { spies } = installApi(overrides)
  renderWithProviders(<AutomationWorkspace dbReady onOpenExitMonitorGroups={() => {}} />)

  const card = await leaveNotificationCard()
  await user.click(within(card).getByRole('button', { name: '编辑' }))
  return { spies }
}

const previewRecipient = (): string =>
  screen.getByTestId('leave-preview-recipient').textContent ?? ''

const previewFact = (label: string): string => {
  const rows = Array.from(document.querySelectorAll('.automation-preview-facts > div'))
  for (const row of rows) {
    if (row.querySelector('dt')?.textContent === label) {
      return row.querySelector('dd')?.textContent ?? ''
    }
  }
  return ''
}

const targetRadio = (label: string): HTMLElement => screen.getByRole('radio', { name: label })

describe('自动化 · 规则类型 Tab', () => {
  it('两种规则类型都是真规则，切换互不影响', async () => {
    const user = userEvent.setup()
    installApi()
    renderWithProviders(<AutomationWorkspace dbReady />)

    await screen.findByText('退群通知')
    await user.click(screen.getAllByRole('button', { name: '新建自动化' })[0])
    expect(screen.getByLabelText('关键词')).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: '退群通知' }))
    expect(screen.getByLabelText('退群通知模板内容')).toBeInTheDocument()
    expect(screen.queryByLabelText('关键词')).toBeNull()

    await user.click(screen.getByRole('radio', { name: '@我生成日报' }))
    expect(screen.getByLabelText('关键词')).toBeInTheDocument()
  })

  it('首页卡片显示真实状态与真实目标，不再有「待配置 / UI 预览」', async () => {
    installApi()
    renderWithProviders(<AutomationWorkspace dbReady />)

    await screen.findByText('退群通知')
    const card = screen.getByText('退群通知').closest('article') as HTMLElement

    expect(card.textContent).toContain('运行中')
    expect(card.textContent).toContain('当前群聊')
    expect(card.textContent).toContain('3 个已监控群聊')
    expect(document.body.textContent).not.toContain('待配置')
    expect(document.body.textContent).not.toContain('UI 预览')
  })

  it('迁移待重选的规则在首页显示为「配置异常」', async () => {
    installApi({
      leaveRule: createDefaultLeaveNotificationRule(Date.now(), {
        enabled: false,
        targetNeedsReview: true
      })
    })
    renderWithProviders(<AutomationWorkspace dbReady />)

    const card = (await screen.findByText('退群通知')).closest('article') as HTMLElement
    expect(card.textContent).toContain('配置异常')
  })
})

describe('退群通知 · 真实数据', () => {
  it('已监控群聊数量来自退群监控', async () => {
    await openLeaveNotificationEditor()

    expect(await screen.findByText('3 个群聊')).toBeVisible()
    expect(screen.queryByText('243 个群聊')).toBeNull()
  })

  it('好友清单来自 main 侧的可发送联系人接口', async () => {
    const user = userEvent.setup()
    await openLeaveNotificationEditor()

    await user.click(targetRadio('指定好友'))

    expect(screen.getByRole('radio', { name: '好友甲' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '好友乙' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: '张三' })).toBeNull()
  })

  it('Section 1 没有「触发范围」，只有唯一的「管理监控群聊」入口', async () => {
    await openLeaveNotificationEditor()

    expect(screen.queryByText('触发范围')).toBeNull()
    expect(screen.queryByText('全部已监控群聊')).toBeNull()
    expect(screen.queryByText('指定已监控群聊')).toBeNull()
    expect(screen.getByRole('button', { name: /管理监控群聊/ })).toBeEnabled()
  })

  it('规则级启停只有一个开关，没有第二个「发送退群通知」', async () => {
    await openLeaveNotificationEditor()

    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getByRole('switch', { name: '启用这条自动化' })).toBeVisible()
    expect(screen.queryByText('发送退群通知')).toBeNull()
  })
})

describe('退群通知 · 四种目标', () => {
  it('是四选一，「当前群聊」排第一且默认选中', async () => {
    await openLeaveNotificationEditor()

    const order = Array.from(
      document.querySelectorAll('.automation-leave-targets .automation-leave-radio label')
    ).map((label) => label.textContent?.trim())

    expect(order).toEqual(['当前群聊', '文件传输助手', '发给自己', '指定好友'])
    expect(targetRadio('当前群聊')).toBeChecked()
  })

  it('只有「指定好友」才展开好友选择器', async () => {
    const user = userEvent.setup()
    await openLeaveNotificationEditor()

    for (const label of ['文件传输助手', '当前群聊', '发给自己']) {
      await user.click(targetRadio(label))
      expect(screen.queryByPlaceholderText('搜索好友')).toBeNull()
    }

    await user.click(targetRadio('指定好友'))
    expect(screen.getByPlaceholderText('搜索好友')).toBeVisible()
  })

  it('好友只能选一个', async () => {
    const user = userEvent.setup()
    await openLeaveNotificationEditor()
    await user.click(targetRadio('指定好友'))

    await user.click(screen.getByRole('radio', { name: '好友甲' }))
    expect(screen.getByRole('radio', { name: '好友甲' })).toBeChecked()

    await user.click(screen.getByRole('radio', { name: '好友乙' }))
    expect(screen.getByRole('radio', { name: '好友乙' })).toBeChecked()
    expect(screen.getByRole('radio', { name: '好友甲' })).not.toBeChecked()
  })
})

describe('退群通知 · 保存与取消', () => {
  it('保存会写入 singleton 规则（含目标、模板、开关）', async () => {
    const user = userEvent.setup()
    const { spies } = await openLeaveNotificationEditor()

    // 刻意选一个**与默认不同**的目标：这样才验证了"保存的是用户选的"。
    await user.click(targetRadio('发给自己'))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(spies.saveLeaveNotificationRule).toHaveBeenCalledTimes(1))
    const draft = spies.saveLeaveNotificationRule.mock.calls[0][0] as AutomationRule
    expect(draft.id).toBe(BUILTIN_LEAVE_NOTIFICATION_RULE_ID)
    expect(draft.ruleType).toBe('leave_notification')
    expect(draft.enabled).toBe(true)
    expect(draft.leaveNotification?.target).toEqual({ type: 'self' })
    expect(draft.leaveNotification?.template).toContain('[退群监测]')
  })

  it('取消不写任何东西', async () => {
    const user = userEvent.setup()
    const { spies } = await openLeaveNotificationEditor()

    await user.click(targetRadio('发给自己'))
    await user.click(screen.getByRole('button', { name: '取消' }))

    expect(spies.saveLeaveNotificationRule).not.toHaveBeenCalled()
    // 回到首页：卡片上的目标仍是持久化的那个（默认「当前群聊」），不是刚点的「发给自己」。
    expect((await screen.findByText('退群通知')).closest('article')?.textContent).toContain(
      '当前群聊'
    )
  })

  it('重新打开时恢复的是已持久化配置，不是上次未保存的改动', async () => {
    const user = userEvent.setup()
    const { spies } = await openLeaveNotificationEditor()

    await user.click(targetRadio('发给自己'))
    await user.click(screen.getByRole('button', { name: '取消' }))

    await user.click(within(await leaveNotificationCard()).getByRole('button', { name: '编辑' }))
    expect(targetRadio('当前群聊')).toBeChecked()
    expect(spies.saveLeaveNotificationRule).not.toHaveBeenCalled()
  })

  it('启用开关也会被保存', async () => {
    const user = userEvent.setup()
    const { spies } = await openLeaveNotificationEditor()

    await user.click(screen.getByRole('switch', { name: '启用这条自动化' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(spies.saveLeaveNotificationRule).toHaveBeenCalledTimes(1))
    const draft = spies.saveLeaveNotificationRule.mock.calls[0][0] as AutomationRule
    expect(draft.enabled).toBe(false)
  })
})

describe('退群通知 · 效果预览', () => {
  it('预览用的是模板渲染结果，不是写死的示例', async () => {
    await openLeaveNotificationEditor()

    const bubble = document.querySelector('.automation-chat-bubble.pre')
    expect(bubble?.textContent).toContain('[退群监测]')
    // 占位符已按样本事件替换（同一套 shared 渲染规则）。
    expect(bubble?.textContent).toContain('用户: 张三')
    expect(bubble?.textContent).toContain('人数: 243 -> 242')
  })

  it('改发送目标 → 顶部模拟收件人跟着变', async () => {
    const user = userEvent.setup()
    await openLeaveNotificationEditor()

    // 默认 = 当前群聊 ⇒ 顶部收件会话就是发生退群的那个群。
    expect(previewRecipient()).toBe('TraceMemo 交流群')

    await user.click(targetRadio('文件传输助手'))
    expect(previewRecipient()).toBe('文件传输助手')

    await user.click(targetRadio('发给自己'))
    expect(previewRecipient()).toBe('我')
  })

  it('指定好友时预览收件人跟着好友变，未选时如实说未选择', async () => {
    const user = userEvent.setup()
    await openLeaveNotificationEditor()

    await user.click(targetRadio('指定好友'))
    expect(previewRecipient()).toBe('未选择好友')

    await user.click(screen.getByRole('radio', { name: '好友甲' }))
    expect(previewRecipient()).toBe('好友甲')
  })

  it('底部摘要随目标变化，且不含「执行方式」', async () => {
    const user = userEvent.setup()
    await openLeaveNotificationEditor()

    expect(previewFact('触发事件')).toBe('成员退出')
    expect(previewFact('监控来源')).toBe('3 个已监控群聊')
    expect(previewFact('通知目标')).toBe('发生退群事件的群聊')
    expect(document.querySelector('.automation-preview-facts')?.textContent).not.toContain('执行方式')

    await user.click(targetRadio('文件传输助手'))
    expect(previewFact('通知目标')).toBe('文件传输助手')
  })

  it('预览永远不触发发送与保存', async () => {
    const user = userEvent.setup()
    const { spies } = await openLeaveNotificationEditor()

    await user.click(targetRadio('当前群聊'))
    await user.click(targetRadio('指定好友'))

    for (const spy of [
      spies.saveLeaveNotificationRule,
      spies.createAutomationRule,
      spies.updateAutomationRule,
      spies.setAutomationRuleEnabled
    ]) {
      expect(spy).not.toHaveBeenCalled()
    }
  })

  it('编辑器里不出现底层实现词', async () => {
    await openLeaveNotificationEditor()

    expect(document.body.textContent).not.toMatch(/AutomationRule|trigger matcher|ActionRunner|WCDB/)
  })
})

describe('退群通知 · 通知内容与变量', () => {
  it('变量清单以 {groupName} 打头，且可以插进模板', async () => {
    const user = userEvent.setup()
    await openLeaveNotificationEditor()

    const chips = Array.from(document.querySelectorAll('.automation-leave-template-chip')).map(
      (chip) => chip.textContent
    )
    expect(chips).toEqual([
      '{groupName}',
      '{user}',
      '{groupRemark}',
      '{wxid}',
      '{previousCount}',
      '{currentCount}',
      '{time}'
    ])

    await user.click(screen.getByRole('button', { name: '插入变量 groupName' }))
    const textarea = screen.getByLabelText('退群通知模板内容') as HTMLTextAreaElement
    expect(textarea.value).toContain('{groupName}')
  })

  /*
   * 预览必须能同时看出「哪个群」和「谁退的」：
   * groupName 与 groupRemark 一旦取值相同，两者的区别就从界面上消失了。
   */
  it('预览里群名与成员群昵称是两个不同的值', async () => {
    await openLeaveNotificationEditor()

    const bubble = document.querySelector('.automation-chat-bubble.pre')
    expect(bubble?.textContent).toContain('群聊: TraceMemo 交流群')
    expect(bubble?.textContent).toContain('群备注: 小张')
  })

  it('底部说明直说「群名 vs 成员群昵称」的区别，且不含旧语义残句', async () => {
    await openLeaveNotificationEditor()

    const note = document.querySelector('.automation-leave-template-note')?.textContent ?? ''
    expect(note).toContain('未读取到')
    // 实测有人把 {groupRemark} 当成群名 —— 这句必须直说区别。
    expect(note).toContain('群聊名')
    expect(note).toContain('不是群名')
    // 旧文案两句都是错的：回退链被安到了 groupRemark 上；后半句是"只能发回原群"时代的残句。
    expect(note).not.toContain('通知仅发送到本规则配置的通知群聊')
    expect(note).not.toContain('群备注为空时可回退显示群昵称')
  })

  /*
   * 变量清单原先只有 {groupRemark} 这种符号，用户看不出含义，
   * 于是有人把它当成群名。每个 chip 必须带中文说明。
   */
  it('每个变量 chip 都带中文含义说明', async () => {
    await openLeaveNotificationEditor()

    const chips = Array.from(document.querySelectorAll('.automation-leave-template-chip'))
    const titleOf = (token: string): string =>
      chips
        .find((chip) => chip.textContent?.trim() === token)
        ?.getAttribute('title') ?? ''

    expect(titleOf('{groupName}')).toBe('{groupName}：群聊名（发生退群的群）')
    expect(titleOf('{groupRemark}')).toContain('不是群名')
    expect(titleOf('{user}')).toContain('退群成员')
    expect(titleOf('{time}')).toContain('退群时间')
  })
})

describe('退群通知 · 群聊名护栏', () => {
  /** 一份没有群名变量的模板（模拟用户主动删掉了那一行）。 */
  const ruleWithoutGroupName = (): AutomationRule => ({
    ...createDefaultLeaveNotificationRule(Date.now()),
    leaveNotification: {
      target: { type: 'source_chat' },
      template: '[退群监测]\n\n用户: {user}'
    }
  })

  it('目标是「当前群聊」时不提示 —— 通知就发在群里，群名是多余的', async () => {
    await openLeaveNotificationEditor({ leaveRule: ruleWithoutGroupName() })

    expect(screen.queryByText(/收件人看不出是哪个群退的人/)).toBeNull()
    expect(screen.queryByRole('button', { name: '补上群聊名' })).toBeNull()
  })

  it('目标改成非当前群聊时才提示，并给一键补上', async () => {
    const user = userEvent.setup()
    await openLeaveNotificationEditor({ leaveRule: ruleWithoutGroupName() })

    await user.click(targetRadio('文件传输助手'))
    expect(await screen.findByText(/收件人看不出是哪个群退的人/)).toBeVisible()

    await user.click(screen.getByRole('button', { name: '补上群聊名' }))

    const textarea = screen.getByLabelText('退群通知模板内容') as HTMLTextAreaElement
    expect(textarea.value).toContain('群聊: {groupName}')
    // 补完提示就消失。
    expect(screen.queryByText(/收件人看不出是哪个群退的人/)).toBeNull()
  })

  it('模板本来就含群名时，任何目标都不提示', async () => {
    const user = userEvent.setup()
    await openLeaveNotificationEditor()

    await user.click(targetRadio('发给自己'))
    expect(screen.queryByText(/收件人看不出是哪个群退的人/)).toBeNull()
  })
})

describe('退群监控 → 退群通知自动化', () => {
  it('退群监控页顶部有自动化入口', async () => {
    installApi()
    renderMonitorWithProviders(
      <GroupExitMonitorWorkspace dbReady onOpenLeaveNotificationAutomation={() => {}} />
    )

    expect(await screen.findByRole('button', { name: '配置退群通知自动化' })).toBeVisible()
  })

  it('点入口直接落到「自动化 → 规则 → 退群通知」', async () => {
    const user = userEvent.setup()
    installApi()

    function Harness(): React.ReactElement {
      const [page, setPage] = React.useState<'exit-monitor' | 'automation'>('exit-monitor')
      const [request, setRequest] = React.useState<AutomationOpenRuleRequest | null>(null)
      return page === 'exit-monitor' ? (
        <GroupExitMonitorWorkspace
          dbReady
          onOpenLeaveNotificationAutomation={() => {
            setRequest({ ruleType: 'leave_notification', requestId: 1 })
            setPage('automation')
          }}
        />
      ) : (
        <AutomationWorkspace dbReady openRuleRequest={request} />
      )
    }

    renderMonitorWithProviders(<Harness />)

    await user.click(await screen.findByRole('button', { name: '配置退群通知自动化' }))

    expect(await screen.findByLabelText('退群通知模板内容')).toBeVisible()
    expect(screen.getByRole('radio', { name: '退群通知' })).toBeChecked()
  })

  it('「管理监控群聊 →」把用户送回退群监控的管理群聊页', async () => {
    const user = userEvent.setup()
    installApi()
    const onOpenExitMonitorGroups = vi.fn()
    renderWithProviders(
      <AutomationWorkspace dbReady onOpenExitMonitorGroups={onOpenExitMonitorGroups} />
    )

    await user.click(within(await leaveNotificationCard()).getByRole('button', { name: '编辑' }))
    await user.click(screen.getByRole('button', { name: /管理监控群聊/ }))

    expect(onOpenExitMonitorGroups).toHaveBeenCalledTimes(1)
  })
})

describe('退群通知 · 规则缺失时的兜底', () => {
  /** 深链的对象引用必须稳定，否则 effect 每次渲染都会重跑。 */
  function DeepLinkHarness(): React.ReactElement {
    const [request] = React.useState<AutomationOpenRuleRequest>({
      ruleType: 'leave_notification',
      requestId: 1
    })
    return <AutomationWorkspace dbReady openRuleRequest={request} />
  }

  /*
   * 深链进来时编辑器是**同步**打开的，而规则列表还在 IPC 回来的路上。
   * 这一帧必然还没有规则 —— 它是最正常的加载状态，不能说成"尚未就绪 / 版本不匹配"。
   */
  it('规则还在读取时显示加载态，不把正常加载描述成故障', async () => {
    const { spies } = installApi()
    let release: (rules: AutomationRule[]) => void = () => undefined
    spies.listAutomationRules.mockReturnValue(
      new Promise<AutomationRule[]>((resolve) => {
        release = resolve
      })
    )

    renderWithProviders(<DeepLinkHarness />)

    expect(await screen.findByText('正在读取退群通知规则…')).toBeVisible()
    // 旧兜底文案（把正常加载说成故障）必须消失。这里用**完整旧句子**匹配 ——
    // 宽泛的 /尚未就绪/ 会命中顶部「发送能力」卡片，那是另一块 UI。
    expect(screen.queryByText(/退群通知规则尚未就绪/)).toBeNull()
    expect(screen.queryByText(/没有找到内置的退群通知规则/)).toBeNull()

    release([
      createDefaultDailyReportRule(Date.now()),
      createDefaultLeaveNotificationRule(Date.now())
    ])
    expect(await screen.findByLabelText('退群通知模板内容')).toBeVisible()
  })

  it('读完了确实没有这条规则时，给出准确说明与重试入口', async () => {
    const user = userEvent.setup()
    const { spies } = installApi()
    // 只有日报规则 —— 等价于「主进程还是迁移前的旧构建」。
    spies.listAutomationRules.mockResolvedValue([createDefaultDailyReportRule(Date.now())])

    renderWithProviders(<DeepLinkHarness />)

    expect(await screen.findByText('没有找到内置的退群通知规则。')).toBeVisible()
    expect(screen.getByText(/请重启 TraceMemo/)).toBeVisible()
    expect(screen.queryByText('正在读取退群通知规则…')).toBeNull()

    const before = spies.listAutomationRules.mock.calls.length
    await user.click(screen.getByRole('button', { name: '重新加载' }))
    await waitFor(() =>
      expect(spies.listAutomationRules.mock.calls.length).toBeGreaterThan(before)
    )
  })

  it('重试后规则回来了就直接进编辑器', async () => {
    const user = userEvent.setup()
    const { spies } = installApi()
    spies.listAutomationRules
      .mockResolvedValueOnce([createDefaultDailyReportRule(Date.now())])
      .mockResolvedValue([
        createDefaultDailyReportRule(Date.now()),
        createDefaultLeaveNotificationRule(Date.now())
      ])

    renderWithProviders(<DeepLinkHarness />)
    await user.click(await screen.findByRole('button', { name: '重新加载' }))

    expect(await screen.findByLabelText('退群通知模板内容')).toBeVisible()
  })
})

describe('退群监控 · 旧通知 UI 已移除', () => {
  it('管理群聊页没有「通知群聊」列，也没有「模板」按钮', async () => {
    const user = userEvent.setup()
    installApi()
    renderMonitorWithProviders(
      <GroupExitMonitorWorkspace
        dbReady
        contacts={[
          { m_nsUsrName: 'group_a@chatroom', m_nsNickName: '群 A', md5: 'md5-a', type: 'group' }
        ]}
        onOpenLeaveNotificationAutomation={() => {}}
      />
    )

    await user.click(await screen.findByRole('button', { name: '管理群聊' }))

    expect(screen.queryByText('通知群聊')).toBeNull()
    expect(screen.queryByRole('button', { name: '查看退群监测模板' })).toBeNull()
    // 监控选择本身仍然可用。
    expect(screen.getByLabelText('监控群 A')).toBeInTheDocument()
  })
})
