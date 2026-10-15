export interface AgentGroupMemberStats {
  conversation: {
    id: string
    name: string
  }
  conversationId: string
  range: {
    start: string
    end: string
  }
  memberCount: number
  activeMemberCount: number
  silentMemberCount: number
  activeMembers: Array<{
    memberId: string
    displayName: string
    groupNickname: string
    messageCount: number
    lastMessageAt: string | null
  }>
  silentMembers: Array<{
    memberId: string
    displayName: string
    groupNickname: string
  }>
  freshness: 'fresh' | 'stale' | 'unknown'
  complete: boolean
  limitations: string[]
  unattributedMessages: number
  excludedSystemMessages: number
  firstMessageAt: string | null
}
