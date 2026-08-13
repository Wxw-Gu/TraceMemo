import React, { useEffect, useRef, useState } from 'react'
import {
  SELECTABLE_REPORT_TEMPLATES,
  type SelectableReportTemplateId
} from '../../../../shared/report-templates'

interface ReportToolbarProps {
  canCopyImage: boolean
  canReveal: boolean
  canShare: boolean
  canSwitchTemplate: boolean
  currentTemplateId?: SelectableReportTemplateId
  isSwitchingTemplate: boolean
  onSwitchTemplate: (templateId: SelectableReportTemplateId) => void
  onRegenerate: () => void
  onCopyImage: () => void
  onReveal: () => void
  onShare: () => void
}

export function ReportToolbar({
  canCopyImage,
  canReveal,
  canShare,
  canSwitchTemplate,
  currentTemplateId,
  isSwitchingTemplate,
  onSwitchTemplate,
  onRegenerate,
  onCopyImage,
  onReveal,
  onShare
}: ReportToolbarProps): React.ReactElement {
  const [moreOpen, setMoreOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const templateMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!moreOpen && !templateOpen) return
    const close = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMoreOpen(false)
      if (!templateMenuRef.current?.contains(event.target as Node)) setTemplateOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [moreOpen, templateOpen])

  return (
    <div className="report-viewer-toolbar">
      <div className="report-template-switch-menu" ref={templateMenuRef}>
        <button
          type="button"
          disabled={!canSwitchTemplate || isSwitchingTemplate}
          title={
            canSwitchTemplate
              ? '使用已生成的数据或本地 HTML 更换展示模板，不会重新调用 AI'
              : '当前报告缺少可复用数据和 HTML，无法切换模板'
          }
          onClick={() => setTemplateOpen((open) => !open)}
        >
          {isSwitchingTemplate ? '切换中…' : '切换模板'}
        </button>
        {templateOpen && canSwitchTemplate && (
          <div className="report-template-switch-popover" role="menu" aria-label="切换日报模板">
            <p>仅重新排版，不调用 AI</p>
            {SELECTABLE_REPORT_TEMPLATES.map((template) => (
              <button
                type="button"
                role="menuitem"
                className={template.id === currentTemplateId ? 'active' : undefined}
                key={template.id}
                onClick={() => {
                  setTemplateOpen(false)
                  onSwitchTemplate(template.id)
                }}
              >
                <span>{template.label}</span>
                <b>{template.name}</b>
                {template.id === currentTemplateId && <i>当前</i>}
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" onClick={onRegenerate}>
        重新生成
      </button>
      <button type="button" disabled={!canCopyImage} onClick={onCopyImage}>
        复制图片
      </button>
      <button type="button" className="primary" disabled={!canReveal} onClick={onReveal}>
        打开报告
      </button>
      <button type="button" disabled={!canShare} onClick={onShare}>
        生成微信卡片
      </button>
      <div className="report-more-menu" ref={menuRef}>
        <button type="button" onClick={() => setMoreOpen((open) => !open)}>
          更多
        </button>
        {moreOpen && (
          <div className="report-more-popover">
            <button
              type="button"
              disabled={!canReveal}
              onClick={() => {
                setMoreOpen(false)
                onReveal()
              }}
            >
              打开文件夹
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
