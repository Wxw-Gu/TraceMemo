import React from 'react'
import type { ExportContactType, ExportNameMode } from '../../../../shared/export'
import type { VoiceModelStatus } from '../../../../shared/voice-recognition'
import {
  Button,
  Checkbox,
  Input,
  RadioGroup,
  RadioGroupItem,
  SegmentedControl,
  SegmentedControlItem
} from '../ui'
import type { Contact, ExportFormat, ExportRange, ExportStatus } from './exportTypes'
import { displayName, formatLabels, formatOrder, messageKinds } from './exportUtils'

interface NameOption {
  value: ExportNameMode
  label: string
}

interface ExportConfigurationPanelProps {
  taskCenter: React.ReactNode
  selectedContacts: Contact[]
  exportAll: boolean
  allContactTypes: ExportContactType[]
  selectedLabel: string
  selectionMode: boolean
  exportContactCount: number
  format: ExportFormat
  range: ExportRange
  startDate: string
  endDate: string
  selectedKinds: ReadonlySet<string>
  nameOptions: NameOption[]
  nameMode: ExportNameMode
  includeMedia: boolean
  includeVoiceTranscripts: boolean
  includeAvatars: boolean
  preferOriginal: boolean
  fallbackThumbnail: boolean
  keepMissing: boolean
  voiceModelStatus: VoiceModelStatus | null
  zip: boolean
  fileName: string
  defaultOutputName: string
  selectedTargetPath: string
  status: ExportStatus
  canStart: boolean
  onToggleSelectionMode: () => void
  onFormatChange: (format: ExportFormat) => void
  onZipChange: (zip: boolean) => void
  onRangeChange: (range: ExportRange) => void
  onStartDateChange: (value: string) => void
  onEndDateChange: (value: string) => void
  onToggleKind: (kind: string) => void
  onNameModeChange: (mode: ExportNameMode) => void
  onIncludeMediaChange: (checked: boolean) => void
  onIncludeVoiceTranscriptsChange: (checked: boolean) => void
  onIncludeAvatarsChange: (checked: boolean) => void
  onPreferOriginalChange: (checked: boolean) => void
  onFallbackThumbnailChange: (checked: boolean) => void
  onKeepMissingChange: (checked: boolean) => void
  onFileNameChange: (value: string) => void
  onSelectOutputDirectory: () => void
  onReset: () => void
  onStart: () => void
}

const sectionClassName = 'mb-6'
const sectionTitleClassName = 'mb-3 text-xs font-bold tracking-normal text-foreground'
const helperClassName = 'mb-0 mt-2 text-[11px] leading-[17px] text-muted-foreground'
const choicePanelClassName = 'rounded-lg bg-muted p-3'

