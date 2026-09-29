import { describe, expect, it } from 'vitest'
import type { Contact } from '../../src/shared/types'
import { buildContactSearchIndex, filterContactSearchIndex } from '../../src/shared/contact-search'

/**
 * Issue #51 regression guard for the *shared* search primitives.
 *
 * The bug report claims that when one keyword matches a private contact AND a
 * group chat, the API returns nothing. These tests pin down that multi-match is
 * itself NOT the problem: the shared index/filter pair already returns every
 * match. The real defect lived in the data the HTTP layer fed into it.
 */

const user: Contact = {
  m_nsUsrName: 'wxid_fixture_user',
  m_nsNickName: '张三',
  md5: 'fixture-user-md5',
  type: 'user',
  remark: '张三'
}

const group: Contact = {
  m_nsUsrName: 'fixture_group@chatroom',
  m_nsNickName: '张三的测试群',
  md5: 'fixture-group-md5',
  type: 'group'
}

describe('filterContactSearchIndex with a keyword hitting a contact and a group', () => {
  it('returns both matches instead of collapsing to an empty list', () => {
    const index = buildContactSearchIndex([user, group])
    expect(filterContactSearchIndex(index, '张三')).toEqual([user, group])
  })

  it('still isolates the results with type=user', () => {
    const index = buildContactSearchIndex([user, group])
    expect(filterContactSearchIndex(index, '张三', 'user')).toEqual([user])
  })

  it('still isolates the results with type=group', () => {
    const index = buildContactSearchIndex([user, group])
    expect(filterContactSearchIndex(index, '张三', 'group')).toEqual([group])
  })
})
