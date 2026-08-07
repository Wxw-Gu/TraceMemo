import { useCallback, useEffect, useReducer } from 'react'
import type { Contact } from '../../../../../shared/types'
import { findEndpoint } from '../model/apiEndpoints'
import {
  AGENT_GROUP_REPORT_PRESET,
  AGENT_SEND_PRESET,
  REPORT_REQUEST_PRESET
} from '../model/requestPresets'
import { type AgentInstallTarget, type SkillInstallSource } from '../model/skillDistribution'
import type {
  ApiResponse,
  ApiServiceState,
  ApiSettings,
  ApiTokenStatus,
  RequestHistoryItem,
  SkillStatus
} from '../model/types'
import { sendLocalApiRequest } from '../services/localApiClient'
import {
  buildSkillInstallInstruction,
  buildSkillVerificationPrompt
} from '../utils/buildSkillInstallInstruction'
import { confirmApiTokenRotation } from '../utils/confirmApiTokenRotation'

type RequestState = 'idle' | 'loading' | 'success' | 'error'

interface State {
  settings: ApiSettings | null
  service: ApiServiceState | null
  tokenStatus: ApiTokenStatus | null
  revealedToken: string
  skill: SkillStatus | null
  endpointId: string
  params: Record<string, string>
  body: string
  requestState: RequestState
  response: ApiResponse | null
  history: RequestHistoryItem[]
  error: string
  rawMarkdown: string | null
  toast: string
  installTarget: AgentInstallTarget
}

type Action =
  | {
      type: 'loaded'
      settings: ApiSettings
      service: ApiServiceState
      skill: SkillStatus
      tokenStatus: ApiTokenStatus
    }
  | { type: 'endpoint'; endpointId: string; talker?: string }
  | { type: 'params'; params: Record<string, string> }
  | { type: 'body'; body: string }
  | { type: 'requesting' }
  | { type: 'response'; response: ApiResponse; history: RequestHistoryItem[] }
  | { type: 'error'; error: string }
  | { type: 'markdown'; content: string | null }
  | { type: 'toast'; message: string }
  | { type: 'installTarget'; target: AgentInstallTarget }
  | { type: 'tokenRevealed'; token: string }
  | { type: 'tokenHidden' }
  | { type: 'tokenStatus'; status: ApiTokenStatus }

const initialState: State = {
  settings: null,
  service: null,
  tokenStatus: null,
  revealedToken: '',
  skill: null,
  endpointId: 'health',
  params: {},
  body: REPORT_REQUEST_PRESET,
  requestState: 'idle',
  response: null,
  history: [],
  error: '',
  rawMarkdown: null,
  toast: '',
  installTarget: 'codex'
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'loaded':
      return {
        ...state,
        settings: action.settings,
        service: action.service,
        skill: action.skill,
        tokenStatus: action.tokenStatus
      }
    case 'endpoint': {
      const preset =
        action.endpointId === 'report'
          ? REPORT_REQUEST_PRESET
          : action.endpointId === 'agent-group-report'
            ? AGENT_GROUP_REPORT_PRESET
            : action.endpointId === 'agent-send'
              ? AGENT_SEND_PRESET
              : state.body
      return {
        ...state,
        endpointId: action.endpointId,
        params: action.talker && action.endpointId === 'chatlog' ? { talker: action.talker } : {},
        body: preset,
        error: ''
      }
    }
    case 'params':
      return { ...state, params: action.params }
    case 'body':
      return { ...state, body: action.body }
    case 'requesting':
      return { ...state, requestState: 'loading', error: '' }
    case 'response':
      return {
        ...state,
        requestState: 'success',
        response: action.response,
        history: action.history
      }
    case 'error':
      return { ...state, requestState: 'error', error: action.error }
    case 'markdown':
      return { ...state, rawMarkdown: action.content }
    case 'toast':
      return { ...state, toast: action.message }
    case 'installTarget':
      return { ...state, installTarget: action.target }
    case 'tokenRevealed':
      return { ...state, revealedToken: action.token }
    case 'tokenHidden':
      return { ...state, revealedToken: '' }
    case 'tokenStatus':
      return { ...state, tokenStatus: action.status, revealedToken: '' }
  }
}

