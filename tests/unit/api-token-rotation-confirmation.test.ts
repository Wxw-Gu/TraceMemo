import { describe, expect, it, vi } from 'vitest'
import {
  API_TOKEN_ROTATION_CONFIRMATION,
  confirmApiTokenRotation
} from '../../src/renderer/src/features/api-center/utils/confirmApiTokenRotation'

describe('API token rotation confirmation', () => {
  it('requires explicit confirmation and explains immediate invalidation', () => {
    const reject = vi.fn(() => false)
    expect(confirmApiTokenRotation(reject)).toBe(false)
    expect(reject).toHaveBeenCalledWith(API_TOKEN_ROTATION_CONFIRMATION)
    expect(API_TOKEN_ROTATION_CONFIRMATION).toContain('旧 Token 将立即失效')
    expect(API_TOKEN_ROTATION_CONFIRMATION).toContain('Agent / Reader Skill 需要更新 Token')
  })
})
