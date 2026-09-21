import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { RuleEditorPanel } from '../../src/renderer/src/features/automation/RuleEditorPanel'
import {
  createDefaultDailyReportRule,
  type AutomationRule,
  type AutomationRuleDraft
} from '../../src/shared/automation'

/**
 * 「回复前等待」是**规则自己的一项执行参数**，配置位置就是
 * 「编辑自动化 → 3 · 触发后执行（命中条件后，TraceMemo 会按下面的顺序依次执行）」。
 *
 * 这一层要锁的是**接线**：初值必须来自规则本身、保存必须带回去。
 * 因为 `draftFromRule` 是逐字段搬运的，漏一个字段就会被 `normalizeRuleDraft`
 * 的默认值悄悄覆盖（把用户设成 0 的等待重置回 2 秒），这种 bug 只有真渲染才发现。
 */
const GROUPS = [{ id: '12345678@chatroom', name: '测试群' }]

function renderEditor(
  rule: AutomationRule,
  onSave: (draft: AutomationRuleDraft) => void = () => {}
): void {
  render(
    <RuleEditorPanel
      mode="edit"
      rule={rule}
      groups={GROUPS}
      saving={false}
      onCancel={() => {}}
      onSave={onSave}
    />
  )
}

const delayField = (): HTMLInputElement =>
  screen.getByLabelText('回复前等待秒数') as HTMLInputElement

describe('RuleEditorPanel · 回复前等待', () => {
  it('它就在「3 · 触发后执行」里，和动作顺序在同一段', () => {
    renderEditor(createDefaultDailyReportRule(0))

    expect(screen.getByText('命中条件后，TraceMemo 会按下面的顺序依次执行。')).toBeInTheDocument()
    expect(delayField()).toBeInTheDocument()
    expect(screen.getByText('回复前等待（秒）')).toBeInTheDocument()
  })

  it('初值来自规则本身，不是硬编码的默认值', () => {
    const rule = createDefaultDailyReportRule(0)
    rule.replyDelaySeconds = 7
    renderEditor(rule)

    expect(delayField()).toHaveValue(7)
  })

  it('保存时把改动带回去', () => {
    const saved: AutomationRuleDraft[] = []
    renderEditor(createDefaultDailyReportRule(0), (draft) => saved.push(draft))

    fireEvent.change(delayField(), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(saved).toHaveLength(1)
    expect(saved[0].replyDelaySeconds).toBe(0)
  })

  it('用户设成 0（立刻回复）时，保存不会把它顶回默认 2 秒', () => {
    const saved: AutomationRuleDraft[] = []
    const rule = createDefaultDailyReportRule(0)
    rule.replyDelaySeconds = 0
    renderEditor(rule, (draft) => saved.push(draft))

    // 什么都不改，直接保存：0 必须原样保留（而不是被默认的 2 顶掉）。
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(saved[0].replyDelaySeconds).toBe(0)
  })
})

/**
 * 「所有群聊」的边界提示。
 *
 * 真实能力是：同一时刻多个会话同时来消息时可能漏掉少量触发。
 * 这条限制**只挂在「所有群聊」这个上下文里** —— 首页不挂、指定群聊时不挂，
 * 而且只讲用户能理解的结果，不解释表事件 / 会话回读这类实现细节。
 */
const LIMITATION_TEXT = '当前版本在多个会话同时收到消息时，极少数自动化触发可能遗漏。'

function renderScopeEditor(conversationIds: string[]): void {
  const rule = createDefaultDailyReportRule(0)
  rule.conditions.conversationIds = conversationIds
  renderEditor(rule)
}

describe('RuleEditorPanel · 生效范围的边界提示', () => {
  it('一个群都没选（所有群聊）时显示提示', () => {
    renderScopeEditor([])

    // 编辑页与右侧效果预览都会显示范围描述，所以这里用 getAllByText。
    expect(screen.getAllByText('所有群聊').length).toBeGreaterThan(0)
    expect(screen.getAllByText(LIMITATION_TEXT)).toHaveLength(1)
  })

  it('选了具体群聊时不显示提示', () => {
    renderScopeEditor([GROUPS[0].id])

    expect(screen.getAllByText('已选 1 个群').length).toBeGreaterThan(0)
    expect(screen.queryAllByText(LIMITATION_TEXT)).toHaveLength(0)
  })

  it('提示里不出现底层实现词，也不做绝对承诺', () => {
    renderScopeEditor([])

    expect(LIMITATION_TEXT).not.toMatch(/WCDB|SessionTable|表变化|native|回读/)
    expect(document.body.textContent).not.toMatch(/覆盖所有群聊|100%|不会遗漏/)
  })
})
