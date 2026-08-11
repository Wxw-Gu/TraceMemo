import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Contact, Message } from '../../../shared/types'
import {
  buildGroupReportInput,
  getSummaryDateRange,
  GROUP_REPORT_JSON_REPAIR_SYSTEM_PROMPT,
  GROUP_REPORT_SYSTEM_PROMPT,
  isInternalName,
  parseGroupDailyReport,
  SUMMARY_TYPE_OPTIONS,
  SummaryDateRange,
  SummaryMessageType
} from '../utils/group-report'
import { ReportTemplateId } from '../components/reports/ReportTemplateSelector'
import {
  transcribeVoiceMessages as transcribeReportVoiceMessages,
  type VoiceTranscriptionProgress
} from '../utils/voice-message-reference'
import type { VoiceModelStatus } from '../../../shared/voice-recognition'
import { resolveMemberName } from '../../../shared/member-names'

export type { VoiceTranscriptionProgress } from '../utils/voice-message-reference'

const REPORT_STEP_TIMEOUT_MS = 90_000
const REPORT_MODEL_TIMEOUT_BUFFER_MS = 10_000

export type ReportGenerationPhase =
  | 'idle'
  | 'loadingMessages'
  | 'transcribingVoice'
  | 'preparingInput'
  | 'requestingModel'
  | 'exportingReport'
  | 'success'
  | 'error'

export interface AiModelConfig {
  providerId?: string
  providerName: string
  model: string
  modelName: string
  configured: boolean
  status: 'untested' | 'connected' | 'error'
  timeoutMs?: number
}

export type ReportMemberNamePreference = 'groupNickname' | 'wechatNickname' | 'remark'

export interface ReportPaths {
  htmlPath: string
  pngPath: string
}

export interface ReportGenerationResult {
  imageDataUrl: string
  paths: ReportPaths
}

export interface ReportGenerationLog {
  label: string
  startedAt: string
  endedAt: string
  duration: number
}

export interface ReportGenerationMetadata {
  durationMs?: number
  modelName?: string
  tokenUsage?: {
    input?: number
    output?: number
    total?: number
    estimated?: boolean
  }
  generationLogs: ReportGenerationLog[]
}

interface UseGroupReportGenerationArgs {
  sourceContact: Contact | null
  summaryDateRange: SummaryDateRange
  summaryMessageTypes: SummaryMessageType[]
  modelConfig: AiModelConfig
}

export interface ReportTaskStep {
  id: Exclude<ReportGenerationPhase, 'idle' | 'success' | 'error'>
  label: string
}

export const REPORT_TASK_STEPS: ReportTaskStep[] = [
  { id: 'loadingMessages', label: '读取并筛选聊天记录' },
  { id: 'transcribingVoice', label: '转写语音消息' },
  { id: 'preparingInput', label: '整理日报输入' },
  { id: 'requestingModel', label: '调用模型生成内容' },
  { id: 'exportingReport', label: '导出 HTML 与 PNG' }
]

export interface RangeMessageState {
  status: 'idle' | 'loading' | 'success' | 'error'
  error: string
}

