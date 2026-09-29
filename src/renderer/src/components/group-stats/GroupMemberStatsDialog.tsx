import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { Contact } from '../../../../shared/types'
import {
  GROUP_STATS_RANGE_OPTIONS,
  formatActiveMemberStats,
  formatMemberLineName,
  formatSilentMemberStats,
  formatStatsDateTime,
  resolveGroupStatsRangeStart,
  type GroupMemberStatsResult,
  type GroupStatsRangeKey
} from '../../../../shared/group-stats'
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Tabs, TabsContent, TabsList, TabsTrigger } from '../ui'

interface GroupMemberStatsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contact: Contact
  /** 跳到「设置 · 本地索引」，让用户能把没追平的索引处理掉。 */
  onOpenLocalIndexSettings?: () => void
}

type CopyTarget = 'none' | 'active' | 'silent'

/**
 * 群发言统计面板（单群）。
 *
 * - **结果**由 main 的 `GroupStatsService` 给出，组件只展示，不自己拼业务文本；
 * - **可复制的文本**由 `shared/group-stats` 的 formatter 生成，保证「界面上看到的」
 *   与「复制出去的」不会各说各话；
 * - **名单不截断**：数字与列表必须能对上，否则用户会以为统计漏了人。
 *   列表靠 CSS 限高滚动，不靠丢数据。
 */
