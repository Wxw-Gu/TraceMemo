import { useEffect, useMemo, useState } from 'react'
import type { Contact } from '../../../../../shared/types'
import {
  Button,
  Input,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '../../../components/ui'
import type { ImageBatchTestItemStatus, ImageBatchTestState, ImageDecryptionState } from './types'

type StepState = 'pending' | 'ok' | 'fail' | 'skipped'
type ContactFilter = 'all' | 'group' | 'user'

function stepClass(step: StepState): string {
  switch (step) {
    case 'ok':
      return 'image-step image-step-ok'
    case 'fail':
      return 'image-step image-step-fail'
    case 'skipped':
      return 'image-step image-step-skipped'
    default:
      return 'image-step image-step-pending'
  }
}

function stepIcon(step: StepState): string {
  switch (step) {
    case 'ok':
      return '✓'
    case 'fail':
      return '×'
    case 'skipped':
      return '·'
    default:
      return '○'
  }
}

function pickSteps(result: { fileFound: boolean; decrypted: boolean; readable: boolean }): {
  find: StepState
  decrypt: StepState
  read: StepState
} {
  // 三步严格联动：找到失败 → 解密/读取 skipped；解密失败 → 读取 skipped；
  // 解密成功但不可读 → 读取 fail。
  if (!result.fileFound) {
    return { find: 'fail', decrypt: 'skipped', read: 'skipped' }
  }
  if (!result.decrypted) {
    return { find: 'ok', decrypt: 'fail', read: 'skipped' }
  }
  if (!result.readable) {
    return { find: 'ok', decrypt: 'ok', read: 'fail' }
  }
  return { find: 'ok', decrypt: 'ok', read: 'ok' }
}

function contactName(contact: Contact): string {
  return contact.remark || contact.m_nsNickName || contact.wechatNickname || contact.m_nsUsrName
}

function formatElapsed(elapsedMs: number): string {
  if (elapsedMs < 1000) return `${elapsedMs} ms`
  if (elapsedMs < 60_000) return `${(elapsedMs / 1000).toFixed(elapsedMs < 10_000 ? 1 : 0)} 秒`
  const minutes = Math.floor(elapsedMs / 60_000)
  const seconds = Math.floor((elapsedMs % 60_000) / 1000)
  return `${minutes} 分 ${seconds} 秒`
}

function batchStatusText(status: ImageBatchTestItemStatus): string {
  switch (status) {
    case 'testing':
      return '测试中'
    case 'success':
      return '成功'
    case 'failed':
      return '失败'
    case 'no-image':
      return '无图片'
    case 'stopped':
      return '未测试'
    default:
      return '等待中'
  }
}

export function ImageTestSection({
  state,
  batchTest,
  disabled,
  canSave,
  onSelect,
  onTest,
  onBatchTest,
  onStopBatchTest,
  onCopyLog,
  onSave
}: {
  state: ImageDecryptionState
  batchTest: ImageBatchTestState
  disabled: boolean
  canSave: boolean
  onSelect: (value: string) => void
  onTest: () => void
  onBatchTest: (contacts: Contact[]) => void
  onStopBatchTest: () => void
  onCopyLog: () => void
  onSave: () => void
}): React.ReactElement {
  const [contactFilter, setContactFilter] = useState<ContactFilter>('all')
  const [searchValue, setSearchValue] = useState('')
  const [liveClock, setLiveClock] = useState({ startedAt: 0, elapsedMs: 0 })
  const result = state.testResult
  const steps = result
    ? pickSteps({
        fileFound: result.fileFound,
        decrypted: result.decrypted,
        readable: result.readable
      })
    : null

  const contactCounts = useMemo(
    () => ({
      all: state.contacts.length,
      group: state.contacts.filter((contact) => contact.type === 'group').length,
      user: state.contacts.filter((contact) => contact.type === 'user').length
    }),
    [state.contacts]
  )
  const filteredContacts = useMemo(() => {
    const keyword = searchValue.trim().toLowerCase()
    return state.contacts.filter((contact) => {
      if (contactFilter !== 'all' && contact.type !== contactFilter) return false
      if (!keyword) return true
      return [
        contactName(contact),
        contact.m_nsNickName,
        contact.m_nsUsrName,
        contact.wechatNickname,
        contact.remark
      ].some((value) => value?.toLowerCase().includes(keyword))
    })
  }, [contactFilter, searchValue, state.contacts])
  const filteredGroups = filteredContacts.filter((contact) => contact.type === 'group')
  const filteredUsers = filteredContacts.filter((contact) => contact.type === 'user')

  const batchCounts = useMemo(() => {
    const completed = batchTest.items.filter((item) =>
      ['success', 'failed', 'no-image'].includes(item.status)
    ).length
    return {
      completed,
      success: batchTest.items.filter((item) => item.status === 'success').length,
      failed: batchTest.items.filter((item) => item.status === 'failed').length,
      noImage: batchTest.items.filter((item) => item.status === 'no-image').length,
      stopped: batchTest.items.filter((item) => item.status === 'stopped').length
    }
  }, [batchTest.items])
  const batchProgress = batchTest.items.length
    ? Math.round((batchCounts.completed / batchTest.items.length) * 100)
    : 0

  useEffect(() => {
    if (!batchTest.running || !batchTest.startedAt) return
    const timer = window.setInterval(() => {
      setLiveClock({
        startedAt: batchTest.startedAt!,
        elapsedMs: Date.now() - batchTest.startedAt!
      })
    }, 250)
    return () => window.clearInterval(timer)
  }, [batchTest.running, batchTest.startedAt])

  const displayedElapsed =
    batchTest.running && liveClock.startedAt === batchTest.startedAt
      ? Math.max(batchTest.elapsedMs, liveClock.elapsedMs)
      : batchTest.elapsedMs

  const handleBatchTest = (): void => {
    if (filteredContacts.length === 0 || batchTest.running) return
    const confirmed = window.confirm(
      `即将测试 ${filteredContacts.length} 个会话。每个会话最多检查最近 300 条消息中的一张图片，会话较多时可能耗时数分钟。是否继续？`
    )
    if (confirmed) onBatchTest(filteredContacts)
  }

  const batchButtonLabel =
    contactFilter === 'all' && !searchValue.trim()
      ? `全部测试（${filteredContacts.length}）`
      : `测试筛选结果（${filteredContacts.length}）`

  return (
    <section className="settings-card image-test-section">
      <div className="image-test-heading">
        <div>
          <strong>图片解析测试</strong>
          <p>选择一个会话快速测试，或批量检查群聊和联系人。</p>
        </div>
        <div className="image-test-copy-area">
          <span
            className="image-test-log-scope"
            title="此日志只包含当前所选单个会话的图片解析结果，不包含批量测试结果"
          >
            <span className="image-test-log-scope-icon" aria-hidden="true">
              !
            </span>
            仅当前会话的单次测试日志
          </span>
          <Button variant="outline" size="sm" disabled={!result?.diagnosticLog} onClick={onCopyLog}>
            复制日志
          </Button>
        </div>
      </div>

      <SegmentedControl
        className="mt-[18px]"
        aria-label="会话类型筛选"
        value={contactFilter}
        onValueChange={(value) => setContactFilter(value as ContactFilter)}
      >
        {(
          [
            ['all', '全部'],
            ['group', '群聊'],
            ['user', '联系人']
          ] as const
        ).map(([value, label]) => (
          <SegmentedControlItem key={value} value={value} disabled={disabled}>
            {label} {contactCounts[value]}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>

      <label htmlFor="image-test-search">搜索会话</label>
      <Input
        id="image-test-search"
        type="search"
        value={searchValue}
        disabled={disabled}
        placeholder="搜索群聊、联系人或 wxid"
        onChange={(event) => setSearchValue(event.target.value)}
      />

      <label htmlFor="image-test-chat">选择会话</label>
      <Select value={state.selectedUserMd5} disabled={disabled} onValueChange={onSelect}>
        <SelectTrigger id="image-test-chat">
          <SelectValue placeholder="请选择包含图片的会话" />
        </SelectTrigger>
        <SelectContent>
          {filteredGroups.length > 0 && (
            <SelectGroup>
              <SelectLabel>{`群聊（${filteredGroups.length}）`}</SelectLabel>
              {filteredGroups.map((contact) => (
                <SelectItem key={contact.md5} value={contact.md5}>
                  {contactName(contact)}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {filteredUsers.length > 0 && (
            <SelectGroup>
              <SelectLabel>{`联系人（${filteredUsers.length}）`}</SelectLabel>
              {filteredUsers.map((contact) => (
                <SelectItem key={contact.md5} value={contact.md5}>
                  {contactName(contact)}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
      {filteredContacts.length === 0 && <p className="image-test-empty">没有匹配的会话</p>}

      <div className="image-test-actions">
        <Button disabled={disabled || !state.selectedUserMd5} onClick={onTest}>
          {state.phase === 'testing' ? '正在测试…' : '测试图片解析'}
        </Button>
        <Button variant="outline" disabled={!canSave} onClick={onSave}>
          确认保存
        </Button>
        {batchTest.running ? (
          <Button
            variant="outline"
            className="image-batch-stop"
            disabled={batchTest.stopRequested}
            onClick={onStopBatchTest}
          >
            {batchTest.stopRequested ? '正在停止…' : '停止测试'}
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={disabled || filteredContacts.length === 0}
            onClick={handleBatchTest}
          >
            {batchButtonLabel}
          </Button>
        )}
      </div>
      <p className="image-batch-warning">
        批量测试会逐个读取会话数据，每个会话最多测试一张图片；会话较多时耗时较长，可随时停止。
      </p>

      {steps ? (
        <ol className="image-step-list">
          <li className={stepClass(steps.find)}>
            <span className="image-step-icon">{stepIcon(steps.find)}</span>
            <span>找到图片文件</span>
          </li>
          <li className={stepClass(steps.decrypt)}>
            <span className="image-step-icon">{stepIcon(steps.decrypt)}</span>
            <span>解密成功</span>
          </li>
          <li className={stepClass(steps.read)}>
            <span className="image-step-icon">{stepIcon(steps.read)}</span>
            <span>图片可以读取</span>
          </li>
        </ol>
      ) : state.error ? (
        <p className="image-inline-error">{state.error}</p>
      ) : null}
      {result && !result.success && result.error ? (
        <p className="image-inline-error">{result.error}</p>
      ) : null}

      {batchTest.items.length > 0 && (
        <div className="image-batch-results" aria-live="polite">
          <div className="image-batch-summary">
            <div>
              <strong>{batchTest.running ? '正在批量测试' : '批量测试结果'}</strong>
              <span>
                {batchCounts.completed}/{batchTest.items.length} · 已耗时{' '}
                {formatElapsed(displayedElapsed)}
              </span>
            </div>
            <span>{batchProgress}%</span>
          </div>
          <div className="image-batch-progress" aria-label={`批量测试进度 ${batchProgress}%`}>
            <span style={{ width: `${batchProgress}%` }} />
          </div>
          <div className="image-batch-counts">
            <span className="success">成功 {batchCounts.success}</span>
            <span className="failed">失败 {batchCounts.failed}</span>
            <span className="no-image">无图片 {batchCounts.noImage}</span>
            {batchCounts.stopped > 0 && <span>未测试 {batchCounts.stopped}</span>}
          </div>
          <ul className="image-batch-list">
            {batchTest.items.map((item) => (
              <li key={item.contact.md5} className={`image-batch-item ${item.status}`}>
                <div className="image-batch-item-main">
                  <span className="image-batch-contact-name" title={contactName(item.contact)}>
                    {contactName(item.contact)}
                  </span>
                  <span className="image-batch-contact-type">
                    {item.contact.type === 'group' ? '群聊' : '联系人'}
                  </span>
                  <span className="image-batch-status">{batchStatusText(item.status)}</span>
                  <span className="image-batch-time">
                    {typeof item.elapsedMs === 'number' ? formatElapsed(item.elapsedMs) : '—'}
                  </span>
                </div>
                {item.error && <p title={item.error}>{item.error}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
