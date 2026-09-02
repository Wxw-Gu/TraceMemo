import { Wcdb4Client, Wcdb4MessageQueryOptions } from './wcdb4-client'
import { wcdbDebugLog } from './wcdb-debug'

export interface UserContact {
  m_nsUsrName: string
  nickname: string
  avatar?: string
  wechatNickname?: string
  remark?: string
  isFolded?: boolean
  isMuted?: boolean
}

export interface WechatMessage {
  mesLocalID: string
  mesDes: number
  messageType: string
  msgCreateTime: string
  msgContent: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

export interface Contact {
  m_nsUsrName: string
  m_nsNickName: string
  md5: string
  type: 'user' | 'group'
  avatar?: string
}

export interface GroupMemberInfo {
  m_nsUsrName: string
  nickname: string
  m_nsHeadImgUrl: string
}

function mergeExportMessages(messages: WechatMessage[]): WechatMessage[] {
  const merged = new Map<string, WechatMessage>()
  for (const message of messages) {
    const serverId = String(message.serverId || '')
    const recovered = Boolean(message.raw?.['_wxe_recovered'] || message['_wxe_recovered'])
    const identity =
      serverId && serverId !== '0'
        ? `server:${serverId}`
        : `local:${message.mesLocalID}:${message.msgCreateTime}`
    merged.set(recovered ? `recovered:${identity}` : identity, message)
  }
  return Array.from(merged.values()).sort(
    (left, right) =>
      Number(left.msgCreateTime || 0) - Number(right.msgCreateTime || 0) ||
      Number(left.mesLocalID || 0) - Number(right.mesLocalID || 0)
  )
}

export class WechatDb {
  private wcdb4Client: Wcdb4Client
  private chatMd5ToUsername = new Map<string, string>()
  private chatTableMappingLoaded = false

  static async create(rawKey: string, accountRoot?: string): Promise<WechatDb> {
    const client = new Wcdb4Client(rawKey, accountRoot)
    await client.openAsync()
    return new WechatDb(rawKey, accountRoot, client)
  }

  constructor(
    rawKey: string,
    accountRoot?: string,
    clientOverride?: Wcdb4Client,
    initialChatTables?: { name: string; db_number: string }[]
  ) {
    console.log(`Initializing WechatDb with key length: ${rawKey.trim().length}`)
    const client = clientOverride || new Wcdb4Client(rawKey, accountRoot)
    if (!clientOverride) client.open()
    this.wcdb4Client = client
    for (const table of initialChatTables || []) {
      if (table.name.startsWith('Chat_')) {
        this.chatMd5ToUsername.set(table.name.substring(5), table.db_number)
      }
    }
    this.chatTableMappingLoaded = Boolean(initialChatTables)
  }

  private ensureChatTableMapping(): void {
    if (this.chatTableMappingLoaded) return
    for (const table of this.wcdb4Client.getChatTables()) {
      if (table.name.startsWith('Chat_')) {
        this.chatMd5ToUsername.set(table.name.substring(5), table.db_number)
      }
    }
    this.chatTableMappingLoaded = true
  }

  public getUserList(nicknameFilter?: string): UserContact[] {
    const keyword = (nicknameFilter || '').trim().toLowerCase()
    return this.wcdb4Client
      .getSessions()
      .map((session) => ({
        m_nsUsrName: session.username,
        nickname: session.nickname || session.username,
        avatar: session.avatar,
        wechatNickname: session.wechatNickname,
        remark: session.remark,
        isFolded: session.isFolded,
        isMuted: session.isMuted
      }))
      .filter((contact) => {
        if (!keyword) return true
        return (
          contact.m_nsUsrName.toLowerCase().includes(keyword) ||
          contact.nickname.toLowerCase().includes(keyword)
        )
      })
  }

  public getAllGroupContacts(): Record<string, string> {
    const groupContacts: Record<string, string> = {}
    for (const session of this.wcdb4Client.getSessions()) {
      if (session.username.endsWith('@chatroom')) {
        groupContacts[this.md5(session.username)] = session.nickname || session.username
      }
    }
    return groupContacts
  }

  public getAllGroupMembers(): Record<string, string> {
    const members: Record<string, string> = {}
    for (const session of this.wcdb4Client.getSessions()) {
      if (!session.username.endsWith('@chatroom')) continue
      for (const member of this.wcdb4Client.getGroupMembers(session.username)) {
        if (member.m_nsUsrName) {
          members[member.m_nsUsrName] = member.nickname || member.m_nsUsrName
        }
      }
    }
    return members
  }

