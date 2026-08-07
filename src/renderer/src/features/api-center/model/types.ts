export type ApiMethod = 'GET' | 'POST'
export type { ApiTokenStatus } from '../../../../../shared/local-api-auth'

export interface ApiParameter {
  key: string
  label: string
  required?: boolean
  placeholder?: string
}

export interface ApiEndpoint {
  id: LocalApiEndpointId
  method: ApiMethod
  path: string
  name: string
  description: string
  parameters?: ApiParameter[]
  body?: boolean
}

export interface ApiServiceState {
  running: boolean
  host: string
  port: number
  error?: string
}

export interface ApiSettings {
  apiEnabled: boolean
  apiHost: string
  apiPort: number
}

export interface ApiResponse {
  endpoint: ApiEndpoint
  status: number
  durationMs: number
  responseSize: number
  text: string
  data: unknown
}

export interface RequestHistoryItem {
  id: string
  timestamp: number
  method: ApiMethod
  path: string
  status: number
  durationMs: number
  responseSize: number
  success: boolean
}

export interface SkillStatus {
  available: boolean
  version?: string
  filePath?: string
  directoryPath?: string
  source: 'development' | 'bundled'
  githubUrl: string
  error?: string
}
import type { LocalApiEndpointId } from '../../../../../shared/local-api-test'
