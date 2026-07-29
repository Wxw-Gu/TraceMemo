import React, { useMemo, useState } from 'react'
import type { Message } from '../../../../shared/types'
import type {
  ExportJobProgress,
  ExportMessageKind,
  ExportNameMode
} from '../../../../shared/export'
import { ExportContactPanel } from './ExportContactPanel'
import { ExportPreviewPanel } from './ExportPreviewPanel'
import { ExportTaskCenter } from './ExportTaskCenter'
import type {
  ExportFormat,
  ExportRange,
  ExportStatus,
  ExportWorkspaceProps,
  GroupMemberName
} from './exportTypes'
import { displayName, formatLabels, formatOrder, messageKinds } from './exportUtils'

export function ExportWorkspace({
  contacts,
  selectedContact,
  previewMessages,
  selfInfo,
  dbReady,
  onSelectContact,
  onOpenSettings,
  exportTasks,
  onStartExport,
  onCancelExport
}: ExportWorkspaceProps): React.ReactElement {
  const [contactFilter, setContactFilter] = useState('')
  const [contactType, setContactType] = useState<'all' | 'group' | 'user'>('all')
  const [range, setRange] = useState<ExportRange>('today')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [selectedKinds, setSelectedKinds] = useState<Set<string>>(() => new Set(['text']))
  const [nameMode, setNameMode] = useState<ExportNameMode>('remark')
  const [groupMembers, setGroupMembers] = useState<GroupMemberName[]>([])
  const [includeMedia, setIncludeMedia] = useState(true)
  const [includeAvatars, setIncludeAvatars] = useState(true)
  const [preferOriginal, setPreferOriginal] = useState(true)
  const [fallbackThumbnail, setFallbackThumbnail] = useState(true)
  const [keepMissing, setKeepMissing] = useState(false)
  const [format, setFormat] = useState<ExportFormat>('csv')
  const [zip, setZip] = useState(false)
  const [fileName, setFileName] = useState('')
  const [status, setStatus] = useState<ExportStatus>('idle')
  const [jobId, setJobId] = useState('')
  const [progress, setProgress] = useState<ExportJobProgress | null>(null)
  const [taskCenterOpen, setTaskCenterOpen] = useState(false)

  const filteredContacts = useMemo(() => {
    const keyword = contactFilter.trim().toLowerCase()
    return contacts.filter((contact) => {
      if (contactType !== 'all' && contact.type !== contactType) return false
      if (!keyword) return true
      return [contact.m_nsNickName, contact.m_nsUsrName].some((value) =>
        value.toLowerCase().includes(keyword)
      )
    })
  }, [contactFilter, contactType, contacts])

  const activeContact = selectedContact || filteredContacts[0] || contacts[0] || null
  const currentTask = exportTasks.find((task) => task.contactId === activeContact?.md5)
  const taskCount = exportTasks.filter((task) => task.status === 'running').length
  const activeName = displayName(activeContact)
  const preview = previewMessages.slice(-20)
  const previewMediaCount = preview.filter((message) =>
    ['image', 'video', 'voice', 'sticker'].includes(message.contentData?.type || '')
  ).length
  const previewBytes = preview.reduce(
    (total, message) => total + (message.content?.length || 0) * 2 + (message.img ? 1024 : 0),
    0
  )
  const outputName = fileName.trim() || `${activeName}_聊天档案`
  const nameOptions: { value: ExportNameMode; label: string }[] =
    activeContact?.type === 'group'
      ? [
          { value: 'groupNickname', label: '群昵称' },
          { value: 'remark', label: '备注' },
          { value: 'wechatNickname', label: '微信名' }
        ]
      : [
          { value: 'remark', label: '备注' },
          { value: 'wechatNickname', label: '微信名' }
        ]

  const nameMap = useMemo(() => {
    const map: Record<string, string> = {}
    if (activeContact?.type === 'group') {
      for (const member of groupMembers) {
        const value =
          nameMode === 'groupNickname'
            ? member.groupNickname || member.nickname || member.wxid
            : nameMode === 'remark'
              ? member.remark || member.wechatNickname || member.wxid
              : member.wechatNickname || member.wxid
        map[member.wxid] = value
      }
    } else if (activeContact) {
      map[activeContact.m_nsUsrName] =
        nameMode === 'remark'
          ? activeContact.remark || activeContact.m_nsNickName || activeContact.m_nsUsrName
          : activeContact.wechatNickname || activeContact.m_nsUsrName
    }
    if (selfInfo?.wxid) map[selfInfo.wxid] = selfInfo.nickname || selfInfo.wxid
    return map
  }, [activeContact, groupMembers, nameMode, selfInfo])

  const avatarUrls = useMemo(() => {
    const map: Record<string, string> = {}
    if (activeContact?.m_nsUsrName && activeContact.avatar) {
      map[activeContact.m_nsUsrName] = activeContact.avatar
    }
    for (const member of groupMembers) {
      if (member.avatar) map[member.wxid] = member.avatar
    }
    if (selfInfo?.wxid && selfInfo.avatar) map[selfInfo.wxid] = selfInfo.avatar
    return map
  }, [activeContact, groupMembers, selfInfo])

  const previewName = (message: Message): string =>
    (message.senderId && nameMap[message.senderId]) ||
    message.name ||
    (message.isSender ? selfInfo?.nickname : undefined) ||
    (message.isSender ? '我' : '联系人')
  const previewAvatar = (message: Message): string | undefined =>
    (message.senderId && avatarUrls[message.senderId]) ||
    message.img ||
    (message.isSender ? selfInfo?.avatar : undefined)
  const previewItems = preview.map((message) => ({
    ...message,
    name: previewName(message),
    img: previewAvatar(message)
  }))

  React.useEffect(() => {
    setNameMode(activeContact?.type === 'group' ? 'groupNickname' : 'remark')
    setGroupMembers([])
    if (!activeContact || activeContact.type !== 'group') return
    const timer = window.setTimeout(() => {
      void window.api.getGroupSnapshot(activeContact.md5).then((snapshot) => {
        setGroupMembers((snapshot?.members || []) as GroupMemberName[])
      })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [activeContact])

  const toggleKind = (value: string): void => {
    setSelectedKinds((current) => {
      const next = new Set(current)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  const handleStart = async (): Promise<void> => {
    if (!activeContact || status === 'running') return
    const nextJobId = `export-${Date.now()}`
    setJobId(nextJobId)
    setProgress(null)
    setStatus('running')
    let exportNameMap = nameMap
    let exportAvatarUrls = avatarUrls
    if (activeContact.type === 'group') {
      const snapshot = await window.api.getGroupSnapshot(activeContact.md5)
      const members = (snapshot?.members || []) as GroupMemberName[]
      setGroupMembers(members)
      exportNameMap = { ...nameMap }
      exportAvatarUrls = { ...avatarUrls }
      for (const member of members) {
        exportNameMap[member.wxid] =
          nameMode === 'groupNickname'
            ? member.groupNickname || member.nickname || member.wxid
            : nameMode === 'remark'
              ? member.remark || member.wechatNickname || member.wxid
              : member.wechatNickname || member.wxid
        if (member.avatar) exportAvatarUrls[member.wxid] = member.avatar
      }
    }
    const now = new Date()
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const days = range === 'today' ? 1 : range === 'threeDays' ? 3 : range === 'sevenDays' ? 7 : 0
    const startOfRange = days
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1)
      : null
    const request = {
      jobId: nextJobId,
      userMd5: activeContact.md5,
      name: activeName,
      format,
      outputName,
      startTime: startOfRange
        ? Math.floor(startOfRange.getTime() / 1000)
        : range === 'custom' && startDate
          ? Math.floor(new Date(startDate).getTime() / 1000)
          : undefined,
      endTime: startOfRange
        ? Math.floor(endOfToday.getTime() / 1000)
        : range === 'custom' && endDate
          ? Math.floor(new Date(endDate).getTime() / 1000)
          : undefined,
      kinds: Array.from(selectedKinds) as ExportMessageKind[],
      includeMedia,
      includeAvatars,
      avatarUrls: exportAvatarUrls,
      nameMode,
      nameMap: exportNameMap,
      zip
    }
    const result = await onStartExport(request)
    if (result.success) {
      setProgress((current) => ({
        ...(current || { jobId: nextJobId, processed: result.messageCount || 0 }),
        phase: 'completed',
        processed: result.messageCount ?? current?.processed ?? 0,
        total: result.messageCount ?? current?.total,
        percent: 100,
        outputPath: result.outputPath
      }))
      setStatus('completed')
    } else if (result.error !== '已取消') {
      setStatus('idle')
    }
  }

  React.useEffect(
    () =>
      window.api.onExportProgress((next) => {
        if (next.jobId !== jobId) return
        setProgress(next)
        if (next.phase === 'completed') setStatus('completed')
        if (next.phase === 'cancelled' || next.phase === 'failed') setStatus('idle')
      }),
    [jobId]
  )

  React.useEffect(() => {
    if (!currentTask) return
    setJobId(currentTask.jobId)
    setProgress(currentTask.progress)
    setStatus(
      currentTask.status === 'running'
        ? 'running'
        : currentTask.status === 'completed'
          ? 'completed'
          : 'idle'
    )
  }, [currentTask])

  const targetPath =
    format === 'html'
      ? zip
        ? `文稿/WechatExplorer/导出/${outputName}.zip`
        : `文稿/WechatExplorer/导出/${outputName}/`
      : `文稿/WechatExplorer/导出/${outputName}.${format === 'markdown' ? 'md' : format}`

  return (
    <div className="export-workspace">
      <ExportContactPanel
        contacts={contacts}
        filteredContacts={filteredContacts}
        activeContact={activeContact}
        selfInfo={selfInfo}
        dbReady={dbReady}
        contactFilter={contactFilter}
        contactType={contactType}
        onContactFilterChange={setContactFilter}
        onContactTypeChange={setContactType}
        onSelectContact={onSelectContact}
        onOpenSettings={onOpenSettings}
      />

      <main className="export-config-panel">
        <div className="export-config-scroll">
          <ExportTaskCenter
            open={taskCenterOpen}
            taskCount={taskCount}
            tasks={exportTasks}
            onToggle={() => setTaskCenterOpen((open) => !open)}
            onCancel={(taskJobId) => void onCancelExport(taskJobId)}
          />
          <header className="export-config-header">
            <span className="export-chat-avatar">
              {activeContact?.avatar ? (
                <img src={activeContact.avatar} alt="" />
              ) : (
                activeName.slice(0, 1)
              )}
            </span>
            <span>
              <h1>导出设置</h1>
              <p>
                {activeName}
                {activeContact?.type === 'group' ? ' · 群聊' : ''}
              </p>
            </span>
          </header>

          <section className="export-section export-format-top">
            <h3>导出格式</h3>
            <div className="export-format-grid">
              {formatOrder.map((value) => (
                <button key={value} type="button" className={format === value ? 'active' : ''} onClick={() => setFormat(value)}>
                  <strong>{formatLabels[value].label}</strong>
                  {formatLabels[value].hint && <small>{formatLabels[value].hint}</small>}
                </button>
              ))}
            </div>
            <p className="export-helper-text">CSV 默认最快；HTML 会包含图片、引用和其他媒体，导出时间可能较长。</p>
            {format === 'html' && (
              <div className="export-html-options">
                <label>
                  <input type="radio" name="html-package-top" checked={!zip} onChange={() => setZip(false)} /> HTML 资源包
                </label>
                <label>
                  <input type="radio" name="html-package-top" checked={zip} onChange={() => setZip(true)} /> HTML 资源包并压缩为 ZIP
                </label>
              </div>
            )}
          </section>

          <section className="export-section">
            <div className="export-section-heading">
              <h3>时间范围</h3>
              <span>{status === 'completed' ? '已完成导出' : '消息数量将在开始导出后统计'}</span>
            </div>
            <div className="export-range-toggle">
              <button
                type="button"
                className={range === 'today' ? 'active' : ''}
                onClick={() => setRange('today')}
              >
                今天
              </button>
              <button
                type="button"
                className={range === 'threeDays' ? 'active' : ''}
                onClick={() => setRange('threeDays')}
              >
                最近 3 天
              </button>
              <button
                type="button"
                className={range === 'sevenDays' ? 'active' : ''}
                onClick={() => setRange('sevenDays')}
              >
                最近 7 天
              </button>
              <button
                type="button"
                className={range === 'custom' ? 'active' : ''}
                onClick={() => setRange('custom')}
              >
                自定义时间
              </button>
            </div>
            {range === 'custom' && (
              <div className="export-date-fields">
                <label>
                  开始时间
                  <input
                    type="datetime-local"
                    value={startDate}
                    onChange={(event) => setStartDate(event.target.value)}
                  />
                </label>
                <label>
                  结束时间
                  <input
                    type="datetime-local"
                    value={endDate}
                    onChange={(event) => setEndDate(event.target.value)}
                  />
                </label>
              </div>
            )}
          </section>

          <section className="export-section">
            <h3>消息内容</h3>
            <div className="export-kind-grid">
              {messageKinds.map(([value, label]) => (
                <label key={value} className={`export-check-row ${value === 'video' ? 'unsupported' : ''}`}>
                  <input
                    type="checkbox"
                    checked={value !== 'video' && selectedKinds.has(value)}
                    disabled={value === 'video'}
                    onChange={() => toggleKind(value)}
                  />
                  <span>{label}</span>
                  {value === 'video' && (
                    <span className="export-unsupported-hint" title="当前版本暂不支持视频导出" aria-label="当前版本暂不支持视频导出">
                      !
                    </span>
                  )}
                </label>
              ))}
            </div>
          </section>

          <section className="export-section">
            <h3>消息显示名称</h3>
            <div className="export-name-mode-grid" role="radiogroup" aria-label="消息显示名称">
              {nameOptions.map((option) => (
                <label key={option.value} className="export-name-mode-option">
                  <input
                    type="radio"
                    name="export-name-mode"
                    checked={nameMode === option.value}
                    onChange={() => setNameMode(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="export-section">
            <h3>资源处理</h3>
            <label className="export-media-master">
              <span>包含图片、视频、语音及动态表情</span>
              <input
                type="checkbox"
                  checked={includeMedia}
                  disabled={format !== 'html'}
                onChange={(event) => setIncludeMedia(event.target.checked)}
              />
            </label>
            <div className={`export-media-options ${includeMedia && format === 'html' ? '' : 'disabled'}`}>
              <label className="export-check-row">
                <input
                  type="checkbox"
                  checked={preferOriginal}
                  disabled={!includeMedia || format !== 'html'}
                  onChange={(event) => setPreferOriginal(event.target.checked)}
                />
                <span>优先导出原图</span>
              </label>
              <label className="export-check-row">
                <input
                  type="checkbox"
                  checked={fallbackThumbnail}
                  disabled={!includeMedia || format !== 'html'}
                  onChange={(event) => setFallbackThumbnail(event.target.checked)}
                />
                <span>原图缺失时使用缩略图</span>
              </label>
              <label className="export-check-row">
                <input
                  type="checkbox"
                  checked={keepMissing}
                  disabled={!includeMedia || format !== 'html'}
                  onChange={(event) => setKeepMissing(event.target.checked)}
                />
                <span>媒体缺失时保留占位说明</span>
              </label>
            </div>
            <p className="export-helper-text">资源文件仅在 HTML 导出中生效，CSV、JSON 和 Markdown 只保留文本内容。</p>
            <div className="export-resource-statuses">
              <span>图片解密：已就绪</span>
              <span>视频资源：可用</span>
              <span>语音资源：可用</span>
              <span>表情资源：按需解析</span>
            </div>
            <p className="export-helper-text">媒体资源会延长导出时间，缺失资源不会中断任务。</p>
            <label className="export-media-master">
              <span>在聊天气泡旁显示头像</span>
              <input
                type="checkbox"
                checked={includeAvatars}
                onChange={(event) => setIncludeAvatars(event.target.checked)}
              />
            </label>
          </section>

          <section className="export-section">
            <h3>导出格式</h3>
            <div className="export-format-grid">
              {formatOrder.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={format === value ? 'active' : ''}
                  onClick={() => setFormat(value)}
                >
                  <strong>{formatLabels[value].label}</strong>
                  {formatLabels[value].hint && <small>{formatLabels[value].hint}</small>}
                </button>
              ))}
            </div>
            {format === 'html' && (
              <div className="export-html-options">
                <label>
                  <input
                    type="radio"
                    name="html-package"
                    checked={!zip}
                    onChange={() => setZip(false)}
                  />{' '}
                  HTML 资源包（推荐）
                </label>
                <label>
                  <input
                    type="radio"
                    name="html-package"
                    checked={zip}
                    onChange={() => setZip(true)}
                  />{' '}
                  HTML 资源包并压缩为 ZIP
                </label>
              </div>
            )}
          </section>

          <section className="export-section export-save-section">
            <h3>保存设置</h3>
            <label>
              文件名称
              <input
                value={fileName}
                onChange={(event) => setFileName(event.target.value)}
                placeholder={`${activeName}_聊天档案`}
              />
            </label>
            <div className="export-target-path">
              <span>保存位置</span>
              <strong>{targetPath}</strong>
              <button type="button">选择位置</button>
            </div>
          </section>
        </div>
        <footer className="export-action-bar">
          <span className={`export-ready-dot ${status === 'completed' ? 'completed' : ''}`} />
          <span>
            {status === 'running'
              ? '正在后台导出'
              : status === 'completed'
                ? '导出完成'
                : '准备就绪'}
          </span>
          <span className="export-target-summary">路径：{targetPath}</span>
          <button type="button" className="export-reset-button" onClick={() => setStatus('idle')}>
            恢复默认
          </button>
          <button
            type="button"
            className="export-primary-button"
            disabled={!activeContact || status === 'running'}
            onClick={handleStart}
          >
            {status === 'running' ? '正在导出' : status === 'completed' ? '再次导出' : '开始导出'}
          </button>
        </footer>
      </main>

      <ExportPreviewPanel
        status={status}
        previewItems={previewItems}
        previewMediaCount={previewMediaCount}
        previewBytes={previewBytes}
        selfInfo={selfInfo}
        progress={progress}
        jobId={jobId}
        onCancel={(exportJobId) => {
          void window.api.cancelExport(exportJobId)
          setStatus('idle')
        }}
        onReveal={(path) => void window.api.revealExport(path)}
      />
    </div>
  )
}
