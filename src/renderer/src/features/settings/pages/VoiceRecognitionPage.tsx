import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Contact } from '../../../../../shared/types'
import type {
  VoiceBatchConversationSummary,
  VoiceBatchProgress,
  VoiceBatchRange,
  VoiceModelStatus
} from '../../../../../shared/voice-recognition'
import {
  Button,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger
} from '../../../components/ui'

const SENSEVOICE_URL = 'https://github.com/FunAudioLLM/SenseVoice'
const SHERPA_URL = 'https://github.com/k2-fsa/sherpa-onnx'

const STATUS_LABELS: Record<VoiceModelStatus['state'], string> = {
  missing: '未下载',
  downloading: '下载中',
  ready: '已就绪',
  invalid: '需要修复',
  error: '下载失败',
  unsupported: '暂不支持'
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatPlatform(status: VoiceModelStatus): string {
  if (status.platform === 'win32')
    return `Windows ${status.architecture === 'x64' ? '64 位' : status.architecture}`
  if (status.platform === 'darwin') {
    return status.architecture === 'arm64' ? 'macOS Apple 芯片' : 'macOS Intel'
  }
  return `${status.platform} ${status.architecture}`
}

const BATCH_RANGE_LABELS: Record<VoiceBatchRange, string> = {
  recent_30_days: '最近 30 天',
  current_year: '今年',
  selected_history: '所选会话全部历史'
}

const BATCH_STATE_LABELS: Record<VoiceBatchProgress['state'], string> = {
  idle: '未开始',
  pending: '准备中',
  processing: '转写中',
  completed: '已完成',
  partially_failed: '部分失败',
  cancelled: '已取消'
}

const hasBatchApi = (): boolean =>
  typeof window.api.getVoiceBatchPreflight === 'function' &&
  typeof window.api.getVoiceBatchConversationSummaries === 'function'

const BATCH_PAGE_SIZE = 12

function contactName(contact: Contact): string {
  return contact.m_nsNickName || contact.remark || contact.wechatNickname || contact.m_nsUsrName
}

export function VoiceRecognitionPage({
  onNotice
}: {
  onNotice: (message: string) => void
}): React.ReactElement {
  const [status, setStatus] = useState<VoiceModelStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [selectedConversationIds, setSelectedConversationIds] = useState<string[]>([])
  const [batchRange, setBatchRange] = useState<VoiceBatchRange>('recent_30_days')
  const [conversationSummaries, setConversationSummaries] = useState<
    Record<string, VoiceBatchConversationSummary['voiceMessageCount']>
  >({})
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [conversationCategory, setConversationCategory] = useState<'group' | 'user'>('group')
  const [conversationQuery, setConversationQuery] = useState('')
  const [conversationPage, setConversationPage] = useState(0)
  const [batchProgress, setBatchProgress] = useState<VoiceBatchProgress | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [accountName, setAccountName] = useState('未连接')

  const refresh = useCallback(async (): Promise<void> => {
    setStatus(await window.api.getVoiceModelStatus())
  }, [])

  const refreshBatchProgress = useCallback(async (): Promise<void> => {
    if (!hasBatchApi()) return
    const nextProgress = await window.api.getVoiceBatchProgress()
    setBatchProgress(nextProgress || null)
  }, [])

  useEffect(() => {
    let active = true
    void window.api.getVoiceModelStatus().then((next) => active && setStatus(next))
    const unsubscribe = window.api.onVoiceModelProgress((next) => {
      if (active) setStatus(next)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!hasBatchApi()) return
    let active = true
    void window.api.getContacts().then((next) => active && setContacts(next))
    void window.api.getSelf().then((next) => {
      if (active) setAccountName(next.ready ? next.info.nickname || next.info.wxid : '未连接')
    })
    void refreshBatchProgress()
    const unsubscribe = window.api.onVoiceBatchProgress((next) => {
      if (!active) return
      setBatchProgress(next)
      if (
        next.state === 'completed' ||
        next.state === 'partially_failed' ||
        next.state === 'cancelled'
      ) {
        void refreshBatchProgress()
      }
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [refreshBatchProgress])

  const categoryContacts = useMemo(
    () => contacts.filter((contact) => contact.type === conversationCategory),
    [contacts, conversationCategory]
  )
  const filteredContacts = useMemo(() => {
    const keyword = conversationQuery.trim().toLocaleLowerCase()
    const visible = keyword
      ? categoryContacts.filter((contact) =>
          contactName(contact).toLocaleLowerCase().includes(keyword)
        )
      : categoryContacts
    return [...visible].sort((left, right) =>
      contactName(left).localeCompare(contactName(right), 'zh-CN')
    )
  }, [categoryContacts, conversationQuery])
  const pageCount = Math.max(1, Math.ceil(filteredContacts.length / BATCH_PAGE_SIZE))
  const visibleContacts = useMemo(
    () =>
      filteredContacts.slice(
        conversationPage * BATCH_PAGE_SIZE,
        (conversationPage + 1) * BATCH_PAGE_SIZE
      ),
    [conversationPage, filteredContacts]
  )

  useEffect(() => {
    setConversationPage(0)
  }, [conversationCategory, conversationQuery])

  useEffect(() => {
    if (conversationPage < pageCount) return
    setConversationPage(pageCount - 1)
  }, [conversationPage, pageCount])

  useEffect(() => {
    if (!hasBatchApi() || visibleContacts.length === 0) return
    let active = true
    const request = {
      conversationIds: visibleContacts.map((contact) => contact.md5),
      range: batchRange
    }
    setConversationSummaries((current) => {
      const next = { ...current }
      for (const conversationId of request.conversationIds) delete next[conversationId]
      return next
    })
    setSummaryLoading(true)
    void window.api
      .getVoiceBatchConversationSummaries(request)
      .then((summaries) => {
        if (!active) return
        setConversationSummaries((current) => ({
          ...current,
          ...Object.fromEntries(
            summaries.map((summary) => [summary.conversationId, summary.voiceMessageCount])
          )
        }))
      })
      .catch(() => {
        if (!active) return
        setConversationSummaries((current) => ({
          ...current,
          ...Object.fromEntries(
            request.conversationIds.map((conversationId) => [conversationId, null])
          )
        }))
      })
      .finally(() => {
        if (active) setSummaryLoading(false)
      })
    return () => {
      active = false
    }
  }, [batchRange, visibleContacts])

  const badgeClass = useMemo(() => {
    if (status?.state === 'ready') return 'ready'
    if (status?.state === 'downloading') return 'checking'
    if (status?.state === 'invalid' || status?.state === 'error') return 'error'
    if (status?.state === 'unsupported') return 'unavailable'
    return 'warning'
  }, [status?.state])

  const download = async (): Promise<void> => {
    setBusy(true)
    setStatus((current) =>
      current ? { ...current, state: 'downloading', downloadedBytes: 0, progress: 0 } : current
    )
    try {
      const result = await window.api.downloadVoiceModel()
      setStatus(result.status)
      onNotice(result.success ? '离线语音模型已准备好' : result.error || '模型下载失败')
    } finally {
      setBusy(false)
    }
  }

  const cancelDownload = async (): Promise<void> => {
    await window.api.cancelVoiceModelDownload()
    onNotice('正在取消模型下载')
  }

  const removeModel = async (): Promise<void> => {
    if (!window.confirm('删除离线语音模型？以后使用语音转文字时需要重新下载。')) return
    setBusy(true)
    try {
      setStatus(await window.api.removeVoiceModel())
      onNotice('离线语音模型已删除')
    } catch (error) {
      onNotice(error instanceof Error ? `模型删除失败：${error.message}` : '模型删除失败')
    } finally {
      setBusy(false)
    }
  }

  const openDirectory = async (): Promise<void> => {
    const result = await window.api.openVoiceModelDirectory()
    if (!result.success) onNotice(result.error || '无法打开模型目录')
  }

  const startBatch = async (): Promise<void> => {
    if (!selectedConversationIds.length) {
      onNotice('请先选择至少一个联系人或群聊')
      return
    }
    setBatchBusy(true)
    try {
      const next = await window.api.startVoiceBatch({
        conversationIds: selectedConversationIds,
        range: batchRange
      })
      setBatchProgress(next)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '无法启动语音转写任务')
    } finally {
      setBatchBusy(false)
    }
  }

  const cancelBatch = async (): Promise<void> => {
    setBatchBusy(true)
    try {
      await window.api.cancelVoiceBatch()
    } finally {
      setBatchBusy(false)
    }
  }

  const retryFailed = async (): Promise<void> => {
    setBatchBusy(true)
    try {
      setBatchProgress(await window.api.retryFailedVoiceBatch())
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '无法重试失败语音')
    } finally {
      setBatchBusy(false)
    }
  }

  const batchRunning = batchProgress?.state === 'pending' || batchProgress?.state === 'processing'
  const currentBatchConversation = contacts.find(
    (contact) => contact.md5 === batchProgress?.currentConversationId
  )
  const formatTaskDuration = (milliseconds: number | null | undefined): string => {
    if (milliseconds === null || milliseconds === undefined) return '估算中'
    if (milliseconds < 1000) return `${milliseconds}ms`
    const seconds = Math.round(milliseconds / 1000)
    return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`
  }
  const toggleConversation = (conversationId: string): void => {
    setSelectedConversationIds((current) =>
      current.includes(conversationId)
        ? current.filter((id) => id !== conversationId)
        : [...current, conversationId]
    )
  }
  const selectedNames = contacts
    .filter((contact) => selectedConversationIds.includes(contact.md5))
    .map(contactName)
  const selectedVoiceMessageCount = selectedConversationIds.reduce<number | null>(
    (total, conversationId) => {
      const count = conversationSummaries[conversationId]
      return total === null || typeof count !== 'number' ? null : total + count
    },
    0
  )

  return (
    <div className="settings-page voice-recognition-page">
      <header className="settings-page-header">
        <div>
          <h1>语音转文字</h1>
          <p>管理本地语音识别环境和离线模型</p>
        </div>
        <div className="voice-header-status">
          <span className={`settings-status-badge ${badgeClass}`}>
            {status?.state === 'downloading'
              ? `下载中 ${Math.round(status.progress * 100)}%`
              : status
                ? STATUS_LABELS[status.state]
                : '检测中'}
          </span>
          {status?.state === 'downloading' && (
            <progress value={status.progress} max={1} aria-label="顶部语音模型下载进度" />
          )}
        </div>
      </header>
      <div className="settings-page-scroll">
        <div className="settings-page-content voice-recognition-content">
          <section className="settings-privacy-notice">
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M12 3 5.5 5.7v5.2c0 4.3 2.7 8.2 6.5 10.1 3.8-1.9 6.5-5.8 6.5-10.1V5.7L12 3Z" />
            </svg>
            <div>
              <strong>语音内容仅在本机处理</strong>
              <p>识别过程不会上传语音、聊天内容或转写结果，也不需要配置在线 AI 服务。</p>
            </div>
          </section>

          <h2 className="settings-section-heading">运行环境</h2>
          <section className="settings-card voice-runtime-card">
            <dl>
              <div>
                <dt>当前平台</dt>
                <dd>{status ? formatPlatform(status) : '检测中...'}</dd>
              </div>
              <div>
                <dt>离线识别</dt>
                <dd className={status?.supported ? 'voice-status-success' : 'voice-status-error'}>
                  {status?.supported ? '支持' : '暂不支持'}
                </dd>
              </div>
              <div>
                <dt>识别引擎</dt>
                <dd>sherpa-onnx · SenseVoice</dd>
              </div>
            </dl>
          </section>

          <h2 className="settings-section-heading">离线模型</h2>
          <section className="settings-card voice-model-card">
            <div className="voice-model-summary">
              <span className="settings-card-kicker">SenseVoice Small INT8</span>
              <strong>
                {status?.state === 'downloading'
                  ? `正在下载 ${Math.round(status.progress * 100)}%`
                  : status
                    ? STATUS_LABELS[status.state]
                    : '正在检测'}
              </strong>
              <small>
                {status
                  ? `版本 ${status.version} · ${formatBytes(status.totalBytes)}`
                  : '读取模型状态...'}
              </small>
              {status?.error && <p className="voice-model-error">{status.error}</p>}
              <p className="voice-model-license">
                上游模型：
                <a href={SENSEVOICE_URL} target="_blank" rel="noreferrer">
                  SenseVoice（MIT）
                </a>
                <span> · </span>
                推理运行库：
                <a href={SHERPA_URL} target="_blank" rel="noreferrer">
                  sherpa-onnx（Apache-2.0）
                </a>
              </p>
            </div>
            <div className="voice-model-actions">
              {status?.state === 'downloading' ? (
                <Button variant="outline" size="sm" onClick={() => void cancelDownload()}>
                  取消下载
                </Button>
              ) : status?.state === 'ready' ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => void openDirectory()}>
                    打开模型目录
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => void removeModel()}
                  >
                    删除模型
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  disabled={busy || !status?.supported}
                  onClick={() => void download()}
                >
                  {status?.state === 'invalid' || status?.state === 'error'
                    ? '重新下载模型'
                    : '下载模型'}
                </Button>
              )}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
                重新检测
              </Button>
            </div>
            {status?.state === 'downloading' && (
              <div className="voice-model-progress">
                <div>
                  <span>{Math.round(status.progress * 100)}%</span>
                  <small>
                    {formatBytes(status.downloadedBytes)} / {formatBytes(status.totalBytes)}
                  </small>
                </div>
                <progress value={status.progress} max={1} aria-label="语音模型下载进度" />
              </div>
            )}
          </section>

          <h2 className="settings-section-heading">批量转写</h2>
          <section className="settings-card voice-batch-card">
            <div className="voice-batch-heading">
              <div>
                <span className="settings-card-kicker">当前账号的本地语音</span>
                <strong>选择需要转写的会话</strong>
                <small>当前账号：{accountName}。聊天气泡中的单条转写始终优先于此后台任务。</small>
              </div>
              {batchProgress && (
                <span className="settings-status-badge">
                  {BATCH_STATE_LABELS[batchProgress.state]}
                </span>
              )}
            </div>

            <div className="voice-batch-workspace">
              <div className="voice-conversation-picker">
                <div className="voice-conversation-toolbar">
                  <Tabs
                    value={conversationCategory}
                    onValueChange={(value) => setConversationCategory(value as 'group' | 'user')}
                  >
                    <TabsList aria-label="会话类别">
                      <TabsTrigger value="group">
                        群聊 {contacts.filter((contact) => contact.type === 'group').length}
                      </TabsTrigger>
                      <TabsTrigger value="user">
                        联系人 {contacts.filter((contact) => contact.type === 'user').length}
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <Input
                    className="h-8 w-[min(190px,42%)]"
                    type="search"
                    value={conversationQuery}
                    aria-label="搜索会话"
                    placeholder="搜索会话"
                    disabled={Boolean(batchRunning)}
                    onChange={(event) => setConversationQuery(event.currentTarget.value)}
                  />
                </div>

                <div className="voice-conversation-list" aria-label="可转写会话">
                  {visibleContacts.map((contact) => {
                    const count = conversationSummaries[contact.md5]
                    const selected = selectedConversationIds.includes(contact.md5)
                    return (
                      <label
                        className={`voice-conversation-row ${selected ? 'selected' : ''}`}
                        key={contact.md5}
                      >
                        <Checkbox
                          checked={selected}
                          disabled={Boolean(batchRunning)}
                          onCheckedChange={() => toggleConversation(contact.md5)}
                        />
                        <span className="voice-conversation-avatar" aria-hidden>
                          {contact.avatar ? (
                            <img src={contact.avatar} alt="" referrerPolicy="no-referrer" />
                          ) : (
                            contactName(contact).slice(0, 1)
                          )}
                        </span>
                        <span className="voice-conversation-copy">
                          <strong>{contactName(contact)}</strong>
                          <small>{contact.type === 'group' ? '群聊' : '联系人'}</small>
                        </span>
                        <span className="voice-conversation-count">
                          {count === undefined && summaryLoading
                            ? '统计中'
                            : count === undefined || count === null
                              ? '暂无法统计'
                              : `${count.toLocaleString()} 条语音`}
                        </span>
                      </label>
                    )
                  })}
                  {visibleContacts.length === 0 && (
                    <p className="voice-conversation-empty">没有匹配的会话</p>
                  )}
                </div>

                {pageCount > 1 && (
                  <div className="voice-conversation-pagination" aria-label="会话分页">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="上一页"
                      disabled={conversationPage === 0 || Boolean(batchRunning)}
                      onClick={() => setConversationPage((current) => current - 1)}
                    >
                      上一页
                    </Button>
                    <span>
                      {conversationPage + 1} / {pageCount}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="下一页"
                      disabled={conversationPage >= pageCount - 1 || Boolean(batchRunning)}
                      onClick={() => setConversationPage((current) => current + 1)}
                    >
                      下一页
                    </Button>
                  </div>
                )}
              </div>

              <aside className="voice-batch-summary" aria-label="本次转写">
                <div className="voice-batch-field">
                  <span>时间范围</span>
                  <Select
                    value={batchRange}
                    disabled={Boolean(batchRunning)}
                    onValueChange={(value) => setBatchRange(value as VoiceBatchRange)}
                  >
                    <SelectTrigger aria-label="语音转写时间范围">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(BATCH_RANGE_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <dl className="voice-batch-selection-stats">
                  <div>
                    <dt>已选会话</dt>
                    <dd>{selectedConversationIds.length}</dd>
                  </div>
                  <div>
                    <dt>语音消息</dt>
                    <dd>{selectedVoiceMessageCount?.toLocaleString() ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>模型状态</dt>
                    <dd>{status?.state === 'ready' ? '就绪' : '—'}</dd>
                  </div>
                  <div>
                    <dt>任务状态</dt>
                    <dd>{BATCH_STATE_LABELS[batchProgress?.state || 'idle']}</dd>
                  </div>
                </dl>
                {selectedNames.length > 0 && (
                  <p className="voice-batch-selected-names">
                    {selectedNames.slice(0, 3).join('、')}
                  </p>
                )}
                <div className="voice-batch-summary-actions">
                  <Button
                    disabled={
                      batchBusy || !selectedConversationIds.length || status?.state !== 'ready'
                    }
                    onClick={() => void startBatch()}
                  >
                    开始转写
                  </Button>
                  <Button
                    variant="outline"
                    disabled={batchBusy || !selectedConversationIds.length || Boolean(batchRunning)}
                    onClick={() => setSelectedConversationIds([])}
                  >
                    清空选择
                  </Button>
                </div>
              </aside>
            </div>

            {batchProgress && batchProgress.state !== 'idle' && (
              <div className="voice-batch-progress" aria-label="批量语音转写进度">
                <div>
                  <span>
                    {batchProgress.processed} / {batchProgress.total} 条
                    {batchProgress.currentConversationId ? '，正在处理所选会话' : ''}
                  </span>
                  <small>
                    缓存 {batchProgress.cached} · 新转写 {batchProgress.succeeded} · 失败{' '}
                    {batchProgress.failed}
                    {' · '}已用时 {formatTaskDuration(batchProgress.elapsedMs)}
                    {' · '}剩余 {formatTaskDuration(batchProgress.estimatedRemainingMs)}
                  </small>
                  {currentBatchConversation && (
                    <small>当前会话：{currentBatchConversation.m_nsNickName}</small>
                  )}
                </div>
                <progress value={batchProgress.processed} max={Math.max(1, batchProgress.total)} />
              </div>
            )}

            {(batchRunning || batchProgress?.state === 'partially_failed') && (
              <div className="voice-batch-actions">
                {batchRunning && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={batchBusy}
                    onClick={() => void cancelBatch()}
                  >
                    取消任务
                  </Button>
                )}
                {batchProgress?.state === 'partially_failed' && (
                  <Button size="sm" disabled={batchBusy} onClick={() => void retryFailed()}>
                    重试失败项
                  </Button>
                )}
              </div>
            )}
          </section>

          <h2 className="settings-section-heading">平台支持</h2>
          <section className="settings-card voice-platform-list">
            <div>
              <strong>Windows</strong>
              <span>支持 Windows 10/11 64 位</span>
            </div>
            <div>
              <strong>macOS</strong>
              <span>支持 Intel 与 Apple 芯片</span>
            </div>
          </section>
          <p className="settings-footnote">
            模型由两个平台共用；应用会随安装包提供对应系统的本地识别运行库。
          </p>
        </div>
      </div>
    </div>
  )
}
