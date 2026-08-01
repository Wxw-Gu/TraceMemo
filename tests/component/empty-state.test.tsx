import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EmptyConversationState } from '../../src/renderer/src/components/chat/EmptyConversationState'
import { SettingsEmptyState } from '../../src/renderer/src/features/settings/components/SettingsEmptyState'

describe('empty states', () => {
  it('explains how to leave an empty archive without pretending data failed', () => {
    render(<EmptyConversationState />)
    expect(screen.getByRole('heading', { name: '选择一条消息' })).toBeVisible()
    expect(screen.getByText('从左侧选择群聊或联系人以浏览历史记录')).toBeVisible()
  })

  it('labels an unavailable settings section explicitly', () => {
    render(<SettingsEmptyState label="测试设置" />)
    expect(screen.getByRole('heading', { name: '测试设置' })).toBeVisible()
    expect(screen.getByText('该设置将在后续阶段接入。')).toBeVisible()
  })
})
