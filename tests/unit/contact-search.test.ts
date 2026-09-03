import { describe, expect, it } from 'vitest'
import type { Contact } from '../../src/shared/types'
import { filterContacts } from '../../src/renderer/src/utils/contact-search'

const contact: Contact = {
  m_nsUsrName: 'wxid_XxYyZz',
  m_nsNickName: '小号',
  md5: 'fixture',
  type: 'user',
  remark: '工作手机',
  wechatNickname: 'Shinven',
  alias: 'abc123',
  wechatId: 'wechat_abc123'
}

describe('filterContacts', () => {
  it.each(['Shinven', '小号', '工作', 'gongzuoshouji', 'gzsj', 'abc123', 'WECHAT_ABC', 'WXID_xxy'])(
    'matches all contact identity fields with %s',
    (query) => {
      expect(filterContacts([contact], `  ${query}  `)).toEqual([contact])
    }
  )

  it('returns the original list for a blank query and excludes unrelated contacts', () => {
    const list = [contact]
    expect(filterContacts(list, '   ')).toBe(list)
    expect(filterContacts(list, 'not-found')).toEqual([])
  })

  it('matches pinyin when the Chinese name is stored in m_nsNickName', () => {
    const list = [{ ...contact, remark: '', wechatNickname: '' }]

    expect(filterContacts(list, 'xiaohao')).toEqual(list)
    expect(filterContacts(list, 'xh')).toEqual(list)
  })

  it('matches pinyin for a dedicated Chinese remark', () => {
    const list = [{ ...contact, m_nsNickName: 'Shinven', remark: '小号' }]

    expect(filterContacts(list, 'xiaohao')).toEqual(list)
    expect(filterContacts(list, 'xh')).toEqual(list)
  })
})