export function GroupMemberStatsDialog({
  open,
  onOpenChange,
  contact,
  onOpenLocalIndexSettings
}: GroupMemberStatsDialogProps): React.ReactElement {
  const [rangeKey, setRangeKey] = useState<GroupStatsRangeKey>('30d')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [result, setResult] = useState<GroupMemberStatsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<CopyTarget>('none')
  const [notice, setNotice] = useState<string | null>(null)
  /** 发送能力必须由 main 判定：renderer 侧的 platform 常量会误判 macOS Intel。 */
  const [canSendText, setCanSendText] = useState(false)
  const [sending, setSending] = useState(false)

  const timeWindow = useMemo(() => {
    if (rangeKey === 'custom') {
      const start = customStart ? new Date(`${customStart}T00:00:00`).getTime() : NaN
      const end = customEnd ? new Date(`${customEnd}T23:59:59.999`).getTime() : NaN
      return { startTime: start, endTime: end }
    }
    const endTime = Date.now()
    return { startTime: resolveGroupStatsRangeStart(rangeKey, endTime), endTime }
  }, [rangeKey, customStart, customEnd])

  const rangeReady = Number.isFinite(timeWindow.startTime) && Number.isFinite(timeWindow.endTime)

  useEffect(() => {
    if (!open || !rangeReady || !contact.md5) return
    let disposed = false
    setLoading(true)
    setError(null)
    window.api
      .getGroupMemberStats({
        userMd5: contact.md5,
        startTime: timeWindow.startTime,
        endTime: timeWindow.endTime
      })
      .then((data) => {
        if (!disposed) setResult(data)
      })
      .catch((loadError: unknown) => {
        if (!disposed) setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [open, rangeReady, contact.md5, timeWindow.startTime, timeWindow.endTime])

  useEffect(() => {
    if (!open) return
    let disposed = false
    window.api
      .getPersonalWechatSenderStatus()
      .then((status) => {
        if (!disposed) setCanSendText(status?.canSendText === true)
      })
      .catch(() => {
        if (!disposed) setCanSendText(false)
      })
    return () => {
      disposed = true
    }
  }, [open])

  const silentText = useMemo(() => (result ? formatSilentMemberStats(result) : ''), [result])
  const activeText = useMemo(() => (result ? formatActiveMemberStats(result) : ''), [result])

  const copy = useCallback(async (text: string, target: CopyTarget) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(target)
      setNotice(null)
      setTimeout(() => setCopied('none'), 2000)
    } catch {
      setError('复制失败，请手动选择文本')
    }
  }, [])

  const send = useCallback(
    async (text: string) => {
      if (!text || sending) return
      setSending(true)
      setNotice(null)
      try {
        await window.api.sendPersonalWechatMessage({
          to: contact.m_nsUsrName,
          isGroup: true,
          type: 'text',
          text
        })
        setNotice('已发送到当前群')
      } catch (sendError: unknown) {
        setError(sendError instanceof Error ? sendError.message : '发送失败')
      } finally {
        setSending(false)
      }
    },
    [contact.m_nsUsrName, sending]
  )

  const stale = result !== null && result.freshness !== 'fresh'
  const groupTitle = contact.m_nsNickName || contact.m_nsUsrName
  /** 备注与群名相同时不重复展示，避免标题里出现两遍同一个人。 */
  const groupRemark = contact.remark && contact.remark !== groupTitle ? contact.remark : ''
  /** 选「全部」时 startTime 为 0，改用本机第一条消息的真实时间作为起点。 */
  const rangeStart = result
    ? result.startTime > 0
      ? result.startTime
      : result.firstMessageTime
    : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>群发言统计 · {groupTitle}</DialogTitle>
          {groupRemark ? (
            <p className="group-stats-subtitle">群备注：{groupRemark}</p>
          ) : null}
        </DialogHeader>

        <div className="group-stats-panel">
          <div className="group-stats-ranges">
            {GROUP_STATS_RANGE_OPTIONS.map((option) => (
              <Button
                key={option.key}
                variant={rangeKey === option.key ? 'default' : 'outline'}
                size="sm"
                onClick={() => setRangeKey(option.key)}
              >
                {option.label}
              </Button>
            ))}
            {rangeKey === 'custom' ? (
              <div className="group-stats-custom-range">
                <input
                  type="date"
                  aria-label="开始日期"
                  value={customStart}
                  onChange={(event) => setCustomStart(event.target.value)}
                />
                <span>至</span>
                <input
                  type="date"
                  aria-label="结束日期"
                  value={customEnd}
                  onChange={(event) => setCustomEnd(event.target.value)}
                />
              </div>
            ) : null}
          </div>

          {!rangeReady ? (
            <p className="group-stats-hint">请选择完整的开始与结束日期。</p>
          ) : null}
          {stale ? (
            <div className="group-stats-stale">
              <p role="alert" className="group-stats-warning">
                本地索引尚未完全同步，以下结果可能不完整。
              </p>
              {onOpenLocalIndexSettings ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    // 先关面板再跳转：否则设置页会被这个 Dialog 挡在后面。
                    onOpenChange(false)
                    onOpenLocalIndexSettings()
                  }}
                >
                  去建立索引
                </Button>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="group-stats-error">
              {error}
            </p>
          ) : null}
          {notice ? <p className="group-stats-notice">{notice}</p> : null}

          {loading ? <p className="group-stats-hint">统计中…</p> : null}

          {result && !loading ? (
            <>
              <div className="group-stats-overview">
                <div className="group-stats-metric">
                  <div className="group-stats-metric-label">当前群成员</div>
                  <div className="group-stats-metric-value">{result.memberCount}</div>
                </div>
                <div className="group-stats-metric">
                  <div className="group-stats-metric-label">发过言</div>
                  <div className="group-stats-metric-value">{result.activeMemberCount}</div>
                </div>
                <div className="group-stats-metric">
                  <div className="group-stats-metric-label">没发言</div>
                  <div className="group-stats-metric-value">{result.silentMemberCount}</div>
                </div>
              </div>

              <p className="group-stats-range-text">
                统计区间：
                {rangeStart
                  ? `${formatStatsDateTime(rangeStart)} ～ ${formatStatsDateTime(result.endTime)}`
                  : `全部历史 ～ ${formatStatsDateTime(result.endTime)}`}
                {result.startTime <= 0 && rangeStart ? '（本机该群第一条消息起）' : null}
              </p>

              {/* 两个名单用 tab 分开：一次只渲染一个列表，滚动压力减半，
                  而且「复制/发送」跟它作用的内容处在同一个 tab 里，不会看错对象。 */}
              <Tabs defaultValue="active" className="group-stats-tabs">
                <TabsList className="group-stats-tabs-list">
                  <TabsTrigger value="active">
                    发言排行（{result.activeMemberCount}）
                  </TabsTrigger>
                  <TabsTrigger value="silent">
                    未发言统计（{result.silentMemberCount}）
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="active">
                  <div className="group-stats-section">
                    <div className="group-stats-section-head">
                      <h3>
                        发言成员排行
                        <span className="group-stats-section-count">
                          （共 {result.activeMemberCount} 人）
                        </span>
                      </h3>
                      <div className="group-stats-section-actions">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void copy(activeText, 'active')}
                        >
                          {copied === 'active' ? '已复制' : '复制'}
                        </Button>
                      </div>
                    </div>
                    {result.activeMembers.length === 0 ? (
                      <p className="group-stats-empty">该区间内没有人发言。</p>
                    ) : (
                      <ol className="group-stats-list">
                        {result.activeMembers.map((member, index) => (
                          <li key={member.senderId} className="group-stats-row">
                            <span className="group-stats-row-name">
                              <span className="group-stats-row-index">{index + 1}.</span>
                              {formatMemberLineName(member)}
                            </span>
                            <span className="group-stats-row-meta">
                              {member.messageCount} 条 ·{' '}
                              {formatStatsDateTime(member.lastMessageTime)}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="silent">
                  <div className="group-stats-section">
                    <div className="group-stats-section-head">
                      <h3>
                        未发言成员
                        <span className="group-stats-section-count">
                          （共 {result.silentMemberCount} 人）
                        </span>
                      </h3>
                      <div className="group-stats-section-actions">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void copy(silentText, 'silent')}
                        >
                          {copied === 'silent' ? '已复制' : '复制'}
                        </Button>
                        {canSendText ? (
                          <Button
                            variant="default"
                            size="sm"
                            disabled={sending}
                            onClick={() => void send(silentText)}
                          >
                            {sending ? '发送中…' : '发送到当前群'}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    {result.silentMembers.length === 0 ? (
                      <p className="group-stats-empty">全部成员在该区间内都发过言。</p>
                    ) : (
                      <ol className="group-stats-list">
                        {result.silentMembers.map((member, index) => (
                          <li key={member.senderId} className="group-stats-row">
                            <span className="group-stats-row-name">
                              <span className="group-stats-row-index">{index + 1}.</span>
                              {formatMemberLineName(member)}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </TabsContent>
              </Tabs>

              <p className="group-stats-notes">
                {result.unattributedMessages > 0
                  ? `另有 ${result.unattributedMessages} 条消息无法归属到具体成员（未计入任何人）。`
                  : null}
                {result.excludedSystemMessages > 0
                  ? `已排除 ${result.excludedSystemMessages} 条系统消息。`
                  : null}
                {result.limitations.join(' ')}
              </p>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
