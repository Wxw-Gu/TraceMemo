import { describe, expect, it } from 'vitest'
import { normalizeContactName } from '../../src/shared/contact-resolution'
import { resolveContact } from '../../src/main/services/contact-resolution-service'

const contacts = [
  {
    md5: 'coach',
    m_nsUsrName: 'wxid_coach',
    m_nsNickName: '中田健身-弘毅',
    type: 'user' as const,
    remark: '弘毅教练'
  },
  { md5: 'zhangsan', m_nsUsrName: 'wxid_zhangsan', m_nsNickName: '张三', type: 'user' as const },
  {
    md5: 'zhangsanfeng',
    m_nsUsrName: 'wxid_zhangsanfeng',
    m_nsNickName: '张三丰',
    type: 'user' as const
  }
]

describe('ContactResolutionService', () => {
  it('canonicalizes whitespace, Unicode separators, punctuation and full-width variants', () => {
    const forms = [
      '中田健身-弘毅',
      '中田健身弘毅',
      '中田健身 弘毅',
      '中田健身—弘毅',
      '中田健身_弘毅'
    ]
    expect(new Set(forms.map(normalizeContactName))).toEqual(new Set(['中田健身弘毅']))
  })

  it('resolves every canonical name form to one conversation without substring guessing', () => {
    for (const value of [
      '中田健身-弘毅',
      '中田健身弘毅',
      '中田健身 弘毅',
      '中田健身—弘毅',
      '中田健身_弘毅'
    ]) {
      expect(resolveContact(value, contacts, 'person')).toMatchObject({
        matched: true,
        conversationId: 'coach',
        ambiguous: false
      })
    }
  })

  it('does not treat a partial name as an identity match', () => {
    expect(resolveContact('张三丰老师', contacts, 'person')).toMatchObject({
      matched: false,
      ambiguous: false,
      candidates: []
    })
  })

  it('does not auto-select duplicate canonical aliases', () => {
    const duplicate = [
      ...contacts,
      { ...contacts[0], md5: 'coach-duplicate', m_nsUsrName: 'wxid_other' }
    ]
    expect(resolveContact('中田健身弘毅', duplicate, 'person')).toMatchObject({
      matched: false,
      ambiguous: true,
      candidates: [expect.any(Object), expect.any(Object)]
    })
  })

  it('resolves one safe group suffix alias but rejects an alias collision', () => {
    const groups = [
      {
        md5: 'technology-group',
        m_nsUsrName: 'technology-group@chatroom',
        m_nsNickName: '技术交流',
        type: 'group' as const
      }
    ]
    expect(resolveContact('技术交流群', groups, 'group')).toMatchObject({
      matched: true,
      conversationId: 'technology-group',
      matchedBy: 'alias',
      ambiguous: false
    })
    expect(
      resolveContact(
        '技术交流群',
        [
          ...groups,
          {
            md5: 'technology-group-direct',
            m_nsUsrName: 'technology-group-direct@chatroom',
            m_nsNickName: '技术交流群',
            type: 'group' as const
          }
        ],
        'group'
      )
    ).toMatchObject({
      matched: false,
      ambiguous: true,
      candidates: [expect.any(Object), expect.any(Object)]
    })
  })
})
