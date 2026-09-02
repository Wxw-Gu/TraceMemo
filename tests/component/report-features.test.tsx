import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportGroupMemberSelector } from '../../src/renderer/src/components/reports/ReportGroupMemberSelector'
import { ReportTaskStatusPanel } from '../../src/renderer/src/components/reports/ReportTaskStatusPanel'
import { ReportTemplateSelector } from '../../src/renderer/src/components/reports/ReportTemplateSelector'
import { ReportViewer } from '../../src/renderer/src/components/reports/ReportViewer'
import { ReportInfoPanel } from '../../src/renderer/src/components/reports/ReportInfoPanel'
import { ReportToolbar } from '../../src/renderer/src/components/reports/ReportToolbar'
import { ReportHistorySidebar } from '../../src/renderer/src/components/reports/ReportHistorySidebar'
import { ModelSummary } from '../../src/renderer/src/components/reports/ModelSummary'
import { MessageTypeSelector } from '../../src/renderer/src/components/reports/MessageTypeSelector'
import { ReportDensitySelector } from '../../src/renderer/src/components/reports/ReportDensitySelector'
import { ReportRangeSelector } from '../../src/renderer/src/components/reports/ReportRangeSelector'
import { SUMMARY_TYPE_OPTIONS } from '../../src/renderer/src/utils/group-report'
import type { Contact } from '../../src/shared/types'
import type { GeneratedReportRecord } from '../../src/shared/report-history'

const noImageInsights = {
  total: 0,
  succeeded: 0,
  failed: 0,
  items: [],
  failures: []
}

const currentModel = {
  providerId: 'provider-1',
  providerName: '默认服务',
  model: 'model-1',
  modelName: '默认模型',
  configured: true,
  status: 'connected' as const
}

const groupContact: Contact = {
  md5: 'group-md5',
  m_nsUsrName: 'group@chatroom',
  m_nsNickName: '测试群',
  type: 'group'
}

