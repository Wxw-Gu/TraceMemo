import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiRequestTester } from '../../src/renderer/src/features/api-center/components/ApiRequestTester'
import { ReaderSkillOverview } from '../../src/renderer/src/features/api-center/components/ReaderSkillOverview'
import type { ApiEndpoint } from '../../src/renderer/src/features/api-center/model/types'

const requestEndpoint: ApiEndpoint = {
  id: 'report',
  method: 'POST',
  path: '/v1/report',
  name: '测试接口',
  description: '测试统一表单控件',
  parameters: [
    {
      key: 'talker',
      label: '会话标识',
      required: true,
      placeholder: '群昵称'
    }
  ],
  body: true
}

describe('API Center unified controls', () => {
  it('uses the unified menu for Reader Skill actions and restores trigger focus', async () => {
    const user = userEvent.setup()
    const onOpenFolder = vi.fn()
    const onOpenGithub = vi.fn()

    render(
      <ReaderSkillOverview
        skill={{
          available: true,
          version: 'v1.2',
          source: 'bundled',
          githubUrl: 'https://example.com/tracememo'
        }}
        service={{ running: true, host: '127.0.0.1', port: 6131 }}
        dbReady
        target="codex"
        onTargetChange={vi.fn()}
        onPreview={vi.fn()}
        onOpenFolder={onOpenFolder}
        onOpenGithub={onOpenGithub}
        onStart={vi.fn()}
        onCopyInstruction={vi.fn()}
        onCopyVerification={vi.fn()}
      />
    )

    const trigger = screen.getByRole('button', { name: '更多' })
    await user.click(trigger)
    await user.click(screen.getByRole('menuitem', { name: '打开本地文件夹' }))
    expect(onOpenFolder).toHaveBeenCalledOnce()

    await user.click(trigger)
    expect(screen.getByRole('menuitem', { name: '查看 GitHub 最新版本' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(onOpenGithub).not.toHaveBeenCalled()
  })

  it('exposes the Agent target as a real single-select control', async () => {
    const user = userEvent.setup()
    const onTargetChange = vi.fn()
    render(
      <ReaderSkillOverview
        skill={{
          available: true,
          version: 'v1.2',
          source: 'bundled',
          githubUrl: 'https://example.com/tracememo'
        }}
        service={{ running: true, host: '127.0.0.1', port: 6131 }}
        dbReady
        target="codex"
        onTargetChange={onTargetChange}
        onPreview={vi.fn()}
        onOpenFolder={vi.fn()}
        onOpenGithub={vi.fn()}
        onStart={vi.fn()}
        onCopyInstruction={vi.fn()}
        onCopyVerification={vi.fn()}
      />
    )

    expect(screen.getByRole('radio', { name: 'Codex' })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: 'Claude Code' }))
    expect(onTargetChange).toHaveBeenCalledWith('claude-code')
  })

  it('preserves request editing and action callbacks with unified form controls', async () => {
    const user = userEvent.setup()
    const onParams = vi.fn()
    const onBody = vi.fn()
    const onClear = vi.fn()
    const onCopyCurl = vi.fn(async () => undefined)
    const onSend = vi.fn()

    render(
      <ApiRequestTester
        endpoint={requestEndpoint}
        settings={{ apiEnabled: true, apiHost: '127.0.0.1', apiPort: 6131 }}
        service={{ running: true, host: '127.0.0.1', port: 6131 }}
        params={{}}
        body="{}"
        state="idle"
        error=""
        onParams={onParams}
        onBody={onBody}
        onSend={onSend}
        onClear={onClear}
        onCopyCurl={onCopyCurl}
      />
    )

    fireEvent.change(screen.getByPlaceholderText('群昵称'), {
      target: { value: '产品群' }
    })
    expect(onParams).toHaveBeenLastCalledWith({ talker: '产品群' })

    fireEvent.change(screen.getByLabelText('JSON 请求体'), {
      target: { value: '{"range":"today"}' }
    })
    expect(onBody).toHaveBeenLastCalledWith('{"range":"today"}')

    await user.click(screen.getByRole('button', { name: '清空' }))
    await user.click(screen.getByRole('button', { name: '复制 curl' }))
    await user.click(screen.getByRole('button', { name: '发送请求' }))
    expect(onClear).toHaveBeenCalledOnce()
    expect(onCopyCurl).toHaveBeenCalledOnce()
    expect(onSend).toHaveBeenCalledOnce()
  })

  it('keeps the send action disabled and exposes loading state accessibly', () => {
    const { rerender } = render(
      <ApiRequestTester
        endpoint={requestEndpoint}
        settings={{ apiEnabled: true, apiHost: '127.0.0.1', apiPort: 6131 }}
        service={{ running: false, host: '127.0.0.1', port: 6131 }}
        params={{}}
        body="{}"
        state="idle"
        error=""
        onParams={vi.fn()}
        onBody={vi.fn()}
        onSend={vi.fn()}
        onClear={vi.fn()}
        onCopyCurl={vi.fn(async () => undefined)}
      />
    )

    expect(screen.getByRole('button', { name: '请先启动本地 API 服务' })).toBeDisabled()

    rerender(
      <ApiRequestTester
        endpoint={requestEndpoint}
        settings={{ apiEnabled: true, apiHost: '127.0.0.1', apiPort: 6131 }}
        service={{ running: true, host: '127.0.0.1', port: 6131 }}
        params={{}}
        body="{}"
        state="loading"
        error=""
        onParams={vi.fn()}
        onBody={vi.fn()}
        onSend={vi.fn()}
        onClear={vi.fn()}
        onCopyCurl={vi.fn(async () => undefined)}
      />
    )

    const sending = screen.getByRole('button', { name: '发送中…' })
    expect(sending).toBeDisabled()
    expect(sending).toHaveAttribute('aria-busy', 'true')
  })
})
