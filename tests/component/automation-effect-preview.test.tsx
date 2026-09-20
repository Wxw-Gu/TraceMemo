import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EffectPreview } from '../../src/renderer/src/features/automation/EffectPreview'
import {
  createDefaultDailyReportRule,
  normalizeRuleDraft,
  type AutomationRuleDraft
} from '../../src/shared/automation'

/**
 * 效果模拟预览必须**跟着表单走**。
 *
 * 这些用例锁的是「改一个开关，预览立刻变」这条产品硬要求 ——
 * 预览一旦和真实规则脱钩，用户就会按一个错误的预期去保存规则。
 */

function draft(mutate?: (value: AutomationRuleDraft) => void): AutomationRuleDraft {
  const value = normalizeRuleDraft(createDefaultDailyReportRule(0))
  mutate?.(value)
  return value
}

/** 模拟消息气泡的内容（左侧对方那条）。 */
const incomingBubble = (): string =>
  document.querySelector('.automation-chat-row.incoming .automation-chat-bubble')?.textContent ?? ''

const hasReportImage = (): boolean => document.querySelector('.automation-chat-image') !== null

const hints = (): string[] =>
  Array.from(document.querySelectorAll('.automation-preview-hint')).map(
    (node) => node.textContent ?? ''
  )

describe('EffectPreview', () => {
  it('默认状态下展示 @你 + 关键词、回复气泡与日报图片预览', () => {
    render(<EffectPreview draft={draft()} />)

    expect(incomingBubble()).toBe('@你 今日日报')
    expect(screen.getByText('收到，正在生成今日日报')).toBeInTheDocument()
    expect(hasReportImage()).toBe(true)
    expect(screen.getByText('仅预览，不会真实发送')).toBeInTheDocument()
  })

  it('改关键词后左侧模拟消息同步变化', () => {
    const { rerender } = render(<EffectPreview draft={draft()} />)
    expect(incomingBubble()).toBe('@你 今日日报')

    rerender(
      <EffectPreview
        draft={draft((value) => {
          value.conditions.keyword = '周报'
        })}
      />
    )
    expect(incomingBubble()).toBe('@你 今日周报')
  })

  it('改回复文案后右侧气泡同步变化', () => {
    const { rerender } = render(<EffectPreview draft={draft()} />)

    rerender(
      <EffectPreview
        draft={draft((value) => {
          value.actions = value.actions.map((action) =>
            action.type === 'replyText' ? { ...action, text: '稍等，马上给你' } : action
          )
        })}
      />
    )
    expect(screen.getByText('稍等，马上给你')).toBeInTheDocument()
    expect(screen.queryByText('收到，正在生成今日日报')).not.toBeInTheDocument()
  })

  it('关闭「回复确认」后右侧回复气泡消失', () => {
    const { rerender } = render(<EffectPreview draft={draft()} />)
    expect(screen.getByText('收到，正在生成今日日报')).toBeInTheDocument()

    rerender(
      <EffectPreview
        draft={draft((value) => {
          value.actions = value.actions.map((action) =>
            action.type === 'replyText' ? { ...action, enabled: false } : action
          )
        })}
      />
    )
    expect(screen.queryByText('收到，正在生成今日日报')).not.toBeInTheDocument()
    // 真正被停用的动作不能只是"视觉上没了"，要给一句说明。
    expect(hints().some((text) => text.includes('未启用「回复确认」'))).toBe(true)
  })

  it('关闭「必须真正 @我」后左侧不再显示 @你', () => {
    const { rerender } = render(<EffectPreview draft={draft()} />)
    expect(incomingBubble().startsWith('@你')).toBe(true)

    rerender(
      <EffectPreview
        draft={draft((value) => {
          value.conditions.requireMentionMe = false
        })}
      />
    )
    expect(incomingBubble().startsWith('@你')).toBe(false)
    expect(incomingBubble()).toBe('今日日报')
  })

  it('关闭「生成日报」后不再出图片，并说明原因', () => {
    const { rerender } = render(<EffectPreview draft={draft()} />)
    expect(hasReportImage()).toBe(true)

    rerender(
      <EffectPreview
        draft={draft((value) => {
          value.actions = value.actions.map((action) =>
            action.type === 'generateReport' ? { ...action, enabled: false } : action
          )
        })}
      />
    )
    expect(hasReportImage()).toBe(false)
    expect(hints().some((text) => text.includes('未启用「生成日报」'))).toBe(true)
  })

  it('只关闭「发送图片」时，说明日报仍会生成但不会进群', () => {
    const { rerender } = render(<EffectPreview draft={draft()} />)
    expect(hasReportImage()).toBe(true)

    rerender(
      <EffectPreview
        draft={draft((value) => {
          value.actions = value.actions.map((action) =>
            action.type === 'sendReportImage' ? { ...action, enabled: false } : action
          )
        })}
      />
    )
    expect(hasReportImage()).toBe(false)
    // 这里必须和「没生成日报」区分开，否则用户不知道日报到底出没出来。
    expect(hints().some((text) => text.includes('日报仍会生成'))).toBe(true)
  })

  it('关键词留空时不伪造一个关键词出来', () => {
    render(
      <EffectPreview
        draft={draft((value) => {
          value.conditions.keyword = '   '
        })}
      />
    )
    expect(incomingBubble()).toBe('@你 今天群里有什么新消息')
  })

  it('生效范围与触发间隔随时间反映在摘要里', () => {
    const { rerender } = render(<EffectPreview draft={draft()} />)
    expect(screen.getByText('所有群聊')).toBeInTheDocument()
    expect(screen.getByText('60 秒')).toBeInTheDocument()

    rerender(
      <EffectPreview
        draft={draft((value) => {
          value.conditions.conversationIds = ['a@chatroom', 'b@chatroom']
          value.cooldownSeconds = 0
        })}
      />
    )
    expect(screen.getByText('已选 2 个群')).toBeInTheDocument()
    expect(screen.getByText('不限制')).toBeInTheDocument()
  })

  it('关闭「忽略自己发送」时摘要如实标注会触发', () => {
    const { rerender } = render(<EffectPreview draft={draft()} />)
    expect(screen.getByText('不触发')).toBeInTheDocument()

    rerender(
      <EffectPreview
        draft={draft((value) => {
          value.conditions.ignoreSelf = false
        })}
      />
    )
    expect(screen.getByText('也会触发')).toBeInTheDocument()
  })
})
