import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  RuleListPanel,
  type RuleTemplateCardModel
} from '../../src/renderer/src/features/automation/RuleListPanel'
import { AUTOMATION_RULE_TEMPLATES } from '../../src/shared/automation'

function template(overrides: Partial<RuleTemplateCardModel> = {}): RuleTemplateCardModel {
  return {
    id: 'keyword-reply',
    name: '关键词自动回复',
    description: '消息命中关键词时自动回复指定内容',
    templateId: 'keyword-bot',
    extensionId: 'com.example.keyword-bot',
    actionId: 'keyword.reply',
    state: 'not-installed',
    ...overrides
  }
}

function renderPanel(
  templates: RuleTemplateCardModel[],
  handlers: {
    onOpenExtension?: (target: { templateId?: string; extensionId?: string }) => void
    onUseRuleTemplate?: (template: RuleTemplateCardModel) => void
  } = {}
): void {
  render(
    <RuleListPanel
      rules={[]}
      groups={[]}
      loading={false}
      busyRuleId={null}
      leaveNotification={null}
      scheduledReport={null}
      onToggle={() => undefined}
      onEdit={() => undefined}
      onDelete={() => undefined}
      onCreate={() => undefined}
      onEditLeaveNotification={() => undefined}
      onManageScheduledReport={() => undefined}
      ruleTemplates={templates}
      onOpenExtension={handlers.onOpenExtension}
      onUseRuleTemplate={handlers.onUseRuleTemplate}
    />
  )
}

describe('规则模板目录', () => {
  it('两个官方模板都在目录里，抖音那条没有动作', () => {
    const templateIds = AUTOMATION_RULE_TEMPLATES.map((item) => item.templateId).sort()
    expect(templateIds).toEqual(['douyin-sender', 'keyword-bot'])

    const douyin = AUTOMATION_RULE_TEMPLATES.find((item) => item.templateId === 'douyin-sender')
    expect(douyin?.actionId).toBeUndefined()
    const keyword = AUTOMATION_RULE_TEMPLATES.find((item) => item.templateId === 'keyword-bot')
    expect(keyword?.actionId).toBe('keyword.reply')
  })
})

describe('规则模板卡片', () => {
  it('未安装时给出「去扩展中心安装」，点击定位模板', async () => {
    const onOpenExtension = vi.fn()
    const user = userEvent.setup()
    renderPanel([template()], { onOpenExtension })

    expect(screen.getByText('未安装')).toBeTruthy()
    const button = screen.getByRole('button', { name: /去扩展中心安装/ })
    await user.click(button)
    expect(onOpenExtension).toHaveBeenCalledWith({ templateId: 'keyword-bot' })
  })

  it('已安装未启用时给出「去启用」，点击定位扩展详情', async () => {
    const onOpenExtension = vi.fn()
    const user = userEvent.setup()
    renderPanel([template({ state: 'installed-disabled', reason: '已安装但未启用' })], {
      onOpenExtension
    })

    expect(screen.getByText('已安装 · 未启用')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /去启用/ }))
    expect(onOpenExtension).toHaveBeenCalledWith({ extensionId: 'com.example.keyword-bot' })
  })

  it('已启用时提供「打开配置」与「用规则触发」', async () => {
    const onOpenExtension = vi.fn()
    const onUseRuleTemplate = vi.fn()
    const user = userEvent.setup()
    renderPanel([template({ state: 'ready' })], { onOpenExtension, onUseRuleTemplate })

    expect(screen.getByText('已就绪')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /打开扩展配置/ }))
    expect(onOpenExtension).toHaveBeenCalledWith({ extensionId: 'com.example.keyword-bot' })

    await user.click(screen.getByRole('button', { name: '用规则触发' }))
    expect(onUseRuleTemplate).toHaveBeenCalledTimes(1)
    expect(onUseRuleTemplate.mock.calls[0][0].actionId).toBe('keyword.reply')
  })

  it('不可用时显示真实原因且不给出操作入口', () => {
    renderPanel([template({ state: 'unavailable', reason: '扩展与当前 TraceMemo 版本不兼容' })])

    expect(screen.getByText('不可用')).toBeTruthy()
    expect(screen.getByText('扩展与当前 TraceMemo 版本不兼容')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /安装|启用|打开扩展配置/ })).toBeNull()
  })

  it('没有动作的模板只给配置入口，不出现「用规则触发」', () => {
    renderPanel([
      template({
        id: 'douyin-process',
        name: '抖音视频搬运',
        templateId: 'douyin-sender',
        extensionId: 'com.example.douyin-sender',
        actionId: undefined,
        state: 'ready'
      })
    ])

    expect(screen.getByText('已就绪')).toBeTruthy()
    expect(screen.getByRole('button', { name: /打开扩展配置/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '用规则触发' })).toBeNull()
    expect(screen.getByText(/没有注册自动化动作/)).toBeTruthy()
  })

  it('模板之外提供「做自己的扩展」入口', async () => {
    const onOpenExtension = vi.fn()
    const user = userEvent.setup()
    renderPanel([template()], { onOpenExtension })

    await user.click(screen.getByRole('button', { name: /开始二次开发/ }))
    expect(onOpenExtension).toHaveBeenCalledWith({ development: true })
  })

  it('卸载后卡片仍然存在（不因为扩展缺失就消失）', () => {
    renderPanel([template({ state: 'not-installed' })])
    expect(screen.getByText('关键词自动回复')).toBeTruthy()
  })
})
