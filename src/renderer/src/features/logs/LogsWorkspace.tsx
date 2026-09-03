import React from 'react'
import type { ActionLogEntry } from '../../../../shared/action-log'
import type { WechatActionPurpose, WechatActionStatus } from '../../../../shared/wechat-action'
import {
  EmptyState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner
} from '../../components/ui'

type StatusFilter = 'all' | WechatActionStatus
type PurposeFilter = 'all' | 'member_left_notification' | 'scheduled_report' | 'other'

const purposeLabel = (purpose: WechatActionPurpose): string => {
  if (purpose === 'member_left_notification') return '退群通知'
  if (purpose === 'scheduled_report') return '定时日报'
  return purpose || '其它动作'
}

const contentTypeLabel = (type: ActionLogEntry['contentType']): string => {
  if (type === 'image') return '图片'
  if (type === 'voice') return '语音'
  return '文字'
}

const statusDetails = (
  entry: ActionLogEntry
): { label: string; className: string } => {
  if (entry.status === 'sent') return { label: '已发送', className: 'text-success' }
  if (entry.status === 'blocked') return { label: '被阻止', className: 'text-warning' }
  if (
    entry.errorCode === 'SEND_CAPABILITY_UNAVAILABLE' ||
    entry.errorCode === 'SEND_NOT_READY'
  ) {
    return { label: '发送能力不可用', className: 'text-warning' }
  }
  return { label: '失败', className: 'text-destructive' }
}

const matchesPurpose = (entry: ActionLogEntry, filter: PurposeFilter): boolean => {
  if (filter === 'all') return true
  if (filter === 'other') {
    return entry.purpose !== 'member_left_notification' && entry.purpose !== 'scheduled_report'
  }
  return entry.purpose === filter
}

export function LogsWorkspace(): React.ReactElement {
  const [entries, setEntries] = React.useState<ActionLogEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [keyword, setKeyword] = React.useState('')
  const [status, setStatus] = React.useState<StatusFilter>('all')
  const [purpose, setPurpose] = React.useState<PurposeFilter>('all')

  React.useEffect(() => {
    let disposed = false
    void window.api
      .listWechatActionLogs()
      .then((items) => {
        if (!disposed) setEntries(items)
      })
      .catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [])

  const visibleEntries = React.useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase()
    return entries.filter((entry) => {
      if (status !== 'all' && entry.status !== status) return false
      if (!matchesPurpose(entry, purpose)) return false
      if (!query) return true
      return [entry.recipientName, entry.recipientId, entry.contentPreview]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(query))
    })
  }, [entries, keyword, purpose, status])

  return (
    <div className="h-full min-w-0 overflow-y-auto bg-canvas">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 py-6">
        <header>
          <h1 className="text-xl font-semibold text-foreground">日志</h1>
        </header>

        <div className="grid gap-3 sm:grid-cols-[minmax(220px,1fr)_180px_180px]">
          <Input
            type="search"
            aria-label="搜索日志"
            placeholder="搜索对象、ID 或内容"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
          <Select value={purpose} onValueChange={(value) => setPurpose(value as PurposeFilter)}>
            <SelectTrigger aria-label="筛选日志类型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              <SelectItem value="member_left_notification">退群通知</SelectItem>
              <SelectItem value="scheduled_report">定时日报</SelectItem>
              <SelectItem value="other">其它动作</SelectItem>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
            <SelectTrigger aria-label="筛选日志状态">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="sent">已发送</SelectItem>
              <SelectItem value="failed">失败</SelectItem>
              <SelectItem value="blocked">被阻止</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <div className="flex min-h-40 items-center justify-center">
            <Spinner label="正在加载日志" />
          </div>
        ) : error ? (
          <EmptyState title="日志读取失败" description={error} />
        ) : visibleEntries.length ? (
          <section className="grid gap-3" aria-label="操作日志列表">
            {visibleEntries.map((entry) => {
              const result = statusDetails(entry)
              const recipient = entry.recipientName || entry.recipientId
              return (
                <article
                  key={entry.id}
                  className="grid gap-3 rounded-md border border-border-subtle bg-surface px-4 py-3 shadow-surface"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <strong className="text-sm text-foreground">{purposeLabel(entry.purpose)}</strong>
                      <p className="mt-1 break-words text-sm text-foreground">发送给 {recipient}</p>
                    </div>
                    <div className="text-right text-xs">
                      <strong className={result.className}>{result.label}</strong>
                      <time className="mt-1 block text-muted-foreground" dateTime={entry.timestamp}>
                        {new Date(entry.timestamp).toLocaleString('zh-CN', { hour12: false })}
                      </time>
                    </div>
                  </div>
                  <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-[140px_1fr]">
                    <span>
                      {entry.recipientType === 'group' ? '群聊' : '联系人'} · {entry.recipientId}
                    </span>
                    <span className="break-words">
                      {contentTypeLabel(entry.contentType)} · {entry.contentPreview || '无内容预览'}
                    </span>
                  </div>
                  {entry.reason ? (
                    <p className="break-words text-xs text-muted-foreground">{entry.reason}</p>
                  ) : null}
                </article>
              )
            })}
          </section>
        ) : (
          <EmptyState
            title={entries.length ? '没有匹配的日志' : '暂无日志'}
            description={entries.length ? '请调整搜索或筛选条件。' : undefined}
          />
        )}
      </div>
    </div>
  )
}
