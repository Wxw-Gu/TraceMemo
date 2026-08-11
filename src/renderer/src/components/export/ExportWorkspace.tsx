import React, { useMemo, useState } from 'react'
import type { Message } from '../../../../shared/types'
import type {
  ExportContactType,
  ExportJobProgress,
  ExportMessageKind,
  ExportNameMode,
  ExportRequest,
  ExportTarget
} from '../../../../shared/export'
import { ExportContactPanel } from './ExportContactPanel'
import { ExportPreviewPanel } from './ExportPreviewPanel'
import { ExportTaskCenter } from './ExportTaskCenter'
import type {
  Contact,
  ExportFormat,
  ExportRange,
  ExportStatus,
  ExportWorkspaceProps,
  GroupMemberName
} from './exportTypes'
import { displayName, formatLabels, formatOrder, messageKinds } from './exportUtils'
import type { VoiceModelStatus } from '../../../../shared/voice-recognition'
import { resolveMemberName } from '../../../../shared/member-names'

const ALL_CONTACT_TYPES: ExportContactType[] = ['group', 'user']
const contactTypeKey = (types: ExportContactType[] | undefined): string =>
  [...(types?.length ? types : ALL_CONTACT_TYPES)].sort().join('|')

export function ExportWorkspace({
  contacts,
  initialContact,
  selfInfo,
  dbReady,
  loadPreviewMessages,
  onOpenSettings,
  exportTasks,
  onStartExport,
  onCancelExport
}: ExportWorkspaceProps): React.ReactElement {
  const initialSelection = initialContact || contacts[0] || null
  const runningAllTask = exportTasks.find(
    (task) => task.scope === 'all' && task.status === 'running'
  )
  const initialContactRef = React.useRef<Contact | null>(initialSelection)
  const previewLoadingRef = React.useRef(new Set<string>())
  const [contactFilter, setContactFilter] = useState('')
  const [contactType, setContactType] = useState<'all' | 'group' | 'user'>('all')
  const [selectionMode, setSelectionMode] = useState(false)
  const [exportAll, setExportAll] = useState(() => Boolean(runningAllTask))
  const [allContactTypes, setAllContactTypes] = useState<ExportContactType[]>(() =>
    runningAllTask?.allContactTypes?.length
      ? [...runningAllTask.allContactTypes]
      : [...ALL_CONTACT_TYPES]
  )
  const [selectedContacts, setSelectedContacts] = useState<Contact[]>(() =>
    initialSelection ? [initialSelection] : []
  )
  const [activeContactId, setActiveContactId] = useState(initialSelection?.md5 || '')
  const [previewByContact, setPreviewByContact] = useState<Record<string, Message[]>>({})
  const [range, setRange] = useState<ExportRange>(() => (runningAllTask ? 'all' : 'today'))
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [selectedKinds, setSelectedKinds] = useState<Set<string>>(() => new Set(['text']))
  const [nameMode, setNameMode] = useState<ExportNameMode>(
    initialSelection?.type === 'group' ? 'groupNickname' : 'remark'
  )
  const [includeMedia, setIncludeMedia] = useState(true)
  const [includeVoiceTranscripts, setIncludeVoiceTranscripts] = useState(true)
  const [voiceModelStatus, setVoiceModelStatus] = useState<VoiceModelStatus | null>(null)
  const [includeAvatars, setIncludeAvatars] = useState(true)
  const [preferOriginal, setPreferOriginal] = useState(true)
  const [fallbackThumbnail, setFallbackThumbnail] = useState(true)
  const [keepMissing, setKeepMissing] = useState(true)
  const [format, setFormat] = useState<ExportFormat>(() => runningAllTask?.format || 'csv')
  const [zip, setZip] = useState(() => runningAllTask?.zip === true)
  const [fileName, setFileName] = useState('')
  const [status, setStatus] = useState<ExportStatus>('idle')
  const [jobId, setJobId] = useState('')
  const [progress, setProgress] = useState<ExportJobProgress | null>(null)
  const [activeJobOptions, setActiveJobOptions] = useState({
    includeVoiceTranscripts: false,
    zip: false
  })
  const [taskCenterOpen, setTaskCenterOpen] = useState(false)
  const selectionLimit = 5

  React.useEffect(() => {
    if (selectedContacts.length > 0) return
    const candidate = initialContact || contacts[0]
    if (!candidate) return
    initialContactRef.current = candidate
    setSelectedContacts([candidate])
    setActiveContactId(candidate.md5)
  }, [contacts, initialContact, selectedContacts.length])

  React.useEffect(() => {
    if (exportAll) return
    for (const contact of selectedContacts) {
      if (previewByContact[contact.md5] || previewLoadingRef.current.has(contact.md5)) continue
      previewLoadingRef.current.add(contact.md5)
      void loadPreviewMessages(contact).then((items) => {
        previewLoadingRef.current.delete(contact.md5)
        setPreviewByContact((current) => ({ ...current, [contact.md5]: items }))
      })
    }
  }, [exportAll, loadPreviewMessages, previewByContact, selectedContacts])

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

  const activeContact =
    selectedContacts.find((contact) => contact.md5 === activeContactId) ||
    selectedContacts[0] ||
    null
  const exportContacts = exportAll
    ? contacts.filter((contact) => allContactTypes.includes(contact.type))
    : selectedContacts
  const selectedTargetKey = exportAll
    ? ''
    : selectedContacts
        .map((contact) => contact.md5)
        .sort()
        .join('|')
  const currentTask = exportTasks.find((task) =>
    exportAll
      ? task.scope === 'all' &&
        contactTypeKey(task.allContactTypes) === contactTypeKey(allContactTypes)
      : task.scope !== 'all' && [...task.targetIds].sort().join('|') === selectedTargetKey
  )
  const taskCount = exportTasks.filter((task) => task.status === 'running').length
  const activeName = displayName(activeContact)
  const selectedNames = selectedContacts.map(displayName)
  const allGroupCount = exportContacts.filter((contact) => contact.type === 'group').length
  const allUserCount = exportContacts.length - allGroupCount
  const selectedLabel = exportAll
    ? allContactTypes.length === 2
      ? `全部群聊 ${allGroupCount.toLocaleString()} 个、联系人 ${allUserCount.toLocaleString()} 个`
      : allContactTypes[0] === 'group'
        ? `全部群聊 ${allGroupCount.toLocaleString()} 个`
        : `全部联系人 ${allUserCount.toLocaleString()} 个`
    : selectedNames.length > 1
      ? `${selectedNames.join('、')} · 共 ${selectedNames.length} 个聊天`
      : selectedNames[0] || '未选择聊天'
  const preview = exportAll
    ? []
    : selectedContacts
        .flatMap((contact) =>
          (previewByContact[contact.md5] || []).map((message) => ({
            ...message,
            exportConversationId: contact.md5,
            exportConversationName: displayName(contact),
            exportConversationAvatarUrl: contact.avatar
          }))
        )
        .sort((left, right) => Number(left.createTime || 0) - Number(right.createTime || 0))
        .slice(-20)
  const previewMediaCount = preview.filter(
    (message) =>
      ['image', 'video', 'voice', 'sticker'].includes(message.contentData?.type || '') ||
      (message.contentData?.type === 'share' && message.contentData.typeVal === '6')
  ).length
  const previewBytes = preview.reduce(
    (total, message) => total + (message.content?.length || 0) * 2 + (message.img ? 1024 : 0),
    0
  )
  const defaultOutputName = exportAll
    ? '全部聊天记录'
    : selectedContacts.length > 1
      ? `${selectedNames[0]}等${selectedContacts.length}个聊天_合并档案`
      : `${activeName}_聊天档案`
  const outputName = fileName.trim() || defaultOutputName
  const nameOptions: { value: ExportNameMode; label: string }[] = exportContacts.some(
    (contact) => contact.type === 'group'
  )
    ? [
        { value: 'groupNickname', label: '群昵称' },
        { value: 'remark', label: '备注' },
        { value: 'wechatNickname', label: '微信名' }
      ]
    : [
        { value: 'remark', label: '备注' },
        { value: 'wechatNickname', label: '微信名' }
      ]

  const previewName = (message: Message): string =>
    message.name ||
    (message.isSender ? selfInfo?.nickname : undefined) ||
    (message.isSender ? '我' : '联系人')
  const previewAvatar = (message: Message): string | undefined =>
    message.img || (message.isSender ? selfInfo?.avatar : undefined)
  const previewItems = preview.map((message) => ({
    ...message,
    name: previewName(message),
    img: previewAvatar(message)
  }))

  const handleSelectContact = (contact: Contact): void => {
    if (exportAll) {
      setExportAll(false)
      setRange('today')
    }
    if (!selectionMode) {
      setSelectedContacts([contact])
      setActiveContactId(contact.md5)
      setStatus('idle')
      return
    }
    const selected = selectedContacts.some((item) => item.md5 === contact.md5)
    if (selected) {
      if (selectedContacts.length === 1) return
      const next = selectedContacts.filter((item) => item.md5 !== contact.md5)
      setSelectedContacts(next)
      if (activeContactId === contact.md5) setActiveContactId(next[0].md5)
      setStatus('idle')
      return
    }
    if (selectedContacts.length >= selectionLimit) return
    const next = [...selectedContacts, contact]
    setSelectedContacts(next)
    setActiveContactId(contact.md5)
    setFormat('html')
    setStatus('idle')
  }

  const handleExportAll = (): void => {
    if (!contacts.length || status === 'running') return
    setExportAll(true)
    setAllContactTypes([...ALL_CONTACT_TYPES])
    setSelectionMode(false)
    setRange('all')
    setStatus('idle')
  }

  const toggleAllContactType = (type: ExportContactType): void => {
    if (status === 'running') return
    setAllContactTypes((current) => {
      if (current.includes(type)) {
        return current.length === 1 ? current : current.filter((item) => item !== type)
      }
      return ALL_CONTACT_TYPES.filter((item) => item === type || current.includes(item))
    })
    setStatus('idle')
  }

  React.useEffect(() => {
    let active = true
    void window.api
      .getVoiceModelStatus()
      .then((next) => active && setVoiceModelStatus(next))
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const toggleKind = (value: string): void => {
    setSelectedKinds((current) => {
      const next = new Set(current)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  const handleStart = async (): Promise<void> => {
    if (!activeContact || exportContacts.length === 0 || status === 'running') return
    // Runs only from the export button event; a fresh id is required for each job.
    const nextJobId = `export-${Date.now()}`
    const exportFormat = !exportAll && exportContacts.length > 1 ? 'html' : format
    const shouldZip = exportFormat === 'html' && zip
    const shouldIncludeVoiceTranscripts =
      includeVoiceTranscripts &&
      includeMedia &&
      exportFormat === 'html' &&
      selectedKinds.has('voice') &&
      voiceModelStatus?.state === 'ready'
    setJobId(nextJobId)
    setProgress(null)
    setActiveJobOptions({ includeVoiceTranscripts: shouldIncludeVoiceTranscripts, zip: shouldZip })
    setStatus('running')
    const targets: ExportTarget[] = await Promise.all(
      exportContacts.map(async (contact) => {
        const nameMap: Record<string, string> = {}
        const avatarUrls: Record<string, string> = {}
        if (contact.type === 'group') {
          if (!exportAll) {
            const snapshot = await window.api.getGroupSnapshot(contact.md5)
            for (const member of (snapshot?.members || []) as GroupMemberName[]) {
              nameMap[member.wxid] = resolveMemberName(member, nameMode)
              if (member.avatar) avatarUrls[member.wxid] = member.avatar
            }
          }
        } else if (!exportAll) {
          nameMap[contact.m_nsUsrName] =
            nameMode === 'remark'
              ? contact.remark || contact.m_nsNickName || contact.m_nsUsrName
              : contact.wechatNickname || contact.m_nsUsrName
          if (contact.avatar) avatarUrls[contact.m_nsUsrName] = contact.avatar
        }
        if (selfInfo?.wxid && (!exportAll || contact.type === 'group')) {
          nameMap[selfInfo.wxid] = selfInfo.nickname || selfInfo.wxid
          if (selfInfo.avatar) avatarUrls[selfInfo.wxid] = selfInfo.avatar
        }
        return {
          userMd5: contact.md5,
          name: displayName(contact),
          type: contact.type,
          avatarUrl: contact.avatar,
          nameMode,
          nameMap,
          avatarUrls
        }
      })
    )
    const now = new Date()
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const days = range === 'today' ? 1 : range === 'threeDays' ? 3 : range === 'sevenDays' ? 7 : 0
    const startOfRange = days
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1)
      : null
    const request: ExportRequest = {
      jobId: nextJobId,
      scope: exportAll ? 'all' : 'selected',
      allContactTypes: exportAll ? allContactTypes : undefined,
      targets,
      format: exportFormat,
      outputName,
      startTime: exportAll
        ? undefined
        : startOfRange
          ? Math.floor(startOfRange.getTime() / 1000)
          : range === 'custom' && startDate
            ? Math.floor(new Date(startDate).getTime() / 1000)
            : undefined,
      endTime: exportAll
        ? undefined
        : startOfRange
          ? Math.floor(endOfToday.getTime() / 1000)
          : range === 'custom' && endDate
            ? Math.floor(new Date(endDate).getTime() / 1000)
            : undefined,
      kinds: Array.from(selectedKinds) as ExportMessageKind[],
      includeMedia,
      includeVoiceTranscripts: shouldIncludeVoiceTranscripts,
      preferOriginal,
      fallbackThumbnail,
      keepMissing,
      includeAvatars,
      zip: shouldZip
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
    setActiveJobOptions({
      includeVoiceTranscripts: currentTask.includeVoiceTranscripts === true,
      zip: currentTask.zip === true
    })
    setFormat(currentTask.format)
    setZip(currentTask.zip === true)
    setStatus(
      currentTask.status === 'running'
        ? 'running'
        : currentTask.status === 'completed'
          ? 'completed'
          : 'idle'
    )
  }, [currentTask])

  const resetDefaults = (): void => {
    const contact = initialContactRef.current || contacts[0] || null
    setSelectedContacts(contact ? [contact] : [])
    setActiveContactId(contact?.md5 || '')
    setSelectionMode(false)
    setExportAll(false)
    setAllContactTypes([...ALL_CONTACT_TYPES])
    setRange('today')
    setStartDate('')
    setEndDate('')
    setSelectedKinds(new Set(['text']))
    setNameMode(contact?.type === 'group' ? 'groupNickname' : 'remark')
    setIncludeMedia(true)
    setIncludeAvatars(true)
    setPreferOriginal(true)
    setFallbackThumbnail(true)
    setKeepMissing(true)
    setFormat('csv')
    setZip(false)
    setFileName('')
    setStatus('idle')
    setJobId('')
    setProgress(null)
    setActiveJobOptions({ includeVoiceTranscripts: false, zip: false })
  }

  const targetPath = exportAll
    ? format === 'html' && zip
      ? `文稿/TraceMemo/导出/${outputName}.zip`
      : `文稿/TraceMemo/导出/${outputName}/`
    : format === 'html'
      ? zip
        ? `文稿/TraceMemo/导出/${outputName}.zip`
        : `文稿/TraceMemo/导出/${outputName}/`
      : `文稿/TraceMemo/导出/${outputName}.${format === 'markdown' ? 'md' : format}`

  return (
    <div className="export-workspace">
      <ExportContactPanel
        contacts={contacts}
        filteredContacts={filteredContacts}
        activeContact={activeContact}
        selectedContactIds={selectedContacts.map((contact) => contact.md5)}
        selectionMode={selectionMode}
        exportAll={exportAll}
        allContactTypes={allContactTypes}
        exportRunning={status === 'running'}
        selectionLimit={selectionLimit}
        selfInfo={selfInfo}
        dbReady={dbReady}
        contactFilter={contactFilter}
        contactType={contactType}
        onContactFilterChange={setContactFilter}
        onContactTypeChange={setContactType}
        onSelectContact={handleSelectContact}
        onCompleteSelection={() => setSelectionMode(false)}
        onExportAll={handleExportAll}
        onToggleAllContactType={toggleAllContactType}
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
            <span className="export-chat-avatar-stack" aria-hidden>
              {exportAll
                ? allContactTypes.map((type) => (
                    <span
                      className={`export-chat-avatar export-all-chat-avatar ${type}`}
                      key={type}
                    >
                      {type === 'group' ? '群' : '联'}
                    </span>
                  ))
                : selectedContacts.slice(0, 3).map((contact) => (
                    <span className="export-chat-avatar" key={contact.md5}>
                      {contact.avatar ? (
                        <img src={contact.avatar} alt="" />
                      ) : (
                        displayName(contact).slice(0, 1)
                      )}
                    </span>
                  ))}
            </span>
            <span className="export-config-title">
              <h1>导出设置</h1>
              <p>{selectedLabel}</p>
            </span>
            <button
              type="button"
              className="export-add-chat-button"
              disabled={exportAll}
              onClick={() => {
                setExportAll(false)
                setSelectionMode((current) => !current)
              }}
            >
              {exportAll ? '已选择全部聊天' : selectionMode ? '完成选择' : '+ 添加聊天'}
            </button>
          </header>

          <section className="export-section export-format-top">
            <h3>导出格式</h3>
            <div className="export-format-grid">
              {formatOrder.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={format === value ? 'active' : ''}
                  disabled={!exportAll && exportContacts.length > 1 && value !== 'html'}
                  onClick={() => setFormat(value)}
                >
                  <strong>{formatLabels[value].label}</strong>
                  {formatLabels[value].hint && <small>{formatLabels[value].hint}</small>}
                </button>
              ))}
            </div>
            <p className="export-helper-text">
              {exportAll
                ? '全部导出固定使用全部时间；每个群聊或联系人都会在自己的目录中生成所选格式的独立档案。'
                : selectedContacts.length > 1
                  ? '多聊天合并仅支持 HTML，会保留每条消息所属的聊天。'
                  : 'CSV 默认最快；HTML 会包含图片、引用和其他媒体，导出时间可能较长。'}
            </p>
            {format === 'html' && (
              <>
                <div className="export-html-options">
                  <label>
                    <input
                      type="radio"
                      name="html-package-top"
                      checked={!zip}
                      onChange={() => setZip(false)}
                    />{' '}
                    HTML 资源包
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="html-package-top"
                      checked={zip}
                      onChange={() => setZip(true)}
                    />{' '}
                    HTML 资源包并压缩为 ZIP
                  </label>
                </div>
                <p className="export-helper-text">
                  使用相同名称再次导出时，会把新消息合并进已有档案，不会删除之前导出的消息。
                </p>
              </>
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
                className={range === 'all' ? 'active' : ''}
                onClick={() => setRange('all')}
              >
                全部时间
              </button>
              {!exportAll && (
                <>
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
                </>
              )}
            </div>
            {!exportAll && range === 'custom' && (
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
              <span>包含图片、视频、语音、表情及文件附件</span>
              <input
                type="checkbox"
                checked={includeMedia}
                disabled={format !== 'html'}
                onChange={(event) => setIncludeMedia(event.target.checked)}
              />
            </label>
            <div
              className={`export-media-options ${includeMedia && format === 'html' ? '' : 'disabled'}`}
            >
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
              <label className="export-check-row">
                <input
                  type="checkbox"
                  checked={includeVoiceTranscripts && voiceModelStatus?.state === 'ready'}
                  disabled={
                    !includeMedia ||
                    format !== 'html' ||
                    !selectedKinds.has('voice') ||
                    voiceModelStatus?.state !== 'ready'
                  }
                  onChange={(event) => setIncludeVoiceTranscripts(event.target.checked)}
                />
                <span>语音转文字，显示在语音条下方</span>
              </label>
            </div>
            <p className="export-helper-text">
              资源文件仅在 HTML 导出中生效，CSV、JSON 和 Markdown 只保留文本内容。
            </p>
            <div className="export-resource-statuses">
              <span>图片解密：已就绪</span>
              <span>视频资源：可用</span>
              <span>语音资源：可用</span>
              <span>
                语音转文字：
                {voiceModelStatus?.state === 'ready' ? '已就绪' : '请先在设置中准备模型'}
              </span>
              <span>表情资源：按需解析</span>
              <span>文件附件：按需复制</span>
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

          <section className="export-section export-save-section">
            <h3>保存设置</h3>
            <label>
              文件名称
              <input
                value={fileName}
                onChange={(event) => setFileName(event.target.value)}
                placeholder={defaultOutputName}
              />
            </label>
            <div className="export-target-path">
              <span>保存位置</span>
              <strong>{targetPath}</strong>
              <button type="button">选择位置</button>
            </div>
            {format === 'html' && (
              <p className="export-helper-text">
                可以分多次选择不同时间范围，逐步补齐同一个聊天档案。
              </p>
            )}
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
          <button type="button" className="export-reset-button" onClick={resetDefaults}>
            恢复默认
          </button>
          <button
            type="button"
            className="export-primary-button"
            disabled={!activeContact || !exportContacts.length || status === 'running'}
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
        includeVoiceTranscripts={activeJobOptions.includeVoiceTranscripts}
        zip={activeJobOptions.zip}
        selectedCount={exportContacts.length}
        allExport={exportAll}
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
