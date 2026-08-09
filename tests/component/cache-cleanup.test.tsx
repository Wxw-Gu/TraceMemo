import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CacheCleanupPage } from '../../src/renderer/src/features/settings/pages/CacheCleanupPage'

const api = {
  getCacheSummary: vi.fn(),
  clearCache: vi.fn(),
  openKnowledgeDirectory: vi.fn()
}

describe('CacheCleanupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'api', { configurable: true, value: api })
    api.getCacheSummary.mockResolvedValue({
      items: [
        {
          id: 'knowledge',
          label: '本地知识库索引',
          description: '问一问微信使用的本地检索索引',
          sizeBytes: 1024,
          fileCount: 1
        }
      ],
      totalBytes: 1024,
      updatedAt: Date.now()
    })
    api.openKnowledgeDirectory.mockResolvedValue({ success: true })
  })

  it('opens the real knowledge directory without clearing it', async () => {
    const onNotice = vi.fn()
    render(<CacheCleanupPage onNotice={onNotice} />)

    await userEvent.click(await screen.findByRole('button', { name: '打开文件夹' }))

    await waitFor(() => expect(api.openKnowledgeDirectory).toHaveBeenCalledOnce())
    expect(api.clearCache).not.toHaveBeenCalled()
    expect(onNotice).toHaveBeenCalledWith('已打开知识库文件夹')
  })
})
