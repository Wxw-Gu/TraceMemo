import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportGroupMemberSelector } from '../../src/renderer/src/components/reports/ReportGroupMemberSelector'
import { ReportTaskStatusPanel } from '../../src/renderer/src/components/reports/ReportTaskStatusPanel'
import type { Contact } from '../../src/shared/types'

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

  it('shows a separate voice progress bar only when voice is selected', () => {
    const progress = { processed: 2, total: 3, succeeded: 2, failed: 0 }
    const { rerender } = render(
      <ReportTaskStatusPanel
        phase="transcribingVoice"
        error=""
        voiceTranscriptionProgress={progress}
        voiceTranscriptionEnabled
        onRetry={vi.fn()}
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
        onRetry={vi.fn()}
      />
    )
    expect(screen.queryByText('转写语音消息')).not.toBeInTheDocument()
    expect(screen.getByText('2/4')).toBeVisible()
  })

  it('loads and displays group nickname, WeChat nickname, and remark separately', async () => {
    render(<ReportGroupMemberSelector sourceContact={groupContact} />)

    await waitFor(() => expect(screen.getAllByText('群内昵称一')).toHaveLength(2))
    expect(screen.getByText('微信昵称一')).toBeVisible()
    expect(screen.getByText('通讯录备注一')).toBeVisible()
    expect(screen.getByText('wxid-one')).toBeVisible()
  })
})
