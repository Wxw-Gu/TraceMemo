import React from 'react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui'
import { ArrowDownIcon, ExportIcon } from './icons'

export type ExportRange = number | 'all'

interface ExportMenuProps {
  disabled: boolean
  onExport: (range: ExportRange) => void
}

const EXPORT_OPTIONS: { label: string; value: ExportRange }[] = [
  { label: '导出当前范围', value: 'all' },
  { label: '导出今天', value: 0 },
  { label: '导出昨日', value: 1 },
  { label: '导出近 7 天', value: 7 },
  { label: '导出近 30 天', value: 30 },
  { label: '导出全部', value: 'all' }
]

export function ExportMenu({ disabled, onExport }: ExportMenuProps): React.ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="chat-tool-button"
          disabled={disabled}
          title={disabled ? '没有可导出的消息' : '导出聊天记录'}
        >
          <ExportIcon />
          <span>导出</span>
          <ArrowDownIcon />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {EXPORT_OPTIONS.map((option, index) => (
          <DropdownMenuItem
            key={`${option.label}-${index}`}
            onSelect={() => onExport(option.value)}
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