export function ExportConfigurationPanel({
  taskCenter,
  selectedContacts,
  exportAll,
  allContactTypes,
  selectedLabel,
  selectionMode,
  exportContactCount,
  format,
  range,
  startDate,
  endDate,
  selectedKinds,
  nameOptions,
  nameMode,
  includeMedia,
  includeVoiceTranscripts,
  includeAvatars,
  preferOriginal,
  fallbackThumbnail,
  keepMissing,
  voiceModelStatus,
  zip,
  fileName,
  defaultOutputName,
  selectedTargetPath,
  status,
  canStart,
  onToggleSelectionMode,
  onFormatChange,
  onZipChange,
  onRangeChange,
  onStartDateChange,
  onEndDateChange,
  onToggleKind,
  onNameModeChange,
  onIncludeMediaChange,
  onIncludeVoiceTranscriptsChange,
  onIncludeAvatarsChange,
  onPreferOriginalChange,
  onFallbackThumbnailChange,
  onKeepMissingChange,
  onFileNameChange,
  onSelectOutputDirectory,
  onReset,
  onStart
}: ExportConfigurationPanelProps): React.ReactElement {
  const mediaOptionsEnabled = includeMedia && format === 'html'
  const voiceTranscriptsEnabled =
    mediaOptionsEnabled && selectedKinds.has('voice') && voiceModelStatus?.state === 'ready'

  return (
    <main className="export-config-panel flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <div className="export-config-scroll min-h-0 flex-1 overflow-auto px-7 pb-7 pt-6">
        {taskCenter}
        <header className="mb-6 flex items-center gap-3.5">
          <span className="relative h-[58px] w-[70px] shrink-0" aria-hidden>
            {exportAll
              ? allContactTypes.map((type, index) => (
                  <span
                    className={`export-chat-avatar export-all-chat-avatar ${type} absolute grid h-[52px] w-[52px] place-items-center overflow-hidden rounded-lg border-2 border-background text-xs font-bold text-primary-foreground ${
                      type === 'group' ? 'bg-[#2f7d5c]' : 'bg-[#416a8b]'
                    }`}
                    style={{ left: index * 12, top: 3 + index * 5 }}
                    key={type}
                  >
                    {type === 'group' ? '群' : '联'}
                  </span>
                ))
              : selectedContacts.slice(0, 3).map((contact, index) => (
                  <span
                    className="export-chat-avatar absolute grid h-[52px] w-[52px] place-items-center overflow-hidden rounded-lg border-2 border-background bg-primary/10 text-[22px] font-bold text-primary"
                    style={{ left: index * 12, top: 3 + index * 5 }}
                    key={contact.md5}
                  >
                    {contact.avatar ? (
                      <img className="h-full w-full object-cover" src={contact.avatar} alt="" />
                    ) : (
                      displayName(contact).slice(0, 1)
                    )}
                  </span>
                ))}
          </span>
          <span className="min-w-0 flex-1">
            <h1 className="m-0 text-xl font-bold leading-7 tracking-normal text-foreground">
              导出设置
            </h1>
            <p className="m-0 mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-muted-foreground">
              {selectedLabel}
            </p>
          </span>
          <Button
            variant="outline"
            size="sm"
            className="text-primary"
            disabled={exportAll}
            onClick={onToggleSelectionMode}
          >
            {exportAll ? '已选择全部聊天' : selectionMode ? '完成选择' : '+ 添加聊天'}
          </Button>
        </header>

        <section className={sectionClassName}>
          <h3 className={sectionTitleClassName}>导出格式</h3>
          <SegmentedControl
            className="grid w-full grid-cols-2 gap-1.5 p-1.5 min-[900px]:grid-cols-4"
            value={format}
            onValueChange={(value) => onFormatChange(value as ExportFormat)}
            aria-label="导出格式"
          >
            {formatOrder.map((value) => {
              return (
                <SegmentedControlItem
                  key={value}
                  value={value}
                  className="!h-[78px] min-w-0 flex-col gap-1.5 whitespace-normal rounded-md px-2 text-foreground data-[state=checked]:text-primary"
                  disabled={!exportAll && exportContactCount > 1 && value !== 'html'}
                >
                  <strong className="text-[13px]">{formatLabels[value].label}</strong>
                  {formatLabels[value].hint && (
                    <small className="text-[10px] font-normal text-success">
                      {formatLabels[value].hint}
                    </small>
                  )}
                </SegmentedControlItem>
              )
            })}
          </SegmentedControl>
          <p className={helperClassName}>
            {exportAll
              ? '全部导出固定使用全部时间；每个群聊或联系人都会在自己的目录中生成所选格式的独立档案。'
              : selectedContacts.length > 1
                ? '多聊天合并仅支持 HTML，会保留每条消息所属的聊天。'
                : 'CSV 默认最快；HTML 会包含图片、引用和其他媒体，导出时间可能较长。'}
          </p>
          {format === 'html' && (
            <>
              <RadioGroup
                className="mt-2.5 gap-2 rounded-lg border border-border bg-muted px-3 py-2.5 text-xs text-foreground"
                value={zip ? 'zip' : 'folder'}
                onValueChange={(value) => onZipChange(value === 'zip')}
                aria-label="HTML 打包方式"
              >
                <label className="flex cursor-pointer items-center gap-2" htmlFor="html-folder">
                  <RadioGroupItem id="html-folder" value="folder" />
                  HTML 资源包
                </label>
                <label className="flex cursor-pointer items-center gap-2" htmlFor="html-zip">
                  <RadioGroupItem id="html-zip" value="zip" />
                  HTML 资源包并压缩为 ZIP
                </label>
              </RadioGroup>
              <p className={helperClassName}>
                使用相同名称再次导出时，会把新消息合并进已有档案，不会删除之前导出的消息。
              </p>
            </>
          )}
        </section>

        <section className={sectionClassName}>
          <div className="flex items-center justify-between gap-3">
            <h3 className={sectionTitleClassName}>时间范围</h3>
            <span className="mb-3 text-xs text-primary">
              {status === 'completed' ? '已完成导出' : '消息数量将在开始导出后统计'}
            </span>
          </div>
          <SegmentedControl
            className="grid w-full grid-cols-2 gap-1.5 p-1.5 min-[900px]:grid-cols-3"
            value={range}
            onValueChange={(value) => onRangeChange(value as ExportRange)}
            aria-label="时间范围"
          >
            {(exportAll
              ? [['all', '全部时间']]
              : [
                  ['all', '全部时间'],
                  ['today', '今天'],
                  ['threeDays', '最近 3 天'],
                  ['sevenDays', '最近 7 天'],
                  ['custom', '自定义时间']
                ]
            ).map(([value, label]) => (
              <SegmentedControlItem key={value} value={value} className="w-full">
                {label}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          {!exportAll && range === 'custom' && (
            <div className="mt-2.5 grid grid-cols-2 gap-2.5 rounded-lg bg-muted p-3">
              <label className="grid gap-1.5 text-[11px] text-muted-foreground">
                开始时间
                <Input
                  type="datetime-local"
                  value={startDate}
                  onChange={(event) => onStartDateChange(event.target.value)}
                />
              </label>
              <label className="grid gap-1.5 text-[11px] text-muted-foreground">
                结束时间
                <Input
                  type="datetime-local"
                  value={endDate}
                  onChange={(event) => onEndDateChange(event.target.value)}
                />
              </label>
            </div>
          )}
        </section>

        <section className={sectionClassName}>
          <h3 className={sectionTitleClassName}>消息内容</h3>
          <div
            className={`${choicePanelClassName} grid grid-cols-2 gap-x-5 gap-y-1 min-[900px]:grid-cols-3`}
          >
            {messageKinds.map(([value, label]) => (
              <label
                key={value}
                className="flex min-h-7 cursor-pointer items-center gap-2 text-xs text-foreground"
              >
                <Checkbox
                  checked={selectedKinds.has(value)}
                  onCheckedChange={() => onToggleKind(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </section>

        <section className={sectionClassName}>
          <h3 className={sectionTitleClassName}>消息显示名称</h3>
          <SegmentedControl
            className="grid w-full grid-cols-3 gap-1.5 p-1.5"
            value={nameMode}
            onValueChange={(value) => onNameModeChange(value as ExportNameMode)}
            aria-label="消息显示名称"
          >
            {nameOptions.map((option) => (
              <SegmentedControlItem
                key={option.value}
                value={option.value}
                className="w-full justify-start gap-2 px-2 text-foreground data-[state=checked]:text-primary"
              >
                <span>{option.label}</span>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </section>

        <section className={sectionClassName}>
          <h3 className={sectionTitleClassName}>资源处理</h3>
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3.5 py-3 text-xs text-foreground">
            <span>包含图片、视频、语音、表情及文件附件</span>
            <Checkbox
              checked={includeMedia}
              disabled={format !== 'html'}
              onCheckedChange={(checked) => onIncludeMediaChange(checked === true)}
            />
          </label>
          <div
            className={`${choicePanelClassName} mt-2 grid gap-0.5 ${mediaOptionsEnabled ? '' : 'opacity-50'}`}
          >
            {(
              [
                ['prefer-original', '优先导出原图', preferOriginal, onPreferOriginalChange],
                [
                  'fallback-thumbnail',
                  '原图缺失时使用缩略图',
                  fallbackThumbnail,
                  onFallbackThumbnailChange
                ],
                ['keep-missing', '媒体缺失时保留占位说明', keepMissing, onKeepMissingChange]
              ] as const
            ).map(([id, label, checked, onChange]) => (
              <label
                key={id}
                className="flex min-h-7 cursor-pointer items-center gap-2 text-xs text-foreground"
              >
                <Checkbox
                  checked={checked}
                  disabled={!mediaOptionsEnabled}
                  onCheckedChange={(nextChecked) => onChange(nextChecked === true)}
                />
                <span>{label}</span>
              </label>
            ))}
            <label className="flex min-h-7 cursor-pointer items-center gap-2 text-xs text-foreground">
              <Checkbox
                checked={includeVoiceTranscripts && voiceModelStatus?.state === 'ready'}
                disabled={!voiceTranscriptsEnabled}
                onCheckedChange={(checked) => onIncludeVoiceTranscriptsChange(checked === true)}
              />
              <span>语音转文字，显示在语音条下方</span>
            </label>
          </div>
          <p className={helperClassName}>
            资源文件仅在 HTML 导出中生效，CSV、JSON 和 Markdown 只保留文本内容。
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[
              '图片解密：已就绪',
              '视频资源：可用',
              '语音资源：可用',
              `语音转文字：${voiceModelStatus?.state === 'ready' ? '已就绪' : '请先在设置中准备模型'}`,
              '表情资源：按需解析',
              '文件附件：按需复制'
            ].map((label) => (
              <span
                key={label}
                className="rounded bg-primary/10 px-2 py-1 text-[10px] text-success"
              >
                {label}
              </span>
            ))}
          </div>
          <p className={helperClassName}>媒体资源会延长导出时间，缺失资源不会中断任务。</p>
          <label className="mt-2 flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3.5 py-3 text-xs text-foreground">
            <span>在聊天气泡旁显示头像</span>
            <Checkbox
              checked={includeAvatars}
              onCheckedChange={(checked) => onIncludeAvatarsChange(checked === true)}
            />
          </label>
        </section>

        <section className="mb-0 grid gap-3">
          <h3 className="m-0 text-xs font-bold tracking-normal text-foreground">保存设置</h3>
          <label className="grid gap-1.5 text-[11px] text-muted-foreground">
            文件名称
            <Input
              value={fileName}
              onChange={(event) => onFileNameChange(event.target.value)}
              placeholder={defaultOutputName}
            />
          </label>
          <div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-2.5 py-2 text-[11px] text-muted-foreground">
            <span>保存位置</span>
            <strong
              className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-foreground"
              title={selectedTargetPath}
            >
              {selectedTargetPath}
            </strong>
            <Button variant="outline" size="sm" onClick={onSelectOutputDirectory}>
              选择位置
            </Button>
          </div>
          {format === 'html' && (
            <p className={helperClassName}>可以分多次选择不同时间范围，逐步补齐同一个聊天档案。</p>
          )}
        </section>
      </div>

      <footer className="flex h-[58px] shrink-0 items-center gap-2 border-t border-border bg-surface px-5.5 text-xs text-muted-foreground">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${status === 'completed' ? 'bg-primary' : 'bg-success'}`}
          aria-hidden
        />
        <span>
          {status === 'running' ? '正在后台导出' : status === 'completed' ? '导出完成' : '准备就绪'}
        </span>
        <span className="ml-3 min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground">
          路径：{selectedTargetPath}
        </span>
        <Button variant="ghost" size="sm" onClick={onReset}>
          恢复默认
        </Button>
        <Button className="min-w-[132px]" disabled={!canStart} onClick={onStart}>
          {status === 'running' ? '正在导出' : status === 'completed' ? '再次导出' : '开始导出'}
        </Button>
      </footer>
    </main>
  )
}
