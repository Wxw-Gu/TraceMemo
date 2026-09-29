import { randomUUID } from 'crypto'
import type { Contact, Message } from '../../shared/types'
import type { GroupDailyReport, GroupReportMetadata } from '../../shared/group-report'
import { exportGroupReport } from '../group-report-service'
import { getGroupSnapshot, listMessages, resolveMd5 } from './chat-service'
import { AIProviderService } from './ai-provider-service'
import type {
  ScheduledReportMemberNameMode,
  ScheduledReportMessageType
} from '../../shared/scheduled-report'
import type { ScheduledReportExecutionStage } from '../../shared/scheduled-report'
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

/**
 * 用真实群成员快照补全消息的显示名与头像。
 *
 * **头像与名称的门槛刻意不同**：
 *
 * 此前这里先用 `isInternalName(message.name)` 做整体早退 —— 只有当消息里的名字还是内部标识
 * （空 / `wxid_*` / `*@chatroom` / 18+ 位字母数字）时才继续。但 `listMessages` 产出的 `name`
 * 优先取 `senderNickname`，在真实群里通常是**已可读的昵称**，于是整条记录被跳过、
 * `member.avatar` 永远补不上，导出层只能退化成首字头像；软件内日报没有这个门槛，
 * 所以它能显示真实头像。
 *
 * 现在：**只要 senderId 命中真实群成员就允许补头像**；名称只在解析结果确实是可读名时才采用，
 * 避免把调用方已有的昵称降级成空串或内部标识。消息自带的 `img` 始终优先。
 */
export function hydrateGroupMemberIdentity(
  messages: Message[],
  members: ReadonlyArray<NonNullable<ReturnType<typeof getGroupSnapshot>>['members'][number]>,
  memberNameMode: ScheduledReportMemberNameMode
): Message[] {
  const index = new Map(
    members.map((member) => [
      member.wxid,
      { name: resolveMemberName(member, memberNameMode), avatar: member.avatar }
    ])
  )
  return messages.map((message) => {
    const member = index.get(String(message.senderId || message.name || ''))
    if (!member) return message
    const shouldFillAvatar = !message.img && Boolean(member.avatar)
    const resolvedName = member.name && !isInternalName(member.name) ? member.name : message.name
    if (!shouldFillAvatar && resolvedName === message.name) return message
    return {
      ...message,
      name: resolvedName,
      ...(shouldFillAvatar ? { img: member.avatar } : {})
    }
  })
}

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
  htmlPath?: string
  pngPath?: string
  messageCount?: number
  reportSnapshot?: GroupDailyReport
  reportMetadata?: GroupReportMetadata
  modelName?: string
  tokenUsage?: {
    input?: number
    output?: number
    total?: number
    estimated?: boolean
  }
  duration?: number
  error?: string
  errorCode?: string
  errorStage?: ScheduledReportExecutionStage
  errorStatus?: number
  errorType?: string
}

