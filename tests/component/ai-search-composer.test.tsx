import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  AISearchComposer,
  type AISearchComposerProps
} from '../../src/renderer/src/components/search/AISearchComposer'

const renderComposer = (
  overrides: Partial<AISearchComposerProps> = {}
): { props: AISearchComposerProps } => {
  const props: AISearchComposerProps = {
    query: '当前问题',
    sourceLabel: '所有聊天记录',
    rangeLabel: '近 30 天',
    history: ['历史问题一'],
    historyOpen: false,
    loading: false,
    knowledgeSyncing: false,
    onQueryChange: vi.fn(),
    onHistoryOpenChange: vi.fn(),
    onRestoreHistory: vi.fn(),
    onRemoveHistory: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides
  }
  render(<AISearchComposer {...props} />)
  return { props }
}

describe('AISearchComposer', () => {
  it('submits with the form or Enter while preserving Shift+Enter and IME composition', async () => {
    const user = userEvent.setup()
    const { props } = renderComposer()
    const textbox = screen.getByRole('textbox')

    await user.click(screen.getByRole('button', { name: /开始分析/ }))
    expect(props.onSubmit).toHaveBeenCalledOnce()

    fireEvent.keyDown(textbox, { key: 'Enter' })
    expect(props.onSubmit).toHaveBeenCalledTimes(2)

    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(textbox, { key: 'Enter', isComposing: true })
    expect(props.onSubmit).toHaveBeenCalledTimes(2)
  })

  it('updates the controlled query and routes loading cancellation', async () => {
    const user = userEvent.setup()
    const { props } = renderComposer({ loading: true })

    await user.type(screen.getByRole('textbox'), '新')
    expect(props.onQueryChange).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /取消分析/ }))
    expect(props.onCancel).toHaveBeenCalledOnce()
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('routes history restore, delete, and close interactions', async () => {
    const user = userEvent.setup()
    const { props } = renderComposer({ historyOpen: true })

    await user.click(screen.getByRole('button', { name: '历史问题一' }))
    expect(props.onRestoreHistory).toHaveBeenCalledWith('历史问题一')

    await user.click(screen.getByRole('button', { name: '删除历史问题：历史问题一' }))
    expect(props.onRemoveHistory).toHaveBeenCalledWith('历史问题一')

    await user.click(screen.getByRole('button', { name: '关闭历史提问' }))
    expect(props.onHistoryOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps submission available while Knowledge is syncing and only warns about coverage', () => {
    // 知识库同步是后台 / 可取消 / 可断点续传的，**不允许**因此禁止提问。
    // 索引没追平时应由 coverage/freshness 契约如实标注覆盖范围。
    renderComposer({ knowledgeSyncing: true })
    const submit = screen.getByRole('button', { name: /开始分析/ })
    expect(submit).toBeEnabled()
    expect(screen.queryByRole('button', { name: /暂不可分析/ })).not.toBeInTheDocument()
    expect(
      screen.getByText('知识库后台同步中 · 仍可提问，答案会标注覆盖范围')
    ).toBeInTheDocument()
  })
})
