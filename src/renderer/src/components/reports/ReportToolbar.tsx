import React from 'react'
import {
  SELECTABLE_REPORT_TEMPLATES,
  type SelectableReportTemplateId
} from '../../../../shared/report-templates'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui'

interface ReportToolbarProps {
  canCopyImage: boolean
  canReveal: boolean
  canShare: boolean
  canSwitchTemplate: boolean
  canSendToGroup?: boolean
  sendToGroupHint?: string
  currentTemplateId?: SelectableReportTemplateId
  isSwitchingTemplate: boolean
  onSwitchTemplate: (templateId: SelectableReportTemplateId) => void
  onRegenerate: () => void
  onCopyImage: () => void
  onReveal: () => void
  onShare: () => void
  onSendToGroup?: () => void
}

export function ReportToolbar({
  canCopyImage,
  canReveal,
  canShare,
  canSwitchTemplate,
  canSendToGroup = false,
  sendToGroupHint = '当前报告暂时无法发送',
  currentTemplateId,
  isSwitchingTemplate,
  onSwitchTemplate,
  onRegenerate,
  onCopyImage,
  onReveal,
  onShare,
  onSendToGroup
}: ReportToolbarProps): React.ReactElement {
  return (
    <div className="report-viewer-toolbar">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={!canSwitchTemplate || isSwitchingTemplate}
            title={
              canSwitchTemplate
                ? '使用已生成的数据或本地 HTML 更换展示模板，不会重新调用 AI'
                : '当前报告缺少可复用数据和 HTML，无法切换模板'
            }
          >
            {isSwitchingTemplate ? '切换中…' : '切换模板'}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64" align="end" aria-label="切换日报模板">
          <DropdownMenuLabel>仅重新排版，不调用 AI</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {SELECTABLE_REPORT_TEMPLATES.map((template) => (
            <DropdownMenuItem
              className="grid min-h-11 grid-cols-[62px_minmax(0,1fr)_auto] gap-2"
              key={template.id}
              onSelect={() => onSwitchTemplate(template.id)}
            >
              <span className="text-xs text-muted-foreground">{template.label}</span>
              <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold">
                {template.name}
              </strong>
              {template.id === currentTemplateId && (
                <span className="text-xs text-primary">当前</span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="outline" size="sm" onClick={onRegenerate}>
        重新生成
      </Button>
      <Button variant="outline" size="sm" disabled={!canCopyImage} onClick={onCopyImage}>
        复制图片
      </Button>
      <span
        className="report-toolbar-button-hint"
        title={sendToGroupHint}
        aria-label={sendToGroupHint}
        tabIndex={canSendToGroup ? -1 : 0}
      >
        <Button
          variant="outline"
          size="sm"
          disabled={!canSendToGroup}
          onClick={() => onSendToGroup?.()}
        >
          发送到当前群聊
        </Button>
      </span>
      <Button size="sm" disabled={!canReveal} onClick={onReveal}>
        打开报告
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">
            更多
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={!canShare} onSelect={onShare}>
            生成微信卡片
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canReveal} onSelect={onReveal}>
            打开文件夹
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