  public getGroupMembersForChat(userMd5: string): Record<string, string> {
    this.ensureChatTableMapping()
    const username = this.chatMd5ToUsername.get(userMd5)
    if (!username || !username.endsWith('@chatroom')) return {}

    const members: Record<string, string> = {}
    for (const member of this.wcdb4Client.getGroupMembers(username)) {
      if (member.m_nsUsrName) {
        members[member.m_nsUsrName] = member.nickname || member.m_nsUsrName
      }
    }
    return members
  }

  public getGroupMember(wxid: string, chatroomId?: string): GroupMemberInfo | null {
    if (!chatroomId) return null
    return (
      this.wcdb4Client.getGroupMembers(chatroomId).find((member) => member.m_nsUsrName === wxid) ||
      null
    )
  }

  public getAllChatTables(): { name: string; db_number: string }[] {
    return this.wcdb4Client.getChatTables()
  }

  public getMyAvatarUrl(): string | undefined {
    return this.wcdb4Client.getMyAvatarUrl()
  }

  public getWcdb4Client(): Wcdb4Client {
    return this.wcdb4Client
  }

  public close(): void {
    this.wcdb4Client.close()
  }

  public closeAsync(timeoutMs?: number): Promise<boolean> {
    return this.wcdb4Client.closeAsync(timeoutMs)
  }

  public getUserMessages(
    userMd5: string,
    startTime?: number,
    endTime?: number,
    options?: Wcdb4MessageQueryOptions
  ): WechatMessage[] {
    this.ensureChatTableMapping()
    const username = this.chatMd5ToUsername.get(userMd5)
    if (!username) return []
    return this.wcdb4Client.getMessages(username, startTime, endTime, options).map((message) => ({
      ...message.raw,
      ...message
    }))
  }

  public async getUserMessagesAsync(
    userMd5: string,
    startTime?: number,
    endTime?: number,
    options?: Wcdb4MessageQueryOptions,
    requestId = 'NO-REQUEST'
  ): Promise<WechatMessage[]> {
    this.ensureChatTableMapping()
    const username = this.chatMd5ToUsername.get(userMd5)
    if (!username) return []
    const startedAt = Date.now()
    wcdbDebugLog(`[${requestId}] WechatDb getUserMessagesAsync start username=${username}`)
    const messages = await this.wcdb4Client.getMessagesAsync(
      username,
      startTime,
      endTime,
      options,
      requestId
    )
    const mapped = messages.map((message) => ({ ...message.raw, ...message }))
    wcdbDebugLog(
      `[${requestId}] WechatDb getUserMessagesAsync end rows=${mapped.length} cost=${Date.now() - startedAt}ms`
    )
    return mapped
  }

  public async getUserMessagesForExport(
    userMd5: string,
    startTime?: number,
    endTime?: number
  ): Promise<WechatMessage[]> {
    this.ensureChatTableMapping()
    const username = this.chatMd5ToUsername.get(userMd5)
    if (!username) return []
    if (startTime && endTime && startTime > endTime) return []

    // The async client merges cursor and shard-table results while applying the
    // time range in SQLite. Avoid loading the entire conversation when exporting
    // a narrow range; this is especially important for chats with long history.
    const rows = await this.wcdb4Client.getMessagesAsync(username, startTime, endTime)
    const messages = rows.map((message) => ({ ...message.raw, ...message }))
    console.log(
      `[WechatDb] export scan username=${username} raw=${rows.length} filtered=${messages.length} start=${startTime || 0} end=${endTime || 0}`
    )
    return mergeExportMessages(messages)
  }

  public async getUserVoiceMessageCountAsync(
    userMd5: string,
    startTime?: number,
    endTime?: number
  ): Promise<number | null> {
    this.ensureChatTableMapping()
    const username = this.chatMd5ToUsername.get(userMd5)
    if (!username) return 0
    return this.wcdb4Client.countVoiceMessagesAsync(username, startTime, endTime)
  }

  public searchAllMessages(keyword: string): string | null {
    const lowerKeyword = keyword.trim().toLowerCase()
    if (!lowerKeyword) return null
    for (const session of this.wcdb4Client.getSessions()) {
      const found = this.wcdb4Client
        .getMessages(session.username)
        .some((message) => message.msgContent.toLowerCase().includes(lowerKeyword))
      if (found) return `Chat_${this.md5(session.username)}`
    }
    return null
  }

  public md5(str: string): string {
    return this.wcdb4Client.md5(str)
  }
}
