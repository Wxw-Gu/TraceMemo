import { type ReactElement } from 'react'
import type { ApiServiceState, SkillStatus } from '../model/types'
import { type AgentInstallTarget } from '../model/skillDistribution'
import { SkillTargetSelector } from './SkillTargetSelector'

interface Props {
  service: ApiServiceState | null
  dbReady: boolean
  skill: SkillStatus | null
  target: AgentInstallTarget
  onTargetChange: (target: AgentInstallTarget) => void
  onStart: () => void
  onCopyInstruction: () => void
  onCopyVerification: () => void
}

const buttonLabel: Record<AgentInstallTarget, string> = {
  codex: '复制给 Codex',
  'claude-code': '复制给 Claude Code',
  openclaw: '复制给 OpenClaw',
  generic: '复制通用指令'
}

export function SkillInstallFlow({
  service,
  dbReady,
  skill,
  target,
  onTargetChange,
  onStart,
  onCopyInstruction,
  onCopyVerification
}: Props): ReactElement {
  const ready = Boolean(service?.running && dbReady && skill?.available)
  const address = `${service?.host || '127.0.0.1'}:${service?.port || 6131}`
  return (
    <section className="skill-install-flow">
      <div className="api-section-heading">
        <h2>快速接入</h2>
        <span>三步完成安装</span>
      </div>
      <div className="skill-flow-steps">
        <section className={service?.running && dbReady ? 'done' : 'active'}>
          <b>1</b>
          <div>
            <h3>确认 TraceMemo 已就绪</h3>
            <p>
              本地 API：{service?.running ? '运行中' : '已停止'} · {address}
            </p>
            <p>
              数据库：{dbReady ? '已连接' : '未连接'} · Reader Skill：
              {skill?.available ? '可用' : '不可用'}
            </p>
            {!service?.running && (
              <button type="button" className="api-primary-button" onClick={onStart}>
                启动服务
              </button>
            )}
            {!skill?.available && (
              <p className="api-inline-error">{skill?.error || '本地 Skill 文件不可用'}</p>
            )}
          </div>
        </section>
        <section className="active">
          <b>2</b>
          <div>
            <h3>选择目标 Agent</h3>
            <SkillTargetSelector value={target} onChange={onTargetChange} />
          </div>
        </section>
        <section className={ready ? 'active' : ''}>
          <b>3</b>
          <div>
            <h3>粘贴并验证</h3>
            <p>将安装指令粘贴到 Agent；安装后应调用 health 接口验证连接。</p>
            <div className="skill-flow-actions">
              <button
                type="button"
                className="api-primary-button"
                disabled={!ready}
                onClick={onCopyInstruction}
              >
                {buttonLabel[target]}
              </button>
              <button type="button" disabled={!ready} onClick={onCopyVerification}>
                复制测试问题
              </button>
            </div>
          </div>
        </section>
      </div>
    </section>
  )
}
