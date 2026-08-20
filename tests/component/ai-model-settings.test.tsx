import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AIImageUnderstandingTest } from '../../src/renderer/src/features/settings/ai-model/AIImageUnderstandingTest'
import { AIProviderCard } from '../../src/renderer/src/features/settings/ai-model/AIProviderCard'
import { AIModelPage } from '../../src/renderer/src/features/settings/pages/AIModelPage'
import type { AIProviderSummary, AIRuntimeModelConfig } from '../../src/shared/ai-provider'
import type { AIVisionTestState } from '../../src/renderer/src/features/settings/ai-model/types'

const runtime: AIRuntimeModelConfig = {
  providerName: 'Not configured',
  model: '',
  modelName: 'No model selected',
  configured: false,
  status: 'untested'
}

const provider: AIProviderSummary = {
  id: 'fixture-provider',
  name: '本地假服务',
  type: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:1/v1',
  auth: { type: 'none' },
  models: [
    {
      id: 'fixture-model',
      name: '固定响应模型',
      capabilities: { chat: true, vision: true, ocr: true, longContext: true }
    }
  ],
  defaultModel: 'fixture-model',
  advanced: { timeoutMs: 5000, extraHeaders: {} },
  hasApiKey: true,
  isDefault: false,
  status: 'connected'
}

const visionState: AIVisionTestState = {
  status: 'ready',
  prompt: '描述图片',
  image: {
    dataUrl: 'data:image/png;base64,fixture',
    fileName: 'fixture.png',
    mimeType: 'image/png',
    size: 1024
  }
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

  it('keeps preset selection and derived vision capabilities intact', async () => {
    const user = userEvent.setup()
    render(<AIModelPage onRuntimeChange={vi.fn()} onNotice={vi.fn()} />)

    await act(async () => {
      await Promise.resolve()
    })
    await user.click(screen.getByRole('button', { name: '添加供应商' }))
    await user.click(screen.getByRole('combobox', { name: '快速模板' }))
    await user.click(screen.getByRole('option', { name: 'OpenAI', exact: true }))

    expect(screen.getByLabelText('供应商名称')).toHaveValue('OpenAI')
    expect(screen.getByLabelText('模型名称')).toHaveValue('gpt-4o-mini')
    const vision = screen.getByRole('checkbox', { name: '图片理解 gpt-4o-mini' })
    const ocr = screen.getByRole('checkbox', { name: '图片文字识别 gpt-4o-mini' })
    expect(vision).not.toBeChecked()
    expect(ocr).not.toBeChecked()
    await user.click(vision)
    expect(vision).toBeChecked()
    expect(ocr).toBeChecked()
    expect(screen.getByRole('radio', { name: '默认 gpt-4o-mini' })).toBeChecked()
  })

  it('uses shared button variants for provider card actions', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    const onTest = vi.fn()
    const onDefault = vi.fn()
    const onDelete = vi.fn()
    render(
      <AIProviderCard
        provider={provider}
        testing={false}
        onEdit={onEdit}
        onTest={onTest}
        onDefault={onDefault}
        onDelete={onDelete}
      />
    )

    await user.click(screen.getByRole('button', { name: '编辑' }))
    await user.click(screen.getByRole('button', { name: '测试连接' }))
    await user.click(screen.getByRole('button', { name: '设为默认' }))
    await user.click(screen.getByRole('button', { name: '删除' }))
    expect(onEdit).toHaveBeenCalledOnce()
    expect(onTest).toHaveBeenCalledOnce()
    expect(onDefault).toHaveBeenCalledOnce()
    expect(onDelete).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '删除' })).toHaveClass('bg-destructive')
  })

  it('keeps vision file input native while using shared prompt and action controls', async () => {
    const user = userEvent.setup()
    const onPromptChange = vi.fn()
    const onTest = vi.fn()
    const onClear = vi.fn()
    render(
      <AIImageUnderstandingTest
        runtime={{ ...runtime, configured: true }}
        provider={provider}
        state={visionState}
        onSelectImage={vi.fn()}
        onPromptChange={onPromptChange}
        onTest={onTest}
        onClear={onClear}
      />
    )

    expect(screen.getByRole('img', { name: '图片理解测试预览' })).toBeInTheDocument()
    expect(screen.getByLabelText('识别提示词')).toHaveValue('描述图片')
    await user.click(screen.getByRole('button', { name: '移除图片' }))
    await user.click(screen.getByRole('button', { name: '开始识别' }))
    expect(onClear).toHaveBeenCalledOnce()
    expect(onTest).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '开始识别' })).not.toHaveClass('database-key-primary')
  })
})
