import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WechatDb } from '../../src/main/wechat-db'
import {
  closeChatDbForQuit,
  isReady,
  listContactsAsync,
  setChatDb
} from '../../src/main/services/chat-service'

describe('chat service contacts', () => {
  afterEach(() => setChatDb(null))

  it('hydrates display names before returning macOS-style session ids', async () => {
    const session = {
      username: '57101206391@chatroom',
      nickname: '57101206391@chatroom'
    }
    const getSessionsAsync = vi.fn(async (options: { hydrateDisplayNames?: boolean }) => {
      if (options.hydrateDisplayNames) session.nickname = '测试群聊'
      return [session]
    })
    const fakeDb = {
      close: vi.fn(),
      md5: () => 'fixture-md5',
      getAllGroupContacts: () => ({ fixture: session.nickname }),
      getUserList: () => [
        {
          m_nsUsrName: session.username,
          nickname: session.nickname
        }
      ],
      getWcdb4Client: () => ({ getSessionsAsync })
    } as unknown as WechatDb

    setChatDb(fakeDb)
    const contacts = await listContactsAsync()

    expect(getSessionsAsync).toHaveBeenCalledWith({
      hydrateDisplayNames: true,
      hydrateStatuses: true
    })
    expect(contacts[0]?.m_nsNickName).toBe('测试群聊')
  })

  it('detaches the database immediately and awaits native cleanup on quit', async () => {
    let finishClose: ((value: boolean) => void) | undefined
    const closeAsync = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishClose = resolve
        })
    )
    const fakeDb = {
      close: vi.fn(),
      closeAsync
    } as unknown as WechatDb

    setChatDb(fakeDb)
    const closing = closeChatDbForQuit()

    expect(isReady()).toBe(false)
    expect(closeAsync).toHaveBeenCalledOnce()
    finishClose?.(true)
    await expect(closing).resolves.toBe(true)

    const lateDb = { close: vi.fn() } as unknown as WechatDb
    expect(setChatDb(lateDb)).toBe(false)
    expect(lateDb.close).toHaveBeenCalledOnce()
  })
})
