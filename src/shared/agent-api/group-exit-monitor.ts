export interface AgentGroupExitMonitorState {
  enabled: boolean
  running: boolean
  nativeMonitorActive: boolean
  monitoredConversationIds: string[]
  monitoredGroupCount: number
  monitorSelectionConfigured: boolean
  lastCheckedAt: string | null
  lastReadAt: string | null
  eventCount: number
  unreadCount: number
}

export interface AgentGroupExitMonitorEvent {
  eventId: string
  conversationId: string
  groupName: string
  memberId: string
  memberName: string
  wechatName: string
  groupRemark: string
  contactRemark: string
  previousCount: number
  currentCount: number
  delta: number
  message: string
  detectedAt: string
}
