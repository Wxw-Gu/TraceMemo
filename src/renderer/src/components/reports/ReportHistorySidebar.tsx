import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AccountSummary } from '../account/AccountSummary'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Input
} from '../ui'
import type { GeneratedReportRecord } from './types'

interface SelfInfo {
  wxid: string
  nickname: string
  avatar?: string
  accountRoot: string
}

interface ReportHistorySidebarProps {
  reports: GeneratedReportRecord[]
  selectedReportId: string | null
  selfInfo: SelfInfo | null
  dbReady: boolean
  dbConnecting?: boolean
  onSelectReport: (reportId: string) => void
  onCreateReport: () => void
  onDeleteReport: (reportId: string) => Promise<{ success: boolean; error?: string }>
  onOpenSettings: () => void
}

interface ReportGroup {
  label: string
  reports: GeneratedReportRecord[]
}

const DAY_MS = 86400000

const dateKey = (value: string): number => {
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

const formatGeneratedAt = (value: string): string => {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

const groupLabelFor = (value: string): string => {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '更早'

  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - DAY_MS
  const time = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

  if (time >= startOfToday) return '今天'
  if (time >= startOfYesterday) return '昨天'
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

const buildGroups = (reports: GeneratedReportRecord[]): ReportGroup[] => {
  const groups: ReportGroup[] = []
  const groupMap = new Map<string, GeneratedReportRecord[]>()

  reports.forEach((report) => {
    const label = groupLabelFor(report.generatedAt)
    const items = groupMap.get(label) || []
    items.push(report)
    groupMap.set(label, items)
  })

  groupMap.forEach((items, label) => groups.push({ label, reports: items }))
  return groups
}

export function ReportHistorySidebar({
  reports,
  selectedReportId,
  selfInfo,
  dbReady,
  dbConnecting = false,
  onSelectReport,
  onCreateReport,
  onDeleteReport,
  onOpenSettings
}: ReportHistorySidebarProps): React.ReactElement {
  const [keyword, setKeyword] = useState('')
  const [pendingDelete, setPendingDelete] = useState<GeneratedReportRecord | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [deletePending, setDeletePending] = useState(false)
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null)
  const restoreDeleteFocusRef = useRef(false)

  useEffect(() => {
    if (pendingDelete || !restoreDeleteFocusRef.current) return
    restoreDeleteFocusRef.current = false
    deleteTriggerRef.current?.focus()
  }, [pendingDelete])

  const reportGroups = useMemo(() => {
    const lower = keyword.trim().toLowerCase()
    const filteredReports = reports
      .filter((report) => {
        const haystack = `${report.contactName} ${report.dateRange} ${formatGeneratedAt(
          report.generatedAt
        )}`.toLowerCase()
        return lower ? haystack.includes(lower) : true
      })
      .sort((left, right) => dateKey(right.generatedAt) - dateKey(left.generatedAt))

    return buildGroups(filteredReports)
  }, [keyword, reports])

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    setDeleteError('')
    setDeletePending(true)
    try {
      const result = await onDeleteReport(pendingDelete.id)
      if (!result.success) {
        setDeleteError(result.error || '删除日报失败')
        return
      }
      restoreDeleteFocusRef.current = false
      setPendingDelete(null)
    } finally {
      setDeletePending(false)
    }
  }

  return (
    <aside className="report-history-sidebar">
      <div className="report-history-header">
        <div>
          <h2>AI 日报</h2>
          <p>已生成报告管理中心</p>
        </div>
        <span>{reports.length}</span>
      </div>
      <label className="report-history-search">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="10.5" cy="10.5" r="5.5" />
          <path d="m15 15 4 4" />
        </svg>
        <Input
          className="pl-9"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索群聊或日报"
        />
      </label>
      <Button className="report-history-create" onClick={onCreateReport}>
        + 新建日报
      </Button>
      <div className="report-history-list" aria-label="历史报告">
        <div className="report-history-list-title">历史报告</div>
        {reportGroups.length ? (
          reportGroups.map((group) => (
            <section className="report-history-group" key={group.label}>
              <h3>{group.label}</h3>
              {group.reports.map((report) => (
                <div
                  key={report.id}
                  role="button"
                  tabIndex={0}
                  className={`report-history-item ${report.id === selectedReportId ? 'active' : ''}`}
                  onClick={() => onSelectReport(report.id)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    onSelectReport(report.id)
                  }}
                >
                  <span className="report-history-avatar">
                    {report.contactAvatar ? (
                      <img
                        src={report.contactAvatar}
                        alt={report.contactName}
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      report.contactName.charAt(0)
                    )}
                  </span>
                  <span className="report-history-text">
                    <b>{report.contactName}</b>
                    <small>{formatGeneratedAt(report.generatedAt)}</small>
                    <small>{report.messageCount} 条消息</small>
                    <em>PNG{report.pngStatus === 'ready' ? '已保存' : '缺失'}</em>
                  </span>
                  <button
                    type="button"
                    className="report-history-delete"
                    title="删除日报"
                    aria-label="删除日报"
                    onClick={(event) => {
                      event.stopPropagation()
                      deleteTriggerRef.current = event.currentTarget
                      restoreDeleteFocusRef.current = true
                      setPendingDelete(report)
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      event.stopPropagation()
                      deleteTriggerRef.current = event.currentTarget
                      restoreDeleteFocusRef.current = true
                      setPendingDelete(report)
                    }}
                  >
                    删除
                  </button>
                </div>
              ))}
            </section>
          ))
        ) : (
          <div className="report-history-empty">
            <b>暂无历史报告</b>
            <span>新建日报后会出现在这里。</span>
          </div>
        )}
      </div>
      <div className="report-history-account">
        <AccountSummary
          selfInfo={selfInfo}
          dbReady={dbReady}
          dbConnecting={dbConnecting}
          onClick={onOpenSettings}
        />
      </div>
      <AlertDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open && !deletePending) {
            setPendingDelete(null)
            setDeleteError('')
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除日报？</AlertDialogTitle>
            <AlertDialogDescription>
              只删除本地生成报告，不会影响微信聊天记录。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline" disabled={deletePending}>
                取消
              </Button>
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={deletePending}
              onClick={() => void confirmDelete()}
            >
              {deletePending ? '删除中…' : '删除'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  )
}
