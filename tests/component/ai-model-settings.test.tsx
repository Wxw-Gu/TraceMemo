import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AIModelPage } from '../../src/renderer/src/features/settings/pages/AIModelPage'
import type { AIRuntimeModelConfig } from '../../src/shared/ai-provider'

const runtime: AIRuntimeModelConfig = {
  providerName: 'Not configured',
  model: '',
  modelName: 'No model selected',
  configured: false,
  status: 'untested'
}

describe('AI model settings', () => {
  const scrollIntoView = vi.fn()

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })
    window.api = {
      listAIProviders: vi.fn().mockResolvedValue({ success: true, providers: [] }),
      getAIRuntimeConfig: vi.fn().mockResolvedValue(runtime)
    } as typeof window.api
  })

  it('reveals the new provider editor and labels model identity fields', async () => {
    render(<AIModelPage onRuntimeChange={vi.fn()} onNotice={vi.fn()} />)

    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(screen.getByRole('button', { name: '添加供应商' }))

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    expect(screen.getByLabelText('供应商名称')).toHaveFocus()
    expect(screen.getByLabelText('模型名称')).toHaveAttribute('placeholder', '例如：DeepSeek Chat')
    expect(screen.getByLabelText('模型 ID')).toHaveAttribute('placeholder', '例如：deepseek-chat')
  })

  it('does not reload providers when the parent callback identity changes', async () => {
    const firstRuntimeChange = vi.fn()
    const secondRuntimeChange = vi.fn()
    const { rerender } = render(
      <AIModelPage onRuntimeChange={firstRuntimeChange} onNotice={vi.fn()} />
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(window.api.listAIProviders).toHaveBeenCalledOnce()
    expect(window.api.getAIRuntimeConfig).toHaveBeenCalledOnce()
    expect(firstRuntimeChange).toHaveBeenCalledWith(runtime)

    await act(async () => {
      rerender(<AIModelPage onRuntimeChange={secondRuntimeChange} onNotice={vi.fn()} />)
      await Promise.resolve()
    })

    expect(window.api.listAIProviders).toHaveBeenCalledOnce()
    expect(window.api.getAIRuntimeConfig).toHaveBeenCalledOnce()
    expect(secondRuntimeChange).not.toHaveBeenCalled()
  })
})