describe('daily report controls', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getAppLogPath: vi.fn(async () => ''),
        revealAppLog: vi.fn(async () => undefined),
        getPersonalWechatSenderStatus: vi.fn(async () => ({
          state: 'online',
          platform: 'darwin',
          arch: 'arm64',
          sipDisabled: true,
          wechatRunning: true,
          runtimeReady: true,
          endpoint: '127.0.0.1:58080',
          endpointReady: true,
          attachReady: true,
          baseAddressReady: true,
          textHookInstalled: true,
          textHookReady: true,
          imageHookInstalled: true,
          imageHookReady: true,
          messageListenerReady: true,
          canSend: true,
          canSendText: true,
          canSendImage: true,
          canSendVoice: true,
          message: '个人微信已绑定'
        })),
        getTextToSpeechSettings: vi.fn(async () => ({
          success: true,
          settings: {
            provider: 'fish-audio',
            hasApiKey: false,
            hasStoredApiKey: false,
            hasEnvironmentApiKey: false,
            keySource: 'missing',
            encryptionAvailable: true,
            selectedVoiceId: '',
            outputFormat: 'mp3',
            model: 's2.1-pro-free',
            phase: 'ready'
          },
          voices: []
        })),
        listAIProviders: vi.fn(async () => ({ success: true, providers: [] })),
        getGroupSnapshot: vi.fn(async () => ({
          members: [
            {
              wxid: 'wxid-one',
              nickname: '兼容名称一',
              groupNickname: '群内昵称一',
              wechatNickname: '微信昵称一',
              remark: '通讯录备注一',
              avatar: ''
            },
            {
              wxid: 'wxid-two',
              nickname: '兼容名称二',
              groupNickname: '群内昵称二',
              wechatNickname: '微信昵称二',
              remark: '通讯录备注二',
              avatar: ''
            }
          ]
        }))
      }
    })
  })

  it('uses unified option and checkbox controls while preserving report selection rules', async () => {
    const user = userEvent.setup()
    const onRangeChange = vi.fn()
    const onTypesChange = vi.fn()
    render(
      <>
        <ReportRangeSelector
          value="today"
          messageCount={4}
          rangeState={{ status: 'success', error: '' }}
          disabled={false}
          onChange={onRangeChange}
        />
        <MessageTypeSelector
          value={['text']}
          counts={Object.fromEntries(SUMMARY_TYPE_OPTIONS.map((option) => [option.value, 1]))}
          disabled={false}
          onChange={onTypesChange}
        />
        <ReportDensitySelector />
      </>
    )

    expect(screen.getByRole('radio', { name: '今天' })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: '近 7 天' }))
    expect(onRangeChange).toHaveBeenCalledWith('7days')
    expect(screen.getAllByRole('checkbox')).toHaveLength(SUMMARY_TYPE_OPTIONS.length)
    const textCheckbox = screen.getAllByRole('checkbox')[0]
    expect(textCheckbox).toBeChecked()
    expect(textCheckbox).toBeDisabled()
    await user.click(screen.getAllByRole('checkbox')[1])
    expect(onTypesChange).toHaveBeenCalledWith(['text', 'image'])
    expect(screen.getByRole('radio', { name: /标准/ })).toBeChecked()
    screen.getAllByRole('radio', { name: /简洁|标准|深度/ }).forEach((item) => {
      expect(item).toBeDisabled()
    })
  })

  it('shows a separate voice progress bar only when voice is selected', () => {
    const progress = { processed: 2, total: 3, succeeded: 2, failed: 0 }
    const { rerender } = render(
      <ReportTaskStatusPanel
        phase="transcribingVoice"
        error=""
        voiceTranscriptionProgress={progress}
        voiceTranscriptionEnabled
        preparationProgress={null}
        imageInsightSummary={noImageInsights}
        canRetryModelStep={false}
        currentModel={currentModel}
        onRetry={vi.fn()}
        onContinueAfterImageFailures={vi.fn()}
        onCancelAfterImageFailures={vi.fn()}
      />
    )

    expect(screen.getByText('2/5')).toBeVisible()
    expect(screen.getByRole('progressbar', { name: '语音转写进度' })).toHaveAttribute('value', '2')

    rerender(
      <ReportTaskStatusPanel
        phase="preparingInput"
        error=""
        voiceTranscriptionProgress={null}
        voiceTranscriptionEnabled={false}
        preparationProgress={null}
        imageInsightSummary={noImageInsights}
        canRetryModelStep={false}
        currentModel={currentModel}
        onRetry={vi.fn()}
        onContinueAfterImageFailures={vi.fn()}
        onCancelAfterImageFailures={vi.fn()}
      />
    )
    expect(screen.queryByText('转写语音消息')).not.toBeInTheDocument()
    expect(screen.getByText('2/4')).toBeVisible()
  })

  it('shows image insight results and pauses for confirmation when some images fail', () => {
    const onContinue = vi.fn()
    const onCancel = vi.fn()
    render(
      <ReportTaskStatusPanel
        phase="awaitingImageDecision"
        error=""
        voiceTranscriptionProgress={null}
        voiceTranscriptionEnabled={false}
        preparationProgress={{
          stage: 'summarizingInput',
          label: '等待确认是否继续文字总结',
          completed: 2,
          total: 3
        }}
        imageInsightSummary={{
          total: 3,
          succeeded: 2,
          failed: 1,
          items: [
            {
              messageId: 'image-1',
              sender: '成员一',
              time: '10:20',
              description: '一张表格型网页截图。',
              ocrText: '列 A 列 B',
              tags: ['表格', '网页']
            }
          ],
          failures: [
            {
              messageId: 'image-2',
              sender: '成员二',
              time: '10:21',
              error: 'fetch failed'
            }
          ]
        }}
        canRetryModelStep={false}
        currentModel={currentModel}
        onRetry={vi.fn()}
        onContinueAfterImageFailures={onContinue}
        onCancelAfterImageFailures={onCancel}
      />
    )

    expect(screen.getByText('等待确认')).toBeVisible()
    expect(screen.getByText('有 1 张图片识别失败')).toBeVisible()
    expect(screen.getByText('一张表格型网页截图。')).toBeVisible()
    expect(screen.getByText('OCR：列 A 列 B')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '继续文字总结' }))
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
    expect(onContinue).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('allows switching models and retrying only the model step', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    window.api.listAIProviders = vi.fn(async () => ({
      success: true,
      providers: [
        {
          id: 'provider-2',
          name: '备用服务',
          type: 'openai-compatible',
          baseUrl: 'https://example.test',
          auth: { type: 'bearer' },
          models: [
            {
              id: 'model-2',
              name: '备用模型',
              capabilities: { chat: true, vision: false, ocr: false, longContext: true }
            }
          ],
          defaultModel: 'model-2',
          advanced: { timeoutMs: 120000, extraHeaders: {} },
          hasApiKey: true,
          isDefault: false,
          status: 'connected'
        }
      ]
    }))

    render(
      <ReportTaskStatusPanel
        phase="error"
        error="fetch failed"
        voiceTranscriptionProgress={null}
        voiceTranscriptionEnabled={false}
        preparationProgress={null}
        imageInsightSummary={noImageInsights}
        canRetryModelStep
        currentModel={currentModel}
        onRetry={onRetry}
        onContinueAfterImageFailures={vi.fn()}
        onCancelAfterImageFailures={vi.fn()}
      />
    )

    const retryButton = await screen.findByRole('button', { name: '使用所选模型重新生成' })
    const retryModel = screen.getByRole('combobox', { name: '切换模型' })
    await user.click(retryModel)
    expect(screen.getByRole('option', { name: '备用服务 · 备用模型' })).toBeVisible()
    await user.click(screen.getByRole('option', { name: '备用服务 · 备用模型' }))
    fireEvent.click(retryButton)
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'provider-2', model: 'model-2' })
    )
    expect(screen.getByText(/从第三步继续/)).toBeVisible()
  })

  it('selects separate text-summary and image-understanding models with the 10-minute cache rule', async () => {
    const user = userEvent.setup()
    const onTextModelChange = vi.fn()
    const onVisionModelChange = vi.fn()
    const textModels = [
      {
        providerId: 'deepseek',
        providerName: 'DeepSeek',
        model: 'deepseek-chat',
        modelName: 'DeepSeek Chat',
        configured: true as const,
        status: 'connected' as const
      },
      {
        providerId: 'openai',
        providerName: 'OpenAI',
        model: 'gpt-5.6-sol',
        modelName: 'GPT-5.6 Sol',
        configured: true as const,
        status: 'connected' as const
      }
    ]
    const visionModels = [
      {
        providerId: 'sol-provider',
        providerName: 'OpenAI',
        model: 'gpt-5.6-sol',
        modelName: 'GPT-5.6 Sol',
        configured: true as const,
        status: 'connected' as const
      },
      {
        providerId: 'vision-provider',
        providerName: 'Vision',
        model: 'vision-model',
        modelName: 'Vision Model',
        configured: true as const,
        status: 'connected' as const
      }
    ]
    render(
      <ModelSummary
        config={textModels[0]}
        visionConfig={visionModels[0]}
        textModels={textModels}
        visionModels={visionModels}
        onTextModelChange={onTextModelChange}
        onVisionModelChange={onVisionModelChange}
        onOpenSettings={vi.fn()}
      />
    )

    const textSelect = screen.getByRole('combobox', { name: '文字总结模型' })
    const visionSelect = screen.getByRole('combobox', { name: '图片理解模型' })
    expect(textSelect).toHaveTextContent('DeepSeek · DeepSeek Chat')
    expect(visionSelect).toHaveTextContent('OpenAI · GPT-5.6 Sol')
    await user.click(textSelect)
    await user.click(screen.getByRole('option', { name: 'OpenAI · GPT-5.6 Sol' }))
    await user.click(visionSelect)
    await user.click(screen.getByRole('option', { name: 'Vision · Vision Model' }))
    expect(onTextModelChange).toHaveBeenCalledWith(textModels[1])
    expect(onVisionModelChange).toHaveBeenCalledWith(visionModels[1])
    expect(screen.getByText(/图片识别缓存 10 分钟/)).toBeVisible()
  })

  it('zooms relative to a full-image fit constrained by viewport width and height', () => {
    const originalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      observe(): void {
        return undefined
      }
      disconnect(): void {
        return undefined
      }
      unobserve(): void {
        return undefined
      }
    }
    const report: GeneratedReportRecord = {
      id: 'report-1',
      contactId: 'group-md5',
      contactName: '测试群',
      dateRange: '今天',
      messageCount: 10,
      generatedAt: '2026-08-12T10:00:00.000Z',
      reportDate: '2026-08-12',
      htmlStatus: 'ready',
      pngStatus: 'ready',
      generatedImage: 'data:image/png;base64,fixture'
    }
    render(
      <ReportViewer
        report={report}
        hasReports
        onBackToConfigure={vi.fn()}
        onRegenerate={vi.fn()}
        onCopyImage={vi.fn(async () => ({ success: true }))}
        onReveal={vi.fn(async () => ({ success: true }))}
        onSwitchTemplate={vi.fn(async () => ({ success: true }))}
      />
    )
    const image = screen.getByAltText('测试群 群聊日报') as HTMLImageElement
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1440 })
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 4000 })
    Object.defineProperty(image.parentElement?.parentElement, 'clientWidth', {
      configurable: true,
      value: 760
    })
    Object.defineProperty(image.parentElement?.parentElement, 'clientHeight', {
      configurable: true,
      value: 600
    })
    fireEvent.load(image)
    expect(image.style.width).toBe('200px')
    fireEvent.click(screen.getByRole('button', { name: '缩小' }))
    expect(image.style.width).toBe('160px')
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    expect(image.style.width).toBe('200px')
    expect(screen.getByRole('button', { name: '完整显示' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '原始大小' }))
    expect(image.style.width).toBe('1440px')
    fireEvent.click(screen.getByRole('button', { name: '完整显示' }))
    expect(image.style.width).toBe('200px')
    globalThis.ResizeObserver = originalResizeObserver
  })

  it('keeps zoom working when a newly saved report replaces the initial result', () => {
    const originalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      observe(): void {
        return undefined
      }
      disconnect(): void {
        return undefined
      }
      unobserve(): void {
        return undefined
      }
    }
    const baseReport: GeneratedReportRecord = {
      id: 'temporary-result',
      contactId: 'group-md5',
      contactName: '测试群',
      dateRange: '今天',
      messageCount: 10,
      generatedAt: '2026-08-13T10:00:00.000Z',
      reportDate: '2026-08-13',
      htmlStatus: 'ready',
      pngStatus: 'ready',
      generatedImage: 'data:image/png;base64,fixture'
    }
    const props = {
      hasReports: true,
      onBackToConfigure: vi.fn(),
      onRegenerate: vi.fn(),
      onCopyImage: vi.fn(async () => ({ success: true })),
      onReveal: vi.fn(async () => ({ success: true })),
      onSwitchTemplate: vi.fn(async () => ({ success: true }))
    }
    const { rerender } = render(<ReportViewer report={baseReport} {...props} />)
    let image = screen.getByAltText('测试群 群聊日报') as HTMLImageElement
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1000 })
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 2000 })
    Object.defineProperty(image.parentElement?.parentElement, 'clientWidth', {
      configurable: true,
      value: 544
    })
    Object.defineProperty(image.parentElement?.parentElement, 'clientHeight', {
      configurable: true,
      value: 1044
    })
    fireEvent.load(image)
    expect(image.style.width).toBe('500px')

    rerender(<ReportViewer report={{ ...baseReport, id: 'saved-result' }} {...props} />)
    image = screen.getByAltText('测试群 群聊日报') as HTMLImageElement
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1000 })
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 2000 })
    Object.defineProperty(image.parentElement?.parentElement, 'clientWidth', {
      configurable: true,
      value: 544
    })
    Object.defineProperty(image.parentElement?.parentElement, 'clientHeight', {
      configurable: true,
      value: 1044
    })
    fireEvent.load(image)
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    expect(image.style.width).toBe('625px')
    globalThis.ResizeObserver = originalResizeObserver
  })

  it('keeps the file action inside More and labels both AI model roles', async () => {
    const user = userEvent.setup()
    render(
      <>
        <ReportToolbar
          canCopyImage
          canReveal
          canShare
          canSwitchTemplate
          currentTemplateId="v1"
          isSwitchingTemplate={false}
          onSwitchTemplate={vi.fn()}
          onRegenerate={vi.fn()}
          onCopyImage={vi.fn()}
          onReveal={vi.fn()}
          onShare={vi.fn()}
        />
        <ReportInfoPanel
          report={{
            id: 'model-info',
            contactId: 'group-md5',
            contactName: '测试群',
            dateRange: '今天',
            messageCount: 10,
            generatedAt: '2026-08-13T10:00:00.000Z',
            reportDate: '2026-08-13',
            htmlStatus: 'ready',
            pngStatus: 'ready',
            textModelName: 'deepseek-chat',
            imageModelName: 'gpt-5.6-sol'
          }}
          onReveal={vi.fn(async () => ({ success: true }))}
        />
      </>
    )

    expect(screen.queryByRole('menuitem', { name: '生成微信卡片' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '更多' }))
    expect(screen.getByRole('menuitem', { name: '生成微信卡片' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '打开文件夹' })).toBeVisible()
    expect(screen.getByText('文字模型')).toBeVisible()
    expect(screen.getByText('DeepSeek Chat')).toBeVisible()
    expect(screen.getByText('图片模型')).toBeVisible()
    expect(screen.getByText('gpt-5.6-sol')).toBeVisible()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menuitem', { name: '生成微信卡片' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '更多' })).toHaveFocus()
  })

  it('keeps unavailable toolbar actions disabled inside More', async () => {
    const user = userEvent.setup()
    const onReveal = vi.fn()
    const onShare = vi.fn()

    render(
      <ReportToolbar
        canCopyImage={false}
        canReveal={false}
        canShare={false}
        canSwitchTemplate={false}
        isSwitchingTemplate={false}
        onSwitchTemplate={vi.fn()}
        onRegenerate={vi.fn()}
        onCopyImage={vi.fn()}
        onReveal={onReveal}
        onShare={onShare}
      />
    )

    expect(screen.getByRole('button', { name: '切换模板' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '复制图片' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '打开报告' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '更多' }))
    const shareItem = screen.getByRole('menuitem', { name: '生成微信卡片' })
    const revealItem = screen.getByRole('menuitem', { name: '打开文件夹' })
    expect(shareItem).toHaveAttribute('data-disabled')
    expect(revealItem).toHaveAttribute('data-disabled')
    await user.click(shareItem)
    await user.click(revealItem)
    expect(onShare).not.toHaveBeenCalled()
    expect(onReveal).not.toHaveBeenCalled()
  })

  it('opens the current group send dialog with the report PNG preselected', async () => {
    const report: GeneratedReportRecord = {
      id: 'report-send',
      contactId: groupContact.md5,
      contactName: groupContact.m_nsNickName,
      dateRange: '今天',
      messageCount: 10,
      generatedAt: '2026-08-17T10:00:00.000Z',
      reportDate: '2026-08-17',
      htmlStatus: 'ready',
      pngStatus: 'ready',
      generatedImage: 'data:image/png;base64,fixture',
      pngPath: '/Users/fixture/测试群日报.png'
    }

    render(
      <ReportViewer
        report={report}
        hasReports
        onBackToConfigure={vi.fn()}
        onRegenerate={vi.fn()}
        onCopyImage={vi.fn(async () => ({ success: true }))}
        onReveal={vi.fn(async () => ({ success: true }))}
        onSwitchTemplate={vi.fn(async () => ({ success: true }))}
        sendTarget={groupContact}
        personalWechatSendSupported
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '发送到当前群聊' }))

    expect(await screen.findByRole('dialog', { name: '测试群' })).toBeVisible()
    expect(screen.getByRole('radio', { name: '图片' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('测试群日报.png')).toBeVisible()
    expect(screen.getByText('/Users/fixture/测试群日报.png')).toBeVisible()
  })

  it('disables current group sending outside macOS with a readable hover hint', () => {
    const report: GeneratedReportRecord = {
      id: 'report-send-disabled',
      contactId: groupContact.md5,
      contactName: groupContact.m_nsNickName,
      dateRange: '今天',
      messageCount: 10,
      generatedAt: '2026-08-17T10:00:00.000Z',
      reportDate: '2026-08-17',
      htmlStatus: 'ready',
      pngStatus: 'ready',
      generatedImage: 'data:image/png;base64,fixture',
      pngPath: '/Users/fixture/测试群日报.png'
    }

    render(
      <ReportViewer
        report={report}
        hasReports
        onBackToConfigure={vi.fn()}
        onRegenerate={vi.fn()}
        onCopyImage={vi.fn(async () => ({ success: true }))}
        onReveal={vi.fn(async () => ({ success: true }))}
        onSwitchTemplate={vi.fn(async () => ({ success: true }))}
        sendTarget={groupContact}
        personalWechatSendSupported={false}
      />
    )

    const button = screen.getByRole('button', { name: '发送到当前群聊' })
    expect(button).toBeDisabled()
    expect(button.parentElement).toHaveAttribute('title', '仅支持 macOS')
  })

  it('switches templates from the top toolbar using the saved report snapshot', async () => {
    const user = userEvent.setup()
    const onSwitchTemplate = vi.fn(async () => ({ success: true }))
    const report: GeneratedReportRecord = {
      id: 'report-switch',
      contactId: 'group-md5',
      contactName: '测试群',
      dateRange: '今天',
      messageCount: 10,
      generatedAt: '2026-08-12T10:00:00.000Z',
      reportDate: '2026-08-12',
      htmlStatus: 'ready',
      pngStatus: 'ready',
      generatedImage: 'data:image/png;base64,fixture',
      templateId: 'mobile-feed',
      reportSnapshot: {} as GeneratedReportRecord['reportSnapshot'],
      reportMetadata: {} as GeneratedReportRecord['reportMetadata']
    }

    const { rerender } = render(
      <ReportViewer
        report={report}
        hasReports
        onBackToConfigure={vi.fn()}
        onRegenerate={vi.fn()}
        onCopyImage={vi.fn(async () => ({ success: true }))}
        onReveal={vi.fn(async () => ({ success: true }))}
        onSwitchTemplate={onSwitchTemplate}
      />
    )

    await user.click(screen.getByRole('button', { name: '切换模板' }))
    expect(screen.getByText('仅重新排版，不调用 AI')).toBeVisible()
    expect(screen.getByRole('menuitem', { name: /默认模板经典日报/ })).toBeVisible()
    await user.click(screen.getByRole('menuitem', { name: /Mobile 03AI Command Center/ }))
    await waitFor(() => expect(onSwitchTemplate).toHaveBeenCalledWith(report, 'mobile-dashboard'))

    rerender(
      <ReportViewer
        report={{
          ...report,
          reportSnapshot: undefined,
          reportMetadata: undefined,
          htmlPath: '/tmp/legacy-report.html'
        }}
        hasReports
        onBackToConfigure={vi.fn()}
        onRegenerate={vi.fn()}
        onCopyImage={vi.fn(async () => ({ success: true }))}
        onReveal={vi.fn(async () => ({ success: true }))}
        onSwitchTemplate={onSwitchTemplate}
      />
    )
    expect(screen.getByRole('button', { name: '切换模板' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '切换模板' })).toHaveAttribute(
      'title',
      '使用已生成的数据或本地 HTML 更换展示模板，不会重新调用 AI'
    )

    rerender(
      <ReportViewer
        report={{
          ...report,
          reportSnapshot: undefined,
          reportMetadata: undefined,
          reportRenderSnapshot: undefined,
          htmlPath: undefined
        }}
        hasReports
        onBackToConfigure={vi.fn()}
        onRegenerate={vi.fn()}
        onCopyImage={vi.fn(async () => ({ success: true }))}
        onReveal={vi.fn(async () => ({ success: true }))}
        onSwitchTemplate={onSwitchTemplate}
      />
    )
    expect(screen.getByRole('button', { name: '切换模板' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '切换模板' })).toHaveAttribute(
      'title',
      '当前报告缺少可复用数据和 HTML，无法切换模板'
    )
  })

  it('loads and displays group nickname, WeChat nickname, and remark separately', async () => {
    const user = userEvent.setup()
    render(<ReportGroupMemberSelector sourceContact={groupContact} />)

    await waitFor(() => expect(screen.getAllByText('群内昵称一')).toHaveLength(2))
    expect(screen.getByText('微信昵称一')).toBeVisible()
    expect(screen.getByText('通讯录备注一')).toBeVisible()
    expect(screen.getByText('wxid-one')).toBeVisible()
    await user.click(screen.getByRole('combobox', { name: '选择群成员' }))
    await user.click(screen.getByRole('option', { name: '群内昵称二' }))
    expect(screen.getByText('微信昵称二')).toBeVisible()
    expect(screen.getByText('wxid-two')).toBeVisible()
  })

  it('cancels report deletion and restores focus to the delete trigger', async () => {
    const user = userEvent.setup()
    const report: GeneratedReportRecord = {
      id: 'report-delete-cancel',
      contactId: 'group-md5',
      contactName: '测试群',
      dateRange: '今天',
      messageCount: 10,
      generatedAt: '2026-08-17T10:00:00.000Z',
      reportDate: '2026-08-17',
      htmlStatus: 'ready',
      pngStatus: 'ready'
    }

    render(
      <ReportHistorySidebar
        reports={[report]}
        selectedReportId={report.id}
        selfInfo={null}
        dbReady
        onSelectReport={vi.fn()}
        onCreateReport={vi.fn()}
        onDeleteReport={vi.fn(async () => ({ success: true }))}
        onOpenSettings={vi.fn()}
      />
    )

    const deleteTrigger = screen.getByRole('button', { name: '删除日报' })
    await user.click(deleteTrigger)
    expect(screen.getByRole('alertdialog', { name: '删除日报？' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('alertdialog', { name: '删除日报？' })).not.toBeInTheDocument()
    expect(deleteTrigger).toHaveFocus()
  })

  it('prevents duplicate report deletion, keeps failures open, and closes after success', async () => {
    const user = userEvent.setup()
    const report: GeneratedReportRecord = {
      id: 'report-delete-result',
      contactId: 'group-md5',
      contactName: '测试群',
      dateRange: '今天',
      messageCount: 10,
      generatedAt: '2026-08-17T10:00:00.000Z',
      reportDate: '2026-08-17',
      htmlStatus: 'ready',
      pngStatus: 'ready'
    }
    let settleDelete: ((result: { success: boolean; error?: string }) => void) | undefined
    const onDeleteReport = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ success: boolean; error?: string }>((resolve) => {
            settleDelete = resolve
          })
      )
      .mockResolvedValueOnce({ success: true })

    render(
      <ReportHistorySidebar
        reports={[report]}
        selectedReportId={report.id}
        selfInfo={null}
        dbReady
        onSelectReport={vi.fn()}
        onCreateReport={vi.fn()}
        onDeleteReport={onDeleteReport}
        onOpenSettings={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: '删除日报' }))
    await user.click(screen.getByRole('button', { name: '删除', exact: true }))
    const pendingButton = screen.getByRole('button', { name: '删除中…' })
    expect(pendingButton).toBeDisabled()
    await user.click(pendingButton)
    expect(onDeleteReport).toHaveBeenCalledTimes(1)

    settleDelete?.({ success: false, error: '文件正在使用' })
    expect(await screen.findByText('文件正在使用')).toBeVisible()
    expect(screen.getByRole('alertdialog', { name: '删除日报？' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: '删除', exact: true }))
    await waitFor(() => expect(onDeleteReport).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: '删除日报？' })).not.toBeInTheDocument()
    )
  })

  it('offers the classic default plus three mobile and two desktop report templates', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ReportTemplateSelector value="v1" onChange={onChange} />)

    expect(screen.getAllByRole('radio')).toHaveLength(6)
    expect(screen.getByText('默认模板', { selector: '.report-template-group-title' })).toBeVisible()
    expect(screen.getByText('手机端 · 375–414 px')).toBeVisible()
    expect(screen.getByText('电脑端 · 1280–1920 px')).toBeVisible()
    expect(screen.getByText('经典日报')).toBeVisible()
    expect(screen.getByRole('radio', { name: /经典日报/ })).toBeChecked()
    expect(screen.getByText('微信信息流')).toBeVisible()
    expect(screen.getByText('AI Magazine')).toBeVisible()
    expect(screen.getByText('AI Command Center')).toBeVisible()
    expect(screen.getByText('三栏 AI 工作台')).toBeVisible()
    expect(screen.getByText('Editorial 科技日报')).toBeVisible()

    const previewButtons = screen.getAllByRole('button', { name: '查看版式' })
    expect(previewButtons).toHaveLength(6)
    await user.click(previewButtons[2])
    let dialog = screen.getByRole('dialog', { name: 'AI Magazine' })
    await user.click(within(dialog).getAllByRole('button', { name: '关闭' })[1])
    expect(document.activeElement).toBe(previewButtons[2])
    await user.click(previewButtons[2])
    dialog = screen.getByRole('dialog', { name: 'AI Magazine' })
    await user.click(within(dialog).getByRole('button', { name: '选择此模板' }))

    expect(onChange).toHaveBeenCalledWith('mobile-magazine')
  })
})
