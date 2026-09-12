import { describe, expect, it } from 'vitest'
import {
  displayContactName,
  filesystemSafeName,
  isVisibleName,
  visibleNamePart
} from '../../src/shared/contact-name'

describe('contact name safety', () => {
  it('recognizes private-use, zero-width, and control-only labels as invisible', () => {
    expect(isVisibleName('\uE000\uE000')).toBe(false)
    expect(isVisibleName('\u200B\u200D')).toBe(false)
    expect(displayContactName({ m_nsNickName: '\uE000\uE000', remark: '备注名', wxid: 'wxid_a' })).toBe(
      '备注名'
    )
  })

  it('preserves visible emoji and removes only non-rendering code points', () => {
    expect(visibleNamePart('  👩‍💻\u200B  ')).toBe('👩💻')
    expect(
      displayContactName({
        m_nsNickName: String.fromCodePoint(0xE0020),
        wechatId: 'wechat-alias'
      })
    ).toBe(
      'wechat-alias'
    )
  })

  it('sanitizes reserved path characters, trailing dots, device names, and length', () => {
    expect(filesystemSafeName('a/b:c*?"<>|. ')).toMatch(/^a_b_c_+$/)
    expect(filesystemSafeName('CON')).toBe('CON_')
    expect(filesystemSafeName('\uE000\uE000', '未命名联系人')).toBe('未命名联系人')
    expect(Array.from(filesystemSafeName('😀'.repeat(100))).length).toBe(80)
  })
})
