import React, { useMemo, useState } from 'react'
import type { Contact, Message } from '../../../../shared/types'
import type {
  ExportJobProgress,
  ExportMessageKind,
  ExportNameMode
} from '../../../../shared/export'

type ExportRange = 'today' | 'threeDays' | 'sevenDays' | 'custom'
type ExportFormat = 'html' | 'csv' | 'json' | 'markdown'
type ExportStatus = 'idle' | 'running' | 'completed'

interface GroupMemberName {
  wxid: string
  nickname: string
  groupNickname: string
  wechatNickname: string
  remark: string
  avatar: string
}

interface SelfInfo {
  wxid: string
  nickname: string
  avatar?: string
  accountRoot: string
}

interface ExportWorkspaceProps {
  contacts: Contact[]
  selectedContact: Contact | null
  previewMessages: Message[]
  selfInfo: SelfInfo | null
  dbReady: boolean
  onSelectContact: (contact: Contact) => void
  onOpenSettings: () => void
}

const messageKinds = [
  ['text', '文字'],
  ['image', '图片'],
  ['video', '视频'],
  ['voice', '语音'],
  ['sticker', '表情包'],
  ['share', '链接与分享'],
  ['location', '位置'],
  ['system', '系统消息']
] as const

const formatLabels: Record<ExportFormat, { label: string; hint?: string }> = {
  html: { label: 'HTML', hint: '推荐' },
  csv: { label: 'CSV' },
  json: { label: 'JSON' },
  markdown: { label: 'Markdown' }
}

function displayName(contact: Contact | null): string {
  return contact?.m_nsNickName || contact?.m_nsUsrName || '未选择会话'
}

