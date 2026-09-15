import React from 'react'
import {
  DEFAULT_REPORT_TEMPLATE,
  type ReportTemplateDefinition
} from '../../../../shared/report-templates'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui'

/**
 * 日报模板预览的共享部分：生成页的模板选择器与社区模板市场页共用同一套
 * 卡片示意图与预览弹窗，避免两处各维护一份。
 */
export type ReportTemplatePreviewItem =
  | { kind: 'builtin'; template: ReportTemplateDefinition }
  | {
      kind: 'external'
      id: string
      version: string
      name: string
      description: string
      installed: boolean
      platform?: 'default' | 'mobile' | 'desktop'
      preview?: string
    }

export const reportTemplatePlatformLabel = (
  platform?: 'default' | 'mobile' | 'desktop'
): string => (platform === 'desktop' ? '桌面宽屏' : platform === 'default' ? '经典长图' : '手机长图')

export const TemplateDiagram = ({
  template
}: {
  template: ReportTemplateDefinition
}): React.ReactElement => (
  <div className={`report-template-diagram diagram-${template.id}`} aria-hidden="true">
    <div className="diagram-masthead">
      <i />
      <b />
      <span />
    </div>
    <div className="diagram-kpis">
      <i />
      <i />
      <i />
      <i />
    </div>
    <div className="diagram-content">
      <div className="diagram-column diagram-column-a">
        <b />
        <span />
        <span />
      </div>
      <div className="diagram-column diagram-column-b">
        <b />
        <span />
        <span />
        <span />
      </div>
      <div className="diagram-column diagram-column-c">
        <b />
        <span />
        <span />
      </div>
    </div>
  </div>
)

export function ReportTemplatePreviewDialog({
  previewing,
  confirmLabel = '选择此模板',
  restoreFocusRef,
  onClose,
  onConfirm
}: {
  previewing: ReportTemplatePreviewItem | null
  confirmLabel?: string
  restoreFocusRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
  onConfirm: (item: ReportTemplatePreviewItem) => void
}): React.ReactElement {
  return (
    <Dialog
      open={Boolean(previewing)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      {previewing && (
        <DialogContent
          className="report-template-preview-card max-h-[90vh] max-w-[520px] overflow-y-auto bg-surface-muted p-[18px]"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            restoreFocusRef.current?.focus()
          }}
        >
          <DialogHeader className="pr-8">
            <div className="report-template-preview-heading">
              <div>
                <span>
                  {previewing.kind === 'builtin'
                    ? previewing.template.label
                    : `市场 · v${previewing.version}`}
                </span>
                <DialogTitle>
                  {previewing.kind === 'builtin' ? previewing.template.name : previewing.name}
                </DialogTitle>
              </div>
              <em>
                {reportTemplatePlatformLabel(
                  previewing.kind === 'builtin'
                    ? previewing.template.platform
                    : previewing.platform
                )}
              </em>
            </div>
            <DialogDescription>
              {previewing.kind === 'builtin'
                ? previewing.template.tagline
                : previewing.description}
            </DialogDescription>
          </DialogHeader>
          {previewing.kind === 'builtin' ? (
            <TemplateDiagram template={previewing.template} />
          ) : previewing.preview ? (
            <img
              src={previewing.preview}
              alt={`${previewing.name} 预览`}
              className="max-h-[60vh] w-full object-contain"
            />
          ) : (
            <TemplateDiagram template={DEFAULT_REPORT_TEMPLATE} />
          )}
          <DialogDescription className="report-template-preview-note">
            生成时会自动代入当前群聊的真实头像、昵称、消息、讨论摘要、Q&amp;A、统计与关键词。
          </DialogDescription>
          <DialogFooter className="report-template-preview-actions">
            <DialogClose asChild>
              <Button variant="outline">关闭</Button>
            </DialogClose>
            {previewing.kind === 'builtin' || previewing.installed ? (
              <Button onClick={() => onConfirm(previewing)}>{confirmLabel}</Button>
            ) : (
              <Button disabled>请先安装</Button>
            )}
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
