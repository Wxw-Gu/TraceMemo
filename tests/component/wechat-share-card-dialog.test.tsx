import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WechatShareCardDialog } from '../../src/renderer/src/components/reports/WechatShareCardDialog'

const getConfig = vi.fn()
const saveConfig = vi.fn()
const publishCard = vi.fn()

function Harness(): React.ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开分享卡片
      </button>
      {open && (
        <WechatShareCardDialog
          pngPath="/tmp/report.png"
          initialTitle="测试群日报"
          initialDescription="日报摘要"
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

describe('WechatShareCardDialog', () => {
  beforeEach(() => {
    getConfig.mockReset().mockResolvedValue({
      success: true,
      configured: true,
      serviceUrl: 'https://share.example.test'
    })
    saveConfig.mockReset().mockResolvedValue({ success: true })
    publishCard.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getWechatShareConfig: getConfig,
        saveWechatShareConfig: saveConfig,
        publishWechatShareCard: publishCard
      }
    })
  })

  it('closes with Escape or the overlay and restores focus to the opener', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opener = screen.getByRole('button', { name: '打开分享卡片' })

    await user.click(opener)
    expect(screen.getByRole('dialog', { name: '生成微信分享卡片' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '生成微信分享卡片' })).not.toBeInTheDocument()
    await waitFor(() => expect(opener).toHaveFocus())

    await user.click(opener)
    const dialog = screen.getByRole('dialog', { name: '生成微信分享卡片' })
    await user.click(dialog.previousElementSibling as HTMLElement)
    expect(screen.queryByRole('dialog', { name: '生成微信分享卡片' })).not.toBeInTheDocument()
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('keeps the dialog open when Escape is pressed while publishing', async () => {
    const user = userEvent.setup()
    publishCard.mockImplementation(() => new Promise(() => undefined))
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: '打开分享卡片' }))
    await waitFor(() => expect(getConfig).toHaveBeenCalledOnce())
    await user.click(screen.getByRole('button', { name: '生成二维码' }))
    expect(screen.getByRole('button', { name: '正在生成卡片…' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: '生成微信分享卡片' })).toBeVisible()
  })

  it('saves first-time configuration, publishes the card, and copies its link', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    getConfig.mockResolvedValue({ success: true, configured: false })
    publishCard.mockResolvedValue({
      success: true,
      shareUrl: 'https://share.example.test/card-1',
      qrCodeDataUrl: 'data:image/png;base64,fixture',
      expiresAt: '2026-08-26T08:00:00.000Z'
    })
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: '打开分享卡片' }))
    const uploadToken = await screen.findByPlaceholderText('Cloudflare Worker 的 UPLOAD_TOKEN')
    await user.clear(uploadToken)
    await user.type(uploadToken, 'a'.repeat(24))
    await user.click(screen.getByRole('button', { name: '生成二维码' }))

    await waitFor(() =>
      expect(saveConfig).toHaveBeenCalledWith({
        serviceUrl: 'https://share.example.com',
        uploadToken: 'a'.repeat(24)
      })
    )
    expect(publishCard).toHaveBeenCalledWith({
      pngPath: '/tmp/report.png',
      title: '测试群日报',
      description: '日报摘要',
      expiresInDays: 7
    })
    expect(await screen.findByAltText('微信分享二维码')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '复制分享链接' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://share.example.test/card-1'))
    expect(await screen.findByRole('button', { name: '链接已复制' })).toBeVisible()
  })
})
