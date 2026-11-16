import * as React from 'react'
import { Button } from '../../components/ui'
import type { ExtensionTemplateEntry } from '../../../../shared/extensions/templates'

interface CreateProjectDialogProps {
  template: ExtensionTemplateEntry
  busy: boolean
  onCancel: () => void
  onSubmit: (input: { extensionId: string; name: string }) => void
}

const ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)+$/

/** 默认 id 从模板 id 派生，用户可以直接改。 */
function suggestExtensionId(templateId: string): string {
  const suffix = templateId.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  return `com.example.${suffix}-dev`
}

/**
 * 从模板创建独立项目。
 *
 * 只收集「新 id」和「名称」：目录由调用方先选好，创建过程在主进程完成，
 * 这里不做任何文件操作。
 */
export function CreateProjectDialog({
  template,
  busy,
  onCancel,
  onSubmit
}: CreateProjectDialogProps): React.ReactElement {
  const [extensionId, setExtensionId] = React.useState(() =>
    suggestExtensionId(template.templateId)
  )
  const [name, setName] = React.useState(`${template.name}（我的版本）`)

  const trimmedId = extensionId.trim().toLowerCase()
  const idValid = ID_PATTERN.test(trimmedId)
  const conflictsWithTemplate = trimmedId === template.extensionId
  const canSubmit = idValid && !conflictsWithTemplate && !busy

  return (
    <div className="extension-project-dialog" role="dialog" aria-label="从模板创建项目">
      <h4>从「{template.name}」创建独立项目</h4>
      <p className="extension-muted">
        会在你选择的目录里生成完整源码；不会复制任何配置、Cookie 或聊天数据。
      </p>

      <label className="extension-field">
        <span>扩展 ID</span>
        <input
          value={extensionId}
          spellCheck={false}
          onChange={(event) => setExtensionId(event.target.value)}
          placeholder="com.acme.my-bot"
        />
      </label>
      {!idValid && (
        <p className="extension-field-error">id 必须是反向域名格式（小写字母、数字、连字符）</p>
      )}
      {conflictsWithTemplate && (
        <p className="extension-field-error">不能沿用模板原 id，否则会和官方模板冲突</p>
      )}

      <label className="extension-field">
        <span>显示名称</span>
        <input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
      </label>

      <div className="extension-project-dialog-actions">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
          size="sm"
          disabled={!canSubmit}
          onClick={() => onSubmit({ extensionId: trimmedId, name: name.trim() })}
        >
          {busy ? '创建中…' : '选择目录并创建'}
        </Button>
      </div>
    </div>
  )
}
