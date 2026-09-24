import * as React from 'react'
import { Textarea } from '../../components/ui'
import {
  GROUP_EXIT_NOTIFICATION_PLACEHOLDER_LABELS,
  GROUP_EXIT_NOTIFICATION_TEMPLATE_MAX_LENGTH,
  GROUP_EXIT_NOTIFICATION_TEMPLATE_PLACEHOLDERS
} from '../../../../shared/group-exit-monitor'

/** 在光标处插入一个变量；没有光标位置就追加到末尾。纯 UI 辅助。 */
function insertTemplateVariable(
  template: string,
  variable: string,
  selectionStart?: number | null,
  selectionEnd?: number | null
): string {
  const token = `{${variable}}`
  const start = typeof selectionStart === 'number' ? selectionStart : template.length
  const end = typeof selectionEnd === 'number' ? selectionEnd : start
  return `${template.slice(0, start)}${token}${template.slice(end)}`
}

/**
 * LeaveNotificationTemplateEditor —— 「3 · 通知内容」。
 *
 * 占位符清单直接复用 shared 常量 —— UI 能插的变量与真实解释逻辑必须是同一份，
 * 否则会出现"插得进去、发出去不变"的变量。
 */

export interface LeaveNotificationTemplateEditorProps {
  template: string
  onChange: (next: string) => void
}

export function LeaveNotificationTemplateEditor({
  template,
  onChange
}: LeaveNotificationTemplateEditorProps): React.ReactElement {
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)

  const insertVariable = (variable: string): void => {
    const element = textareaRef.current
    onChange(
      insertTemplateVariable(
        template,
        variable,
        element?.selectionStart ?? null,
        element?.selectionEnd ?? null
      )
    )
  }

  return (
    <div className="automation-leave-template">
      <Textarea
        ref={textareaRef}
        id="automation-leave-template"
        aria-label="退群通知模板内容"
        value={template}
        rows={11}
        maxLength={GROUP_EXIT_NOTIFICATION_TEMPLATE_MAX_LENGTH}
        onChange={(event) => onChange(event.target.value)}
        className="automation-leave-template-editor"
      />

      <div className="automation-leave-template-meta">
        <span>支持</span>
        <span className="automation-leave-template-chips">
          {GROUP_EXIT_NOTIFICATION_TEMPLATE_PLACEHOLDERS.map((placeholder) => (
            <button
              key={placeholder}
              type="button"
              className="automation-leave-template-chip"
              // 悬停就能看到含义 —— 光看 {groupRemark} 这种符号谁也猜不出它是什么。
              title={`{${placeholder}}：${GROUP_EXIT_NOTIFICATION_PLACEHOLDER_LABELS[placeholder]}`}
              onClick={() => insertVariable(placeholder)}
              aria-label={`插入变量 ${placeholder}`}
            >
              {`{${placeholder}}`}
            </button>
          ))}
        </span>
        <span className="automation-leave-template-count">
          {template.length}/{GROUP_EXIT_NOTIFICATION_TEMPLATE_MAX_LENGTH}
        </span>
      </div>

      {/*
        先把最容易混的两项说清楚，再说兜底。
        实测有人把 {groupRemark} 当成群名（它其实是成员在本群的昵称），
        于是以为通知里已经有群名了 —— 所以这句必须放在最前面、直说区别。
      */}
      <p className="automation-leave-template-note">
        {`{groupName}`} 是<strong>群聊名</strong>；{`{groupRemark}`} 是退群成员
        <strong>在本群的昵称</strong>（不是群名）。取不到值时：{`{groupName}`}、{`{user}`}、
        {`{wxid}`} 显示「未读取到」，{`{groupRemark}`} 显示「未设置」。
        悬停变量可看含义；通知只发送到上面选定的目标。
      </p>
    </div>
  )
}