export function useApiCenterController(selectedContact: Contact | null): {
  state: State
  endpoint: ReturnType<typeof findEndpoint>
  refresh: () => Promise<void>
  selectEndpoint: (endpointId: string) => void
  updateParams: (params: Record<string, string>) => void
  updateBody: (body: string) => void
  runRequest: () => Promise<void>
  controlService: (action: 'start' | 'stop' | 'restart') => Promise<void>
  showMarkdown: () => Promise<void>
  reportError: (error: string) => void
  showToast: (message: string) => void
  copyText: (text: string, successMessage: string) => Promise<void>
  copyCurl: () => Promise<void>
  revealToken: () => Promise<void>
  hideToken: () => void
  copyToken: () => Promise<void>
  rotateToken: () => Promise<void>
  setInstallTarget: (target: AgentInstallTarget) => void
  copyInstallInstruction: () => Promise<void>
  copyVerificationPrompt: () => Promise<void>
  openSkillDirectory: () => Promise<void>
  openSkillGithub: () => Promise<void>
  closeMarkdown: () => void
} {
  const [state, dispatch] = useReducer(reducer, initialState)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [{ settings }, service, skill, tokenStatus] = await Promise.all([
        window.api.getSettings(),
        window.api.apiStatus(),
        window.api.getReaderSkillStatus(),
        window.api.apiTokenStatus()
      ])
      dispatch({ type: 'loaded', settings, service, skill, tokenStatus })
    } catch (error) {
      dispatch({
        type: 'error',
        error: error instanceof Error ? error.message : '无法读取 API 服务状态'
      })
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 4000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const selectEndpoint = useCallback(
    (endpointId: string): void => {
      const defaults: Record<string, string> = endpointId === 'recent-chat' ? { limit: '50' } : {}
      dispatch({ type: 'endpoint', endpointId, talker: selectedContact?.m_nsUsrName })
      if (endpointId !== 'chatlog') dispatch({ type: 'params', params: defaults })
      window.setTimeout(
        () =>
          document
            .getElementById('api-request-tester')
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
        0
      )
    },
    [selectedContact]
  )

  const updateParams = useCallback(
    (params: Record<string, string>) => dispatch({ type: 'params', params }),
    []
  )
  const updateBody = useCallback((body: string) => dispatch({ type: 'body', body }), [])

  const runRequest = useCallback(async (): Promise<void> => {
    const endpoint = findEndpoint(state.endpointId)
    if (!state.service?.running || !state.settings) {
      dispatch({ type: 'error', error: '请先启动本地 API 服务' })
      return
    }
    const required = endpoint.parameters?.find(
      (parameter) => parameter.required && !state.params[parameter.key]?.trim()
    )
    if (required) {
      dispatch({ type: 'error', error: `请填写必要参数：${required.label}` })
      return
    }
    if (endpoint.body) {
      try {
        JSON.parse(state.body)
      } catch {
        dispatch({ type: 'error', error: '请求体不是有效 JSON，未发送请求。' })
        return
      }
    }
    dispatch({ type: 'requesting' })
    try {
      const response = await sendLocalApiRequest(endpoint, state.params, state.body)
      if ('error' in response) {
        dispatch({ type: 'error', error: response.error })
        return
      }
      const item: RequestHistoryItem = {
        id: `${Date.now()}-${Math.random()}`,
        timestamp: Date.now(),
        method: endpoint.method,
        path: endpoint.path,
        status: response.status,
        durationMs: response.durationMs,
        responseSize: response.responseSize,
        success: response.status >= 200 && response.status < 300
      }
      dispatch({ type: 'response', response, history: [item, ...state.history].slice(0, 30) })
    } catch (error) {
      dispatch({ type: 'error', error: error instanceof Error ? error.message : '请求失败' })
    }
  }, [
    state.body,
    state.endpointId,
    state.history,
    state.params,
    state.service?.running,
    state.settings
  ])

  const controlService = useCallback(
    async (action: 'start' | 'stop' | 'restart'): Promise<void> => {
      try {
        const settings = state.settings
        if (!settings) return
        if (action === 'stop') await window.api.apiToggle(false)
        if (action === 'start') await window.api.apiToggle(true)
        if (action === 'restart') {
          await window.api.apiStop()
          await window.api.apiStart(settings.apiHost, settings.apiPort)
        }
        await refresh()
      } catch (error) {
        dispatch({ type: 'error', error: error instanceof Error ? error.message : '服务操作失败' })
      }
    },
    [refresh, state.settings]
  )

  const showMarkdown = useCallback(async (): Promise<void> => {
    const result = await window.api.readReaderSkill()
    if (result.success && result.content) dispatch({ type: 'markdown', content: result.content })
    else dispatch({ type: 'error', error: result.error || '无法读取 Skill 文件' })
  }, [])

  const reportError = useCallback((error: string) => dispatch({ type: 'error', error }), [])
  const showToast = useCallback((message: string): void => {
    dispatch({ type: 'toast', message })
    window.setTimeout(() => dispatch({ type: 'toast', message: '' }), 2000)
  }, [])
  const copyText = useCallback(
    async (text: string, successMessage: string): Promise<void> => {
      const result = await window.api.copyText(text)
      showToast(result.success ? successMessage : '复制失败，请重试')
    },
    [showToast]
  )
  const revealToken = useCallback(async (): Promise<void> => {
    const result = await window.api.revealApiToken()
    if (result.token) dispatch({ type: 'tokenRevealed', token: result.token })
    else dispatch({ type: 'error', error: result.error || '无法读取 API Token' })
  }, [])
  const hideToken = useCallback((): void => dispatch({ type: 'tokenHidden' }), [])
  const copyToken = useCallback(async (): Promise<void> => {
    const result = await window.api.copyApiToken()
    showToast(result.success ? 'Token 已复制' : result.error || 'Token 复制失败')
  }, [showToast])
  const rotateToken = useCallback(async (): Promise<void> => {
    if (!confirmApiTokenRotation()) return
    const result = await window.api.rotateApiToken()
    dispatch({ type: 'tokenStatus', status: result })
    showToast(result.success ? 'Token 已重新生成' : result.error || 'Token 重新生成失败')
  }, [showToast])
  const copyCurl = useCallback(async (): Promise<void> => {
    const endpoint = findEndpoint(state.endpointId)
    const result = await window.api.copyLocalApiCurl({
      endpointId: endpoint.id,
      query: state.params,
      body: state.body
    })
    showToast(result.success ? 'curl 命令已复制' : result.error || 'curl 命令复制失败')
  }, [showToast, state.body, state.endpointId, state.params])
  const setInstallTarget = useCallback(
    (target: AgentInstallTarget): void => dispatch({ type: 'installTarget', target }),
    []
  )
  const copyInstallInstruction = useCallback(async (): Promise<void> => {
    const skill = state.skill
    const service = state.service
    if (!skill?.available || !skill.directoryPath || !service?.running)
      return showToast('请先确认本地 API 与 Skill 均可用')
    const source: SkillInstallSource = {
      type: 'local',
      directoryPath: skill.directoryPath,
      skillPath: skill.filePath || '',
      version: skill.version || 'v1.0'
    }
    const instruction = buildSkillInstallInstruction({
      target: state.installTarget,
      source,
      apiBaseUrl: { host: service.host, port: service.port }
    })
    const labels: Record<AgentInstallTarget, string> = {
      codex: 'Codex 安装指令已复制',
      'claude-code': 'Claude Code 安装指令已复制',
      openclaw: 'OpenClaw 安装指令已复制',
      generic: '通用安装指令已复制'
    }
    await copyText(instruction, labels[state.installTarget])
  }, [copyText, showToast, state.installTarget, state.service, state.skill])
  const copyVerificationPrompt = useCallback(async (): Promise<void> => {
    await copyText(buildSkillVerificationPrompt(), '测试问题已复制')
  }, [copyText])
  const openSkillDirectory = useCallback(async (): Promise<void> => {
    const result = await window.api.revealReaderSkill()
    showToast(result.success ? '已打开 Skill 文件夹' : result.error || '打开 Skill 文件夹失败')
  }, [showToast])
  const openSkillGithub = useCallback(async (): Promise<void> => {
    const result = await window.api.openReaderSkillGithub()
    showToast(result.success ? '已在浏览器中打开 GitHub' : '无法打开浏览器，请复制链接后手动访问')
  }, [showToast])

  return {
    state,
    endpoint: findEndpoint(state.endpointId),
    refresh,
    selectEndpoint,
    updateParams,
    updateBody,
    runRequest,
    controlService,
    showMarkdown,
    reportError,
    showToast,
    copyText,
    copyCurl,
    revealToken,
    hideToken,
    copyToken,
    rotateToken,
    setInstallTarget,
    copyInstallInstruction,
    copyVerificationPrompt,
    openSkillDirectory,
    openSkillGithub,
    closeMarkdown: () => dispatch({ type: 'markdown', content: null })
  }
}
