import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WechatDb } from '../../src/main/wechat-db'
import { getGroupMemberIdsBatchAsync, setChatDb } from '../../src/main/services/chat-service'

/**
 * native `wcdb_get_group_members_batch` 只认 `@chatroom`：混入一个 `@qy_g`
 * 会让整批查询失败。这里用合成 id 固化「按通道拆分 + 按请求顺序合并」的契约。
 */
describe('enterprise group membership batch', () => {
  afterEach(() => setChatDb(null))

  const installDb = (client: Record<string, unknown>): void => {
    setChatDb({ close: vi.fn(), getWcdb4Client: () => client } as unknown as WechatDb)
  }

  it('never sends enterprise groups to the native batch call', async () => {
    const nativeBatch = vi.fn(async (roomIds: string[]) =>
      roomIds.map((roomId) => ({ roomId, status: 'ok', memberWxids: [`wxid_${roomId}`] }))
    )
    const enterpriseMembers = vi.fn(async (roomId: string) => [
      { m_nsUsrName: `wwmember_a_${roomId}@qy_u` },
      { m_nsUsrName: `wwmember_b_${roomId}@qy_u` }
    ])
    installDb({
      getGroupMemberIdsBatchAsync: nativeBatch,
      getEnterpriseGroupMembersAsync: enterpriseMembers
    })

    const snapshots = await getGroupMemberIdsBatchAsync([
      'alpha@chatroom',
      'fixture@qy_g',
      'beta@chatroom'
    ])

    expect(nativeBatch).toHaveBeenCalledOnce()
    expect(nativeBatch.mock.calls[0][0]).toEqual(['alpha@chatroom', 'beta@chatroom'])
    expect(enterpriseMembers).toHaveBeenCalledWith('fixture@qy_g')
    expect(snapshots?.map((snapshot) => snapshot.roomId)).toEqual([
      'alpha@chatroom',
      'fixture@qy_g',
      'beta@chatroom'
    ])
    expect(snapshots?.find((snapshot) => snapshot.roomId === 'fixture@qy_g')).toMatchObject({
      status: 'ok',
      memberIds: ['wwmember_a_fixture@qy_g@qy_u', 'wwmember_b_fixture@qy_g@qy_u']
    })
  })

  it('reports a failed enterprise member read as not_found instead of an empty group', async () => {
    installDb({
      getGroupMemberIdsBatchAsync: vi.fn(async () => []),
      getEnterpriseGroupMembersAsync: vi.fn(async () => null)
    })

    await expect(getGroupMemberIdsBatchAsync(['fixture@qy_g'])).resolves.toEqual([
      { roomId: 'fixture@qy_g', status: 'not_found', memberIds: [] }
    ])
  })

  it('treats a genuinely empty enterprise group as an ok empty membership', async () => {
    installDb({
      getGroupMemberIdsBatchAsync: vi.fn(async () => []),
      getEnterpriseGroupMembersAsync: vi.fn(async () => [])
    })

    await expect(getGroupMemberIdsBatchAsync(['fixture@qy_g'])).resolves.toEqual([
      { roomId: 'fixture@qy_g', status: 'ok', memberIds: [] }
    ])
  })

  it('preserves the previous baseline when the native batch call fails', async () => {
    installDb({
      getGroupMemberIdsBatchAsync: vi.fn(async () => null),
      getEnterpriseGroupMembersAsync: vi.fn(async () => [])
    })

    await expect(
      getGroupMemberIdsBatchAsync(['alpha@chatroom', 'fixture@qy_g'])
    ).resolves.toBeNull()
  })
})
