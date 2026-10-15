import type { AutomationExecution, AutomationRuleType } from '../automation'

export interface AgentApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
  requestId: string
}

export interface CapabilityAvailability {
  supported: boolean
  available: boolean
  reason?: string
  operations?: string[]
}

export interface ApplicationCapabilities {
  version: string
  apiVersion: 'v1'
  database: { ready: boolean }
  query: CapabilityAvailability
  automations: CapabilityAvailability & {
    ruleTypes: AutomationRuleType[]
    operations: string[]
  }
  groupExitMonitor: CapabilityAvailability
  groupStats: CapabilityAvailability
  wechat: {
    personal: CapabilityAvailability & {
      status: string
      content: { text: boolean; image: boolean; voice: boolean }
    }
    ilink: CapabilityAvailability & { status: string }
  }
}

export interface AgentAutomationValidationIssue {
  path: string
  code: string
  message: string
  details?: unknown
}

export interface AgentAutomationValidationResult {
  valid: boolean
  issues: AgentAutomationValidationIssue[]
  normalized?: unknown
  effects?: Record<string, unknown>
  nextRunAt?: string | null
  capabilities?: Record<string, unknown>
}

export interface AgentAutomationExecution extends Pick<
  AutomationExecution,
  | 'executionId'
  | 'ruleId'
  | 'ruleName'
  | 'trigger'
  | 'status'
  | 'triggerTime'
  | 'durationMs'
  | 'sourceDisplayName'
> {
  ruleType?: AutomationRuleType
  startedAt: string
  finishedAt: string | null
  error?: string
}
