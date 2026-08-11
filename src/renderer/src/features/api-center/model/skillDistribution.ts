export type AgentInstallTarget = 'codex' | 'claude-code' | 'openclaw' | 'generic'

export type SkillInstallSource =
  | { type: 'local'; directoryPath: string; skillPath: string; version: string }
  | { type: 'remote'; installUrl: string; version: string }

export const AGENT_INSTALL_TARGETS: { value: AgentInstallTarget; label: string }[] = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'generic', label: '其他 Agent' }
]

export const githubLatestUrl =
  'https://github.com/Wxw-Gu/WechatExplorer/tree/main/docs/skill/tracememo-reader'

export const githubVersionedInstallUrl: string | null = null