function formatPreviewTime(message: Message): string {
  if (!message.createTime) return message.datetime || ''
  return new Date(message.createTime * 1000).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function ExportWorkspace({
  contacts,
  selectedContact,
  previewMessages,
  selfInfo,
  dbReady,
  onSelectContact,
  onOpenSettings
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
  const [format, setFormat] = useState<ExportFormat>('html')
  const [zip, setZip] = useState(false)
  const [fileName, setFileName] = useState('')
  const [status, setStatus] = useState<ExportStatus>('idle')
  const [jobId, setJobId] = useState('')
  const [progress, setProgress] = useState<ExportJobProgress | null>(null)

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
  const activeName = displayName(activeContact)
  const preview = previewMessages.slice(-20)
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

  React.useEffect(() => {
    setNameMode(activeContact?.type === 'group' ? 'groupNickname' : 'remark')
    let cancelled = false
    if (!activeContact || activeContact.type !== 'group') {
      setGroupMembers([])
      return () => {
        cancelled = true
      }
    }
    void window.api.getGroupSnapshot(activeContact.md5).then((snapshot) => {
      if (!cancelled) setGroupMembers((snapshot?.members || []) as GroupMemberName[])
    })
    return () => {
      cancelled = true
    }
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
      avatarUrls,
      nameMode,
      nameMap,
      zip
    }
    const result = await window.api.startExport(request)
    if (!result.success && result.error !== '已取消') setStatus('idle')
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

  const targetPath =
    format === 'html'
      ? zip
        ? `文稿/WechatExplorer/导出/${outputName}.zip`
        : `文稿/WechatExplorer/导出/${outputName}/`
      : `文稿/WechatExplorer/导出/${outputName}.${format === 'markdown' ? 'md' : format}`

  return (
    <div className="export-workspace">
      <aside className="export-contact-panel">
        <div className="export-panel-header">
          <div className="export-panel-title-row">
            <h2>选择聊天</h2>
            <span className="export-count-badge">共 {contacts.length.toLocaleString()} 个</span>
          </div>
          <label className="export-search-field">
            <span aria-hidden>⌕</span>
            <input
              value={contactFilter}
              onChange={(event) => setContactFilter(event.target.value)}
              placeholder="搜索群聊、联系人或 wxid"
              aria-label="搜索聊天"
            />
          </label>
          <div className="export-filter-tabs" role="tablist" aria-label="聊天类型">
            {(
              [
                ['all', '全部'],
                ['group', '群聊'],
                ['user', '联系人']
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={contactType === value ? 'active' : ''}
                onClick={() => setContactType(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="export-contact-list">
          {filteredContacts.map((contact) => {
            const name = displayName(contact)
            return (
              <button
                key={contact.md5}
                type="button"
                className={`export-contact-item ${activeContact?.md5 === contact.md5 ? 'active' : ''}`}
                onClick={() => onSelectContact(contact)}
              >
                <span className="export-contact-avatar">
                  {contact.avatar ? <img src={contact.avatar} alt="" /> : name.slice(0, 1)}
                </span>
                <span className="export-contact-copy">
                  <strong>{name}</strong>
                  <small>{contact.type === 'group' ? '群聊' : '联系人'}</small>
                </span>
              </button>
            )
          })}
        </div>

        <button type="button" className="export-account-summary" onClick={onOpenSettings}>
          <span className="export-account-avatar">
            {selfInfo?.avatar ? (
              <img src={selfInfo.avatar} alt="" />
            ) : (
              (selfInfo?.nickname || '我').slice(0, 1)
            )}
          </span>
          <span>
            <strong>{selfInfo?.nickname || '当前账号'}</strong>
            <small className={dbReady ? 'ready' : ''}>
              {dbReady ? '数据库已连接' : '数据库未连接'}
            </small>
          </span>
        </button>
      </aside>

      <main className="export-config-panel">
        <div className="export-config-scroll">
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
                <label key={value} className="export-check-row">
                  <input
                    type="checkbox"
                    checked={selectedKinds.has(value)}
                    onChange={() => toggleKind(value)}
                  />
                  <span>{label}</span>
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
                onChange={(event) => setIncludeMedia(event.target.checked)}
              />
            </label>
            <div className={`export-media-options ${includeMedia ? '' : 'disabled'}`}>
              <label className="export-check-row">
                <input
                  type="checkbox"
                  checked={preferOriginal}
                  disabled={!includeMedia}
                  onChange={(event) => setPreferOriginal(event.target.checked)}
                />
                <span>优先导出原图</span>
              </label>
              <label className="export-check-row">
                <input
                  type="checkbox"
                  checked={fallbackThumbnail}
                  disabled={!includeMedia}
                  onChange={(event) => setFallbackThumbnail(event.target.checked)}
                />
                <span>原图缺失时使用缩略图</span>
              </label>
              <label className="export-check-row">
                <input
                  type="checkbox"
                  checked={keepMissing}
                  disabled={!includeMedia}
                  onChange={(event) => setKeepMissing(event.target.checked)}
                />
                <span>媒体缺失时保留占位说明</span>
              </label>
            </div>
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
              {(Object.keys(formatLabels) as ExportFormat[]).map((value) => (
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

      <aside className={`export-preview-panel ${status !== 'idle' ? `status-${status}` : ''}`}>
        {status === 'idle' && (
          <>
            <div className="export-preview-heading">
              <strong>导出预览</strong>
              <span>仅预览最近 20 条</span>
            </div>
            <div className="export-message-preview">
              <div className="export-preview-date">最近消息</div>
              {(preview.length
                ? preview
                : [
                    {
                      id: 'empty',
                      from: 'user',
                      content: '导出预览将在这里显示',
                      type: '文字',
                      datetime: '',
                      isSender: false
                    }
                  ]
              ).map((message) => (
                <div
                  key={message.id}
                  className={`export-preview-message ${message.isSender ? 'mine' : ''}`}
                >
                  <span className="export-preview-avatar">
                    {message.img || (message.isSender && selfInfo?.avatar) ? (
                      <img src={message.isSender ? selfInfo?.avatar : message.img} alt="" />
                    ) : (
                      (message.isSender ? '我' : message.name || '友').slice(0, 1)
                    )}
                  </span>
                  <span className="export-preview-bubble">
                    <small>
                      {message.name || (message.isSender ? '我' : '联系人')} ·{' '}
                      {formatPreviewTime(message)}
                    </small>
                    {message.content || `[${message.type}]`}
                  </span>
                </div>
              ))}
            </div>
            <div className="export-preview-stats">
              <span>
                消息总数<strong>待统计</strong>
              </span>
              <span>
                媒体文件<strong>待统计</strong>
              </span>
              <span>
                预计大小<strong>待统计</strong>
              </span>
            </div>
          </>
        )}
        {status === 'running' && (
          <div className="export-job-state">
            <h2>正在导出</h2>
            <p>导出任务在后台运行，不影响档案浏览。</p>
            <ol>
              <li className="done">准备导出</li>
              <li className="current">
                {progress?.phase === 'writing' ? '生成档案' : '分批读取聊天记录'}
              </li>
              <li>解析消息内容</li>
              <li>处理媒体资源</li>
              <li>生成档案</li>
            </ol>
            <div className="export-progress-bar" aria-label="导出进度">
              <span style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
            <strong>
              {progress?.phase === 'writing'
                ? `正在写入 ${progress.processed.toLocaleString()} 条消息... ${progress.percent ?? 0}%`
                : `正在读取消息... ${progress?.percent ?? 0}%`}
            </strong>
            <button
              type="button"
              className="export-cancel-button"
              onClick={() => {
                void window.api.cancelExport(jobId)
                setStatus('idle')
              }}
            >
              取消导出
            </button>
          </div>
        )}
        {status === 'completed' && (
          <div className="export-job-state completed">
            <div className="export-success-icon">✓</div>
            <h2>导出完成</h2>
            <p>聊天档案已成功保存。</p>
            <div className="export-complete-summary">
              <span>
                导出消息<strong>{progress?.processed.toLocaleString() || '已完成'}</strong>
              </span>
              <span>
                媒体资源<strong>按设置处理</strong>
              </span>
              <span>
                输出位置<strong>已保存</strong>
              </span>
            </div>
            <button
              type="button"
              className="export-primary-button"
              onClick={() =>
                progress?.outputPath && void window.api.revealExport(progress.outputPath)
              }
            >
              打开档案
            </button>
            <button
              type="button"
              className="export-open-folder-button"
              onClick={() =>
                progress?.outputPath && void window.api.revealExport(progress.outputPath)
              }
            >
              在文件夹中显示
            </button>
          </div>
        )}
      </aside>
    </div>
  )
}
