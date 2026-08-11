import type { AgentInstallTarget, SkillInstallSource } from '../model/skillDistribution'

function requestHost(host: string): string {
  return host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host
}

function opening(target: AgentInstallTarget): string {
  switch (target) {
    case 'codex':
      return '请将本地目录中的 TraceMemo Reader Skill 安装到当前 Codex 项目或用户 Skill 目录：'
    case 'claude-code':
      return '请安装以下本地 TraceMemo Reader Skill，并按照 SKILL.md 调用本地 HTTP API：'
    case 'openclaw':
      return '请将以下本地目录作为 TraceMemo Reader Skill 安装，并阅读其中的 SKILL.md：'
    default:
      return '请读取并安装以下 TraceMemo Reader Skill：'
  }
}

export function buildSkillInstallInstruction({
  target,
  source,
  apiBaseUrl
}: {
  target: AgentInstallTarget
  source: SkillInstallSource
  apiBaseUrl: { host: string; port: number }
}): string {
  const host = requestHost(apiBaseUrl.host)
  const hostPart = host.includes(':') ? `[${host}]` : host
  const healthUrl = `http://${hostPart}:${apiBaseUrl.port}/api/v1/health`
  const sourceText =
    source.type === 'local'
      ? `${opening(target)}\n\n${source.directoryPath}\n\n请先阅读该目录中的 SKILL.md，然后调用：`
      : `请从以下地址安装 TraceMemo Reader Skill：\n\n${source.installUrl}\n\n阅读 SKILL.md 后，调用：`
  return `${sourceText}\n\n${healthUrl}\n\n先调用公开的 health 接口验证服务。然后请用户在 TraceMemo → API Center → API Token 中点击“复制 Token”，并把 Token 配置为 Agent 本机环境变量 TRACEMEMO_API_TOKEN。读取联系人、会话或聊天记录时，必须发送 Authorization: Bearer $TRACEMEMO_API_TOKEN。若旧配置尚未升级，可兼容读取 WECHATEXPLORER_API_TOKEN，但新配置必须优先使用 TRACEMEMO_API_TOKEN。此服务是 Local HTTP API，不是 MCP Server。安装完成后告诉我验证结果。`
}

export function buildSkillVerificationPrompt(): string {
  return '请检查 TraceMemo Reader 是否已连接，然后列出最近 5 个微信会话。'
}
