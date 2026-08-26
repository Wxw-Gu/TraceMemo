import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AppearancePage } from '../../src/renderer/src/features/settings/pages/AppearancePage'

describe('AppearancePage UI pilot', () => {
  it('uses the shared radio and switch controls without changing settings semantics', async () => {
    const user = userEvent.setup()
    const onNotice = vi.fn()
    const onAppearanceChange = vi.fn()
    const settings = {
      appearanceTheme: 'system' as const,
      compactMode: false,
      showStartupProgress: true
    }
    const api = {
      getSettings: vi.fn(async () => ({ settings })),
      setSettings: vi.fn(async (patch: Partial<typeof settings>) => ({
        settings: Object.assign(settings, patch)
      }))
    }
    Object.defineProperty(window, 'api', { configurable: true, value: api })

    render(<AppearancePage onNotice={onNotice} onAppearanceChange={onAppearanceChange} />)
    expect(await screen.findByRole('heading', { name: '外观与行为' })).toBeVisible()

    await user.click(screen.getByRole('radio', { name: /深色/ }))
    await user.click(screen.getByRole('switch', { name: '紧凑布局' }))

    expect(api.setSettings).toHaveBeenCalledWith({ appearanceTheme: 'dark' })
    expect(api.setSettings).toHaveBeenCalledWith({ compactMode: true })
    expect(onNotice).toHaveBeenCalledWith('外观设置已保存')
  })
})