export async function generateAgentGroupReport(
  request: AgentGroupReportRequest
): Promise<AgentGroupReportResult> {
  const startedAt = Date.now()
  const query = String(request.group || '')
    .trim()
    .replace(/群聊?$/, '')
    .trim()
  if (!query) return reportFailure('缺少群聊名称', 'data', 'CHAT_NOT_FOUND')
  const contact = resolveMd5(query)
  if (!contact) return reportFailure(`没有找到群聊“${query}”`, 'data', 'CHAT_NOT_FOUND')
  if (contact.type !== 'group' && !contact.m_nsUsrName.endsWith('@chatroom')) {
    return reportFailure(`“${query}”不是群聊`, 'data', 'CHAT_NOT_FOUND')
  }

  const range = request.range === 'yesterday' || request.range === '7days' ? request.range : 'today'
  const { startTime, endTime } =
    request.range === 'recent24h'
      ? (() => {
          const now = Math.floor(Date.now() / 1000)
          return { startTime: now - 86400, endTime: now }
        })()
      : getSummaryDateRange(range)
  let messages = listMessages(contact.md5, startTime, endTime) as Message[]
  if (!messages.length) return reportFailure('所选时间范围没有可总结的消息', 'data', 'NO_MESSAGES')

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
  if (!messages.length) return reportFailure('所选时间范围没有可总结的消息', 'data', 'NO_MESSAGES')

  const snapshot = getGroupSnapshot(contact.md5)
  if (snapshot) {
    messages = hydrateGroupMemberIdentity(
      messages,
      snapshot.members,
      request.memberNameMode || 'groupNickname'
    )
  }

  const input = await buildGroupReportInput(messages, contact as Contact, true, 'full')
  const runtime = aiProvider.getRuntimeConfig()
  const sessionId = randomUUID()
  const ai = await aiProvider.chat(
    [
      { role: 'system', content: GROUP_REPORT_SYSTEM_PROMPT },
      { role: 'user', content: input.prompt }
    ],
    { sessionId, timeoutMs: Math.max(30, Math.min(1800, request.timeoutSeconds || 300)) * 1000 }
  )
  if (!ai.success || !ai.data) {
    return {
      ...reportFailure(ai.error || 'AI 总结失败', 'ai', ai.errorCode),
      ...(ai.errorStatus !== undefined ? { errorStatus: ai.errorStatus } : {}),
      ...(ai.errorType ? { errorType: ai.errorType } : {})
    }
  }
  let tokenUsage = ai.usage
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
      { sessionId, timeoutMs: Math.max(30, Math.min(1800, request.timeoutSeconds || 300)) * 1000 }
    )
    if (!repaired.success || !repaired.data) {
      const cause = parseError instanceof Error ? parseError.message : String(parseError)
      return {
        ...reportFailure(
          `${repaired.error || 'AI 修复日报 JSON 失败'}（原始错误：${cause}）`,
          'ai',
          repaired.errorCode
        ),
        ...(repaired.errorStatus !== undefined ? { errorStatus: repaired.errorStatus } : {}),
        ...(repaired.errorType ? { errorType: repaired.errorType } : {})
      }
    }
    tokenUsage = mergeTokenUsage(tokenUsage, repaired.usage)
    try {
      report = parseReport(repaired.data)
    } catch (repairError) {
      return reportFailure(
        repairError instanceof Error ? repairError.message : String(repairError),
        'report',
        'REPORT_GENERATION_FAILED'
      )
    }
  }
  const exported = await exportGroupReport({
    report,
    metadata: input.metadata,
    templateId: request.templateId
  })
  if (!exported.success || !exported.pngPath) {
    return reportFailure(exported.error || '总结图片生成失败', 'report', 'REPORT_GENERATION_FAILED')
  }
  return {
    success: true,
    groupName: input.metadata.groupName,
    htmlPath: exported.htmlPath,
    pngPath: exported.pngPath,
    messageCount: messages.length,
    reportSnapshot: report,
    reportMetadata: input.metadata,
    modelName: runtime.modelName || runtime.model,
    tokenUsage,
    duration: Date.now() - startedAt
  }
}

function mergeTokenUsage(
  first: AgentGroupReportResult['tokenUsage'],
  second: AgentGroupReportResult['tokenUsage']
): AgentGroupReportResult['tokenUsage'] {
  if (!first) return second
  if (!second) return first
  return {
    input: (first.input || 0) + (second.input || 0),
    output: (first.output || 0) + (second.output || 0),
    total: (first.total || 0) + (second.total || 0),
    estimated: Boolean(first.estimated || second.estimated)
  }
}

function reportFailure(
  error: string,
  errorStage: ScheduledReportExecutionStage,
  errorCode?: string
): AgentGroupReportResult {
  return {
    success: false,
    error,
    errorStage,
    ...(errorCode ? { errorCode } : {})
  }
}
