/**
 * 图片密钥的「显示 / 隐藏」开关。
 *
 * 契约（产品要求）：AES 密钥默认遮蔽，用户点一下眼睛能看见自己填的值。
 * 关键边界：这只是**显示层**行为 —— 不许改动值、不许触发保存、不许影响校验。
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ImageKeyConfiguration } from '../../src/renderer/src/features/settings/image-decryption/ImageKeyConfiguration'
import type { ImageDecryptionState } from '../../src/renderer/src/features/settings/image-decryption/types'

const AES_KEY = '0123456789abcdef'

function state(overrides: Partial<ImageDecryptionState> = {}): ImageDecryptionState {
  return {
    phase: 'idle',
    config: null,
    status: null,
    contacts: [],
    selectedUserMd5: '',
    resourceRoot: '/tmp/fixture',
    xorKey: '0x40',
    aesKey: AES_KEY,
    testResult: null,
    autoPhase: 'idle',
    autoProgress: '',
    dirty: false,
    ...overrides
  }
}

const aesInput = (): HTMLInputElement => {
  const inputs = document.querySelectorAll<HTMLInputElement>('.image-key-secret > input')
  if (!inputs.length) throw new Error('AES input missing')
  return inputs[0]
}

describe('图片密钥显示开关', () => {
  it('默认遮蔽，且按钮自称「显示图片密钥」', () => {
    render(<ImageKeyConfiguration state={state()} disabled={false} onEdit={vi.fn()} />)

    expect(aesInput().type).toBe('password')
    expect(aesInput().value).toBe(AES_KEY)

    const toggle = screen.getByTestId('image-key-reveal')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveAccessibleName('显示图片密钥')
  })

  it('点一下明文显示，再点一下回到遮蔽', async () => {
    render(<ImageKeyConfiguration state={state()} disabled={false} onEdit={vi.fn()} />)
    const toggle = screen.getByTestId('image-key-reveal')

    await userEvent.click(toggle)
    expect(aesInput().type).toBe('text')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveAccessibleName('隐藏图片密钥')
    // 明文里能真的读到密钥本身。
    expect(aesInput().value).toBe(AES_KEY)

    await userEvent.click(toggle)
    expect(aesInput().type).toBe('password')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })

  it('只是显示层：切换不许改值、不许触发保存', async () => {
    const onEdit = vi.fn()
    render(<ImageKeyConfiguration state={state()} disabled={false} onEdit={onEdit} />)

    await userEvent.click(screen.getByTestId('image-key-reveal'))

    expect(onEdit).not.toHaveBeenCalled()
    expect(aesInput().value).toBe(AES_KEY)
    // XOR 字段不该被顺手改成密码框 —— 它本来就不是敏感值，一直是明文。
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0)
  })

  it('不可编辑时开关也跟着禁用，避免"能看不能改"的错觉', () => {
    render(<ImageKeyConfiguration state={state()} disabled onEdit={vi.fn()} />)

    expect(screen.getByTestId('image-key-reveal')).toBeDisabled()
    expect(aesInput()).toBeDisabled()
  })
})
