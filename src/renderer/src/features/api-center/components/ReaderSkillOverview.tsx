import { type ReactElement } from 'react'
import type { ApiServiceState, SkillStatus } from '../model/types'
import type { AgentInstallTarget } from '../model/skillDistribution'
import { SkillDetails } from './SkillDetails'
import { SkillInstallFlow } from './SkillInstallFlow'

interface Props {
  skill: SkillStatus | null
  service: ApiServiceState | null
  dbReady: boolean
  target: AgentInstallTarget
  onTargetChange: (target: AgentInstallTarget) => void
  onPreview: () => void
  onOpenFolder: () => void
  onOpenGithub: () => void
  onStart: () => void
  onCopyInstruction: () => void
  onCopyVerification: () => void
}

export function ReaderSkillOverview({
  skill,
  service,
  dbReady,
  target,
  onTargetChange,
  onPreview,
  onOpenFolder,
  onOpenGithub,
  onStart,
  onCopyInstruction,
  onCopyVerification
}: Props): ReactElement {
  return (
    <>
      <section className="api-skill-overview" id="api-reader-skill">
        <div className="api-workspace-heading">
          <div>
            <div className="api-title-line">
              <h1>TraceMemo Reader</h1>
              <span className={`api-skill-status ${skill?.available ? 'ready' : 'error'}`}>
                {skill?.available ? '已安装' : '文件不可用'}
              </span>
              <span className="api-version">{skill?.version || 'v1.0'}</span>
            </div>
            <p>通过本地 HTTP API 读取 TraceMemo 已解锁的微信聊天数据</p>
          </div>
          <div className="api-header-actions">
            <button type="button" onClick={onPreview} disabled={!skill?.available}>
              预览 Skill
            </button>
            <button
              type="button"
              className="api-primary-button"
              disabled={!service?.running || !skill?.available}
              onClick={onCopyInstruction}
            >
              复制安装指令
            </button>
            <details className="api-skill-more">
              <summary>更多</summary>
              <button type="button" onClick={onOpenFolder} disabled={!skill?.available}>
                打开本地文件夹
              </button>
              <button type="button" onClick={onOpenGithub}>
                查看 GitHub 最新版本
              </button>
            </details>
          </div>
        </div>
        {!skill?.available && (
          <p className="api-inline-error">{skill?.error || 'Skill 文件不可用'}</p>
        )}
        <div className="api-trust-bar">
          <span>服务{skill?.available ? '已就绪' : '待修复'}</span>
          <i /> <span>本地 HTTP API</span>
          <i /> <span>聊天数据不经此 API 自动上传</span>
        </div>
        <div className="api-introduction">
          <h2>能力简介</h2>
          <p>
            TraceMemo Reader 让本地 AI Agent
            在用户授权和本地服务运行时，读取联系人、群聊、聊天记录和群成员信息，并调用内置模板导出群聊日报。聊天数据由
            TraceMemo 本地服务提供，不会由该 API 自动上传到其他服务器。
          </p>
          <div className="api-flow">
            <span>AI Agent</span>
            <b>→</b>
            <strong>Reader Skill</strong>
            <b>→</b>
            <span>Local HTTP API</span>
            <b>→</b>
            <span>本地微信数据库</span>
          </div>
        </div>
      </section>
      <SkillInstallFlow
        service={service}
        dbReady={dbReady}
        skill={skill}
        target={target}
        onTargetChange={onTargetChange}
        onStart={onStart}
        onCopyInstruction={onCopyInstruction}
        onCopyVerification={onCopyVerification}
      />
      <SkillDetails
        skill={skill}
        onOpenFolder={onOpenFolder}
        onPreview={onPreview}
        onGithub={onOpenGithub}
      />
    </>
  )
}