const withTimeout = async <T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = REPORT_STEP_TIMEOUT_MS
): Promise<T> => {
  let timer: number | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label} 超时`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) window.clearTimeout(timer)
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const writeReportLog = (
  level: 'info' | 'warn' | 'error',
  message: string,
  details?: Record<string, unknown>
): void => {
  void window.api
    .writeAppLog({ level, scope: 'group-report', message, details })
    .catch(() => undefined)
}

const jsonErrorContext = (raw: string, error: unknown): Record<string, unknown> => {
  const message = errorMessage(error)
  const position = Number(/\bposition\s+(\d+)/i.exec(message)?.[1])
  const safePosition = Number.isFinite(position) ? Math.max(0, Math.min(raw.length, position)) : 0
  return {
    error: message,
    outputLength: raw.length,
    position: Number.isFinite(position) ? position : undefined,
    context:
      raw.length && Number.isFinite(position)
        ? raw.slice(Math.max(0, safePosition - 300), Math.min(raw.length, safePosition + 300))
        : raw.slice(0, 600)
  }
}

const isGroupContact = (contact: Contact | null): boolean =>
  Boolean(contact?.type === 'group' || contact?.m_nsUsrName?.endsWith('@chatroom'))

const selectedMessageTypeSet = (types: SummaryMessageType[]): Set<string> =>
  new Set(
    SUMMARY_TYPE_OPTIONS.filter((option) => types.includes(option.value)).flatMap(
      (option) => option.messageTypes
    )
  )

const estimateTokenCount = (length: number): number => Math.max(1, Math.ceil(length / 1.6))

const estimateTokenUsage = (
  inputMessages: { role: string; content: string }[],
  output: string
): NonNullable<ReportGenerationMetadata['tokenUsage']> => {
  const inputLength = inputMessages.reduce((total, message) => total + message.content.length, 0)
  const outputLength = output.replace(/\s+/g, '').length
  const input = estimateTokenCount(inputLength)
  const outputCount = estimateTokenCount(outputLength)
  return {
    input,
    output: outputCount,
    total: input + outputCount,
    estimated: true
  }
}

const mergeTokenUsage = (
  first: NonNullable<ReportGenerationMetadata['tokenUsage']>,
  second: NonNullable<ReportGenerationMetadata['tokenUsage']>
): NonNullable<ReportGenerationMetadata['tokenUsage']> => ({
  input: (first.input || 0) + (second.input || 0),
  output: (first.output || 0) + (second.output || 0),
  total: (first.total || 0) + (second.total || 0),
  estimated: Boolean(first.estimated || second.estimated)
})

const applyGroupMemberNames = async (
  contact: Contact,
  messages: Message[],
  preference: ReportMemberNamePreference
): Promise<Message[]> => {
  let memberMap = new Map<
    string,
    {
      nickname: string
      groupNickname: string
      wechatNickname: string
      remark: string
      avatar: string
    }
  >()
  try {
    const snapshot = await withTimeout(window.api.getGroupSnapshot(contact.md5), '读取群成员')
    memberMap = new Map(
      (snapshot?.members || []).map((member) => [
        member.wxid,
        {
          nickname: member.nickname || member.wxid,
          groupNickname: member.groupNickname || '',
          wechatNickname: member.wechatNickname || '',
          remark: member.remark || '',
          avatar: member.avatar || ''
        }
      ])
    )
  } catch (error) {
    console.warn('[GroupReport] member snapshot failed:', error)
  }

  if (!memberMap.size) return messages
  return messages.map((message) => {
    const senderId = String(message.senderId || message.name || '')
    const member = memberMap.get(senderId)
    if (!member) return message
    const name = resolveMemberName({ ...member, wxid: senderId }, preference)
    return {
      ...message,
      name: !isInternalName(name) ? name : preference === 'remark' ? message.name : '',
      img: message.img || member.avatar
    }
  })
}

export function useGroupReportGeneration({
  sourceContact,
  summaryDateRange,
  summaryMessageTypes,
  modelConfig
}: UseGroupReportGenerationArgs): {
  phase: ReportGenerationPhase
  error: string
  rangeMessages: Message[]
  reportMessages: Message[]
  messageTypeCounts: Record<SummaryMessageType, number>
  rangeState: RangeMessageState
  voiceTranscriptionProgress: VoiceTranscriptionProgress | null
  generatedImage: string | null
  reportPaths: ReportPaths | null
  generationMetadata: ReportGenerationMetadata
  isGenerating: boolean
  generate: () => Promise<void>
  retry: () => Promise<void>
  resetGenerationStatus: () => void
  clearError: () => void
  closeResult: () => void
  copyImage: () => Promise<{ success: boolean; error?: string }>
  revealReport: () => Promise<{ success: boolean; error?: string }>
  templateId: ReportTemplateId
  setTemplateId: (value: ReportTemplateId) => void
  memberNamePreference: ReportMemberNamePreference
  setMemberNamePreference: (value: ReportMemberNamePreference) => void
  reportTimeoutSeconds: number
  setReportTimeoutSeconds: (value: number) => void
} {
  const [phase, setPhase] = useState<ReportGenerationPhase>('idle')
  const [error, setError] = useState('')
  const [rangeMessages, setRangeMessages] = useState<Message[]>([])
  const [rangeState, setRangeState] = useState<RangeMessageState>({ status: 'idle', error: '' })
  const [voiceTranscriptionProgress, setVoiceTranscriptionProgress] =
    useState<VoiceTranscriptionProgress | null>(null)
  const [generatedImage, setGeneratedImage] = useState<string | null>(null)
  const [reportPaths, setReportPaths] = useState<ReportPaths | null>(null)
  const [templateId, setTemplateId] = useState<ReportTemplateId>('v1')
  const [memberNamePreference, setMemberNamePreferenceState] = useState<ReportMemberNamePreference>(
    () => {
      const saved = localStorage.getItem('group_report_member_name_preference')
      return saved === 'wechatNickname' || saved === 'remark' ? saved : 'groupNickname'
    }
  )
  const [reportTimeoutSeconds, setReportTimeoutSecondsState] = useState<number>(() => {
    const saved = Number(localStorage.getItem('group_report_timeout_seconds'))
    return Number.isFinite(saved) && saved >= 30 ? saved : 300
  })
  const [generationMetadata, setGenerationMetadata] = useState<ReportGenerationMetadata>({
    generationLogs: []
  })
  const rangeRequestIdRef = useRef(0)

  const setMemberNamePreference = useCallback((value: ReportMemberNamePreference): void => {
    localStorage.setItem('group_report_member_name_preference', value)
    setMemberNamePreferenceState(value)
  }, [])
  const setReportTimeoutSeconds = useCallback((value: number): void => {
    const normalized = Math.max(30, Math.min(1800, Math.round(Number(value) || 300)))
    localStorage.setItem('group_report_timeout_seconds', String(normalized))
    setReportTimeoutSecondsState(normalized)
  }, [])

  const isGenerating =
    phase === 'loadingMessages' ||
    phase === 'transcribingVoice' ||
    phase === 'preparingInput' ||
    phase === 'requestingModel' ||
    phase === 'exportingReport'

  const loadRangeMessages = useCallback(
    async (markAsTaskPhase: boolean): Promise<Message[]> => {
      if (!sourceContact) return []
      const requestId = ++rangeRequestIdRef.current
      const { startTime, endTime } = getSummaryDateRange(summaryDateRange)
      setRangeState({ status: 'loading', error: '' })
      if (markAsTaskPhase) setPhase('loadingMessages')
      try {
        const messages = await withTimeout(
          window.api.getMessages(sourceContact.md5, startTime, endTime),
          '读取聊天记录'
        )
        if (requestId === rangeRequestIdRef.current) {
          setRangeMessages(messages)
          setRangeState({ status: 'success', error: '' })
        }
        return messages
      } catch (loadError) {
        const message = errorMessage(loadError)
        if (requestId === rangeRequestIdRef.current) {
          setRangeMessages([])
          setRangeState({ status: 'error', error: message })
        }
        throw loadError
      }
    },
    [sourceContact, summaryDateRange]
  )

  useEffect(() => {
    if (!sourceContact || !isGroupContact(sourceContact)) {
      rangeRequestIdRef.current += 1
      setRangeMessages([])
      setRangeState({ status: 'idle', error: '' })
      return
    }

    let active = true
    void loadRangeMessages(false).catch((loadError) => {
      if (!active) return
      console.warn('[GroupReport] range messages load failed:', loadError)
    })
    return () => {
      active = false
    }
  }, [sourceContact, summaryDateRange, loadRangeMessages])

  const allowedTypes = useMemo(
    () => selectedMessageTypeSet(summaryMessageTypes),
    [summaryMessageTypes]
  )

  const messageTypeCounts = useMemo(() => {
    const counts = Object.fromEntries(
      SUMMARY_TYPE_OPTIONS.map((option) => [option.value, 0])
    ) as Record<SummaryMessageType, number>
    for (const message of rangeMessages) {
      const option = SUMMARY_TYPE_OPTIONS.find((item) => item.messageTypes.includes(message.type))
      if (option) counts[option.value] += 1
    }
    return counts
  }, [rangeMessages])

  const reportMessages = useMemo(
    () => rangeMessages.filter((message) => allowedTypes.has(message.type)),
    [allowedTypes, rangeMessages]
  )

  const resetGenerationStatus = useCallback((): void => {
    setPhase('idle')
    setError('')
    setGeneratedImage(null)
    setReportPaths(null)
    setVoiceTranscriptionProgress(null)
    setGenerationMetadata({ generationLogs: [] })
  }, [])

  const transcribeSelectedVoiceMessages = useCallback(
    async (messages: Message[]): Promise<Message[]> => {
      setVoiceTranscriptionProgress(null)
      return transcribeReportVoiceMessages(messages, {
        getModelStatus: () =>
          withTimeout(
            window.api.getVoiceModelStatus(),
            '检查语音模型'
          ) as Promise<VoiceModelStatus>,
        getCachedTranscript: (reference) =>
          withTimeout(window.api.getVoiceTranscriptSnapshot(reference), '读取语音缓存'),
        recognize: (reference) => withTimeout(window.api.recognizeVoice(reference), '语音转写'),
        onProgress: setVoiceTranscriptionProgress
      })
    },
    []
  )

  const generate = useCallback(async (): Promise<void> => {
    if (isGenerating) return
    if (!sourceContact) {
      setPhase('error')
      setError('请先选择一个群聊')
      return
    }
    if (!isGroupContact(sourceContact)) {
      setPhase('error')
      setError('AI 群聊日报仅支持群聊')
      return
    }
    if (!modelConfig.configured) {
      setPhase('error')
      setError('尚未配置可用的默认 AI 模型')
      return
    }
    if (!summaryMessageTypes.length) {
      setPhase('error')
      setError('请至少选择一种消息类型')
      return
    }

    const startGenerateTime = Date.now()
    let failedAt = '初始化'
    const logs: ReportGenerationLog[] = []
    const pushLog = (log: ReportGenerationLog): void => {
      logs.push(log)
      setGenerationMetadata({
        modelName: modelConfig.model,
        generationLogs: [...logs]
      })
    }
    const createStepLog = (label: string, startedAt: Date, endedAt: Date): ReportGenerationLog => ({
      label,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      duration: endedAt.getTime() - startedAt.getTime()
    })
    const trackStep = async <T>(label: string, task: () => Promise<T>): Promise<T> => {
      const startedAt = new Date()
      try {
        return await task()
      } finally {
        pushLog(createStepLog(label, startedAt, new Date()))
      }
    }

    setError('')
    setGeneratedImage(null)
    setReportPaths(null)
    setGenerationMetadata({
      modelName: modelConfig.model,
      generationLogs: []
    })
    writeReportLog('info', '开始生成群聊日报', {
      groupName: sourceContact.m_nsNickName || sourceContact.m_nsUsrName,
      dateRange: summaryDateRange,
      selectedMessageTypes: summaryMessageTypes,
      providerName: modelConfig.providerName,
      model: modelConfig.model,
      templateId
    })

    try {
      failedAt = '读取聊天记录'
      const sourceMessages = await trackStep('读取聊天记录', () => loadRangeMessages(true))

      const selectedTypes = selectedMessageTypeSet(summaryMessageTypes)
      const filteredMessages = sourceMessages.filter((message) => selectedTypes.has(message.type))
      if (!filteredMessages.length) throw new Error('当前范围没有可总结消息')
      writeReportLog('info', '聊天记录读取完成', {
        sourceMessageCount: sourceMessages.length,
        filteredMessageCount: filteredMessages.length
      })

      setPhase(selectedTypes.has('语音') ? 'transcribingVoice' : 'preparingInput')
      failedAt = '整理日报输入'
      const input = await trackStep('整理输入', async () => {
        const messagesWithTranscripts = selectedTypes.has('语音')
          ? await transcribeSelectedVoiceMessages(filteredMessages)
          : filteredMessages
        setPhase('preparingInput')
        const namedReportMessages = await applyGroupMemberNames(
          sourceContact,
          messagesWithTranscripts,
          memberNamePreference
        )
        return buildGroupReportInput(namedReportMessages, sourceContact, true, 'full')
      })

      setPhase('requestingModel')
      failedAt = '调用模型生成内容'
      const aiMessages = [
        { role: 'system', content: GROUP_REPORT_SYSTEM_PROMPT },
        { role: 'user', content: input.prompt }
      ]
      const result = await trackStep('AI 生成', () =>
        withTimeout(
          window.api.aiChat(aiMessages, {
            providerId: modelConfig.providerId,
            modelId: modelConfig.model,
            timeoutMs: reportTimeoutSeconds * 1000
          }),
          'AI 生成日报',
          reportTimeoutSeconds * 1000 + REPORT_MODEL_TIMEOUT_BUFFER_MS
        )
      )
      if (!result.success || !result.data) throw new Error(result.error || 'AI 请求失败')
      writeReportLog('info', '模型响应完成', {
        outputLength: result.data.length,
        usage: result.usage
      })

      let tokenUsage =
        result.usage && result.usage.total
          ? result.usage
          : estimateTokenUsage(aiMessages, result.data)

      let report: ReturnType<typeof parseGroupDailyReport>
      try {
        report = parseGroupDailyReport(
          result.data,
          input.topSpeakers,
          input.activeTimeline,
          input.voiceLeaderboard || [],
          input.metadata,
          input.media
        )
      } catch (parseError) {
        writeReportLog('warn', '本地修复日报 JSON 失败，尝试由模型纠正', {
          ...jsonErrorContext(result.data, parseError),
          retry: 1
        })
        const repairMessages = [
          {
            role: 'system',
            content: GROUP_REPORT_JSON_REPAIR_SYSTEM_PROMPT
          },
          { role: 'user', content: result.data }
        ]
        const repairResult = await trackStep('AI 修复 JSON', () =>
          withTimeout(
            window.api.aiChat(repairMessages, {
              providerId: modelConfig.providerId,
              modelId: modelConfig.model,
              timeoutMs: reportTimeoutSeconds * 1000
            }),
            'AI 修复日报 JSON',
            reportTimeoutSeconds * 1000 + REPORT_MODEL_TIMEOUT_BUFFER_MS
          )
        )
        if (!repairResult.success || !repairResult.data) {
          throw new Error(repairResult.error || 'AI 修复日报 JSON 失败', { cause: parseError })
        }
        const repairUsage =
          repairResult.usage && repairResult.usage.total
            ? repairResult.usage
            : estimateTokenUsage(repairMessages, repairResult.data)
        tokenUsage = mergeTokenUsage(tokenUsage, repairUsage)
        try {
          report = parseGroupDailyReport(
            repairResult.data,
            input.topSpeakers,
            input.activeTimeline,
            input.voiceLeaderboard || [],
            input.metadata,
            input.media
          )
          writeReportLog('info', '模型已纠正日报 JSON', {
            retry: 1,
            outputLength: repairResult.data.length
          })
        } catch (retryParseError) {
          writeReportLog(
            'error',
            '日报 JSON 重试后仍解析失败',
            jsonErrorContext(repairResult.data, retryParseError)
          )
          throw retryParseError
        }
      }

      setPhase('exportingReport')
      failedAt = '导出 HTML 与 PNG'
      const exported = await withTimeout(
        window.api.exportGroupReport({ report, metadata: input.metadata, templateId }),
        '日报图片导出'
      )
      if (!exported.success || !exported.imageDataUrl || !exported.htmlPath || !exported.pngPath) {
        throw new Error(exported.error || '日报文件生成失败')
      }
      if (exported.exportTimings?.html) {
        pushLog({
          label: 'HTML 导出',
          ...exported.exportTimings.html
        })
      }
      if (exported.exportTimings?.png) {
        pushLog({
          label: 'PNG 导出',
          ...exported.exportTimings.png
        })
      }
      const exportFinishedAt =
        exported.exportTimings?.png?.endedAt || exported.exportTimings?.html?.endedAt
      const exportFinishTime = exportFinishedAt ? Date.parse(exportFinishedAt) : Date.now()

      setGeneratedImage(exported.imageDataUrl)
      setReportPaths({ htmlPath: exported.htmlPath, pngPath: exported.pngPath })
      setGenerationMetadata({
        durationMs:
          Number.isFinite(exportFinishTime) && exportFinishTime > startGenerateTime
            ? exportFinishTime - startGenerateTime
            : Date.now() - startGenerateTime,
        modelName: modelConfig.model,
        tokenUsage,
        generationLogs: [...logs]
      })
      setPhase('success')
      writeReportLog('info', '群聊日报生成成功', {
        durationMs: Date.now() - startGenerateTime,
        htmlPath: exported.htmlPath,
        pngPath: exported.pngPath
      })
    } catch (generateError) {
      const message = errorMessage(generateError)
      writeReportLog('error', '群聊日报生成失败', {
        error: message,
        failedAt,
        durationMs: Date.now() - startGenerateTime
      })
      setError(message)
      setPhase('error')
    }
  }, [
    isGenerating,
    loadRangeMessages,
    memberNamePreference,
    modelConfig,
    reportTimeoutSeconds,
    sourceContact,
    summaryDateRange,
    summaryMessageTypes,
    templateId,
    transcribeSelectedVoiceMessages
  ])

  const clearError = useCallback((): void => {
    setError('')
    setPhase('idle')
  }, [])

  const closeResult = useCallback((): void => {
    setGeneratedImage(null)
  }, [])

  const copyImage = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    if (!generatedImage) return { success: false, error: '没有可复制的日报图片' }
    return window.api.copyImage(generatedImage)
  }, [generatedImage])

  const revealReport = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    if (!reportPaths) return { success: false, error: '没有可显示的日报文件' }
    return window.api.revealGroupReport(reportPaths.pngPath)
  }, [reportPaths])

  return {
    phase,
    error,
    rangeMessages,
    reportMessages,
    messageTypeCounts,
    rangeState,
    voiceTranscriptionProgress,
    generatedImage,
    reportPaths,
    generationMetadata,
    isGenerating,
    generate,
    retry: generate,
    resetGenerationStatus,
    clearError,
    closeResult,
    copyImage,
    revealReport,
    templateId,
    setTemplateId,
    memberNamePreference,
    setMemberNamePreference,
    reportTimeoutSeconds,
    setReportTimeoutSeconds
  }
}
