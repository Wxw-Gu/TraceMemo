import { type ReactElement } from 'react'
import type { SkillStatus } from '../model/types'

export function SkillDetails({
  skill,
  onOpenFolder,
  onPreview,
  onGithub
}: {
  skill: SkillStatus | null
  onOpenFolder: () => void
  onPreview: () => void
  onGithub: () => void
}): ReactElement {
  return (
    <details className="api-skill-details">
      <summary>Skill 详情</summary>
      <dl>
        <div>
          <dt>名称</dt>
          <dd>TraceMemo Reader</dd>
        </div>
        <div>
          <dt>标识</dt>
          <dd>tracememo-reader</dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd>{skill?.version || '未知'}</dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd>随应用安装</dd>
        </div>
        <div>
          <dt>本地状态</dt>
          <dd>
            {skill?.available ? '可用' : `本地 Skill 文件不可用：${skill?.error || '无法读取文件'}`}
          </dd>
        </div>
      </dl>
      <div>
        <button type="button" onClick={onOpenFolder} disabled={!skill?.available}>
          打开本地文件夹
        </button>
        <button type="button" onClick={onPreview} disabled={!skill?.available}>
          预览 SKILL.md
        </button>
        <button type="button" onClick={onGithub}>
          查看 GitHub 最新版本
        </button>
      </div>
    </details>
  )
}
