import type { Contact, Message } from '../../shared/types'
import { exportGroupReport } from '../group-report-service'
import { getGroupSnapshot, listMessages, resolveMd5 } from './chat-service'
import { AIProviderService } from './ai-provider-service'
import type {
  ScheduledReportMemberNameMode,
  ScheduledReportMessageType
} from '../../shared/scheduled-report'
import type { SelectableReportTemplateId } from '../../shared/report-templates'
import { resolveMemberName } from '../../shared/member-names'
import {
  buildGroupReportInput,
  getSummaryDateRange,
  GROUP_REPORT_JSON_REPAIR_SYSTEM_PROMPT,
  GROUP_REPORT_SYSTEM_PROMPT,
  isInternalName,
  parseGroupDailyReport,
  type SummaryDateRange
} from '../../renderer/src/utils/group-report'

const aiProvider = new AIProviderService()

export interface AgentGroupReportRequest {
  group: string
  range?: SummaryDateRange | 'recent24h'
  messageTypes?: ScheduledReportMessageType[]
  templateId?: SelectableReportTemplateId
  memberNameMode?: ScheduledReportMemberNameMode
  timeoutSeconds?: number
}

export interface AgentGroupReportResult {
  success: boolean
  groupName?: string
  pngPath?: string
  messageCount?: number
  error?: string
}

export async function generateAgentGroupReport(
  request: AgentGroupReportRequest
): Promise<AgentGroupReportResult> {
  const query = String(request.group || '')
    .trim()
    .replace(/群聊?$/, '')
    .trim()
  if (!query) return { success: false, error: '缺少群聊名称' }
  const contact = resolveMd5(query)
  if (!contact) return { success: false, error: `没有找到群聊“${query}”` }
  if (contact.type !== 'group' && !contact.m_nsUsrName.endsWith('@chatroom')) {
    return { success: false, error: `“${query}”不是群聊` }
  }

  const range = request.range === 'yesterday' || request.range === '7days' ? request.range : 'today'
  const { startTime, endTime } =
    request.range === 'recent24h'
      ? { startTime: Math.floor(Date.now() / 1000) - 86400, endTime: Math.floor(Date.now() / 1000) }
      : getSummaryDateRange(range)
  let messages = listMessages(contact.md5, startTime, endTime) as Message[]
  if (!messages.length) return { success: false, error: '所选时间范围没有可总结的消息' }

  const messageTypeMap: Record<ScheduledReportMessageType, string[]> = {
    text: ['普通文本'],
    image: ['图片'],
    sticker: ['表情包'],
    video: ['视频'],
    voice: ['语音'],
    share: ['分享消息', '名片', '位置', '通话'],
    system: ['系统消息']
  }
  const selectedTypes = new Set(
    (request.messageTypes?.length
      ? request.messageTypes
      : (Object.keys(messageTypeMap) as ScheduledReportMessageType[])
    ).flatMap((type) => messageTypeMap[type] || [])
  )
  messages = messages.filter((message) => selectedTypes.has(message.type))
  if (!messages.length) return { success: false, error: '所选时间范围没有可总结的消息' }

  const snapshot = getGroupSnapshot(contact.md5)
  if (snapshot) {
    const members = new Map(
      snapshot.members.map((member) => [
        member.wxid,
        {
          name: resolveMemberName(member, request.memberNameMode || 'groupNickname'),
          avatar: member.avatar
        }
      ])
    )
    messages = messages.map((message) => {
      if (!isInternalName(message.name)) return message
      const member = members.get(String(message.senderId || message.name || ''))
      return member?.name
        ? { ...message, name: member.name, img: message.img || member.avatar }
        : message
    })
  }

  const input = await buildGroupReportInput(messages, contact as Contact, true, 'full')
  const ai = await aiProvider.chat(
    [
      { role: 'system', content: GROUP_REPORT_SYSTEM_PROMPT },
      { role: 'user', content: input.prompt }
    ],
    { timeoutMs: Math.max(30, Math.min(1800, request.timeoutSeconds || 300)) * 1000 }
  )
  if (!ai.success || !ai.data) return { success: false, error: ai.error || 'AI 总结失败' }
  const parseReport = (raw: string): ReturnType<typeof parseGroupDailyReport> =>
    parseGroupDailyReport(
      raw,
      input.topSpeakers,
      input.activeTimeline,
      input.voiceLeaderboard,
      input.metadata,
      input.media
    )
  let report: ReturnType<typeof parseGroupDailyReport>
  try {
    report = parseReport(ai.data)
  } catch (parseError) {
    const repaired = await aiProvider.chat(
      [
        { role: 'system', content: GROUP_REPORT_JSON_REPAIR_SYSTEM_PROMPT },
        { role: 'user', content: ai.data }
      ],
      { timeoutMs: Math.max(30, Math.min(1800, request.timeoutSeconds || 300)) * 1000 }
    )
    if (!repaired.success || !repaired.data) {
      const cause = parseError instanceof Error ? parseError.message : String(parseError)
      return {
        success: false,
        error: `${repaired.error || 'AI 修复日报 JSON 失败'}（原始错误：${cause}）`
      }
    }
    try {
      report = parseReport(repaired.data)
    } catch (repairError) {
      return {
        success: false,
        error: repairError instanceof Error ? repairError.message : String(repairError)
      }
    }
  }
  const exported = await exportGroupReport({
    report,
    metadata: input.metadata,
    templateId: request.templateId
  })
  if (!exported.success || !exported.pngPath) {
    return { success: false, error: exported.error || '总结图片生成失败' }
  }
  return {
    success: true,
    groupName: input.metadata.groupName,
    pngPath: exported.pngPath,
    messageCount: messages.length
  }
}
