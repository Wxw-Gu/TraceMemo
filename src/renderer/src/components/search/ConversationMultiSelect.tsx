import * as React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Checkbox } from '../ui'
import { cn } from '../../lib/cn'

/** 一个可被勾选的会话。 */
export interface ConversationSelectOption {
  conversationId: string
  name: string
  type: 'user' | 'group'
  /** `null` = 数量未知（统计失败或尚未统计）。**不能**当成 0。 */
  messageCount: number | null
  /** 分片重叠导致条数只是上限时为 true。 */
  approximate: boolean
  /** 最后活跃时间（epoch ms）；`null` = 无可靠数据。 */
  lastActiveAt: number | null
  /** 区分「还在统计」与「统计失败」：两者都是 null，都不能显示成 0。 */
  countMeasured: boolean
  /** 名称之外可被搜到的文本：备注 / 昵称 / 微信号。 */
  keywords: string
}

export type ConversationSortMode = 'messages-desc' | 'messages-asc' | 'recent' | 'name'
export type ConversationTypeFilter = 'all' | 'group' | 'user'

export const CONVERSATION_SORT_LABELS: Record<ConversationSortMode, string> = {
  'messages-desc': '消息数最多',
  'messages-asc': '消息数最少',
  recent: '最近活跃',
  name: '名称'
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, '')
}

/** 未知数量恒排最后（升降序都一样）：混进最小端会被读成"这个群没消息"。 */
export function sortConversationOptions(
  options: readonly ConversationSelectOption[],
  mode: ConversationSortMode
): ConversationSelectOption[] {
  const byName = (left: ConversationSelectOption, right: ConversationSelectOption): number =>
    left.name.localeCompare(right.name, 'zh-Hans-CN')

  const sorted = [...options]
  if (mode === 'name') return sorted.sort(byName)

  if (mode === 'recent') {
    return sorted.sort((left, right) => {
      const leftAt = left.lastActiveAt ?? -1
      const rightAt = right.lastActiveAt ?? -1
      if (leftAt !== rightAt) return rightAt - leftAt
      return byName(left, right)
    })
  }

  const direction = mode === 'messages-desc' ? -1 : 1
  return sorted.sort((left, right) => {
    const leftCount = left.messageCount
    const rightCount = right.messageCount
    if (leftCount === null && rightCount === null) return byName(left, right)
    if (leftCount === null) return 1
    if (rightCount === null) return -1
    if (leftCount !== rightCount) return (leftCount - rightCount) * direction
    return byName(left, right)
  })
}

export function filterConversationOptions(
  options: readonly ConversationSelectOption[],
  criteria: {
    query?: string
    typeFilter?: ConversationTypeFilter
    onlySelected?: boolean
    selectedIds?: readonly string[]
  }
): ConversationSelectOption[] {
  const query = normalize(criteria.query ?? '')
  const selected = new Set(criteria.selectedIds ?? [])
  return options.filter((option) => {
    if (criteria.typeFilter && criteria.typeFilter !== 'all' && option.type !== criteria.typeFilter) {
      return false
    }
    if (criteria.onlySelected && !selected.has(option.conversationId)) return false
    if (!query) return true
    return (
      normalize(option.name).includes(query) || normalize(option.keywords).includes(query)
    )
  })
}

/** 已知条数之和；有未知项时 `unknownCount > 0`，调用方必须显示「至少」。 */
export function summarizeSelection(
  options: readonly ConversationSelectOption[],
  selectedIds: readonly string[]
): { conversations: number; messages: number; unknownCount: number } {
  const selected = new Set(selectedIds)
  let messages = 0
  let unknownCount = 0
  for (const option of options) {
    if (!selected.has(option.conversationId)) continue
    if (option.messageCount === null) unknownCount += 1
    else messages += option.messageCount
  }
  return { conversations: selected.size, messages, unknownCount }
}

export function formatConversationCount(
  count: number | null,
  approximate: boolean,
  measured = true
): string {
  // 失败是"未知"，不是"永远统计中"：这两种状态必须能分辨，否则用户会一直等。
  if (count === null) return measured ? '未知' : '统计中'
  const text = count.toLocaleString()
  return approximate ? `≥ ${text}` : text
}

const ROW_HEIGHT = 52
const LIST_HEIGHT = 300
const VIRTUALIZE_THRESHOLD = 60

interface ConversationMultiSelectProps {
  options: readonly ConversationSelectOption[]
  selectedIds: readonly string[]
  onChange: (conversationIds: string[]) => void
  disabled?: boolean
  /** 空列表时的提示，例如「还没有可索引的会话」。 */
  emptyHint?: string
  /** 触发器上的说明文案，两个页面语义不同，必须各自写清楚。 */
  triggerLabel?: string
}

/** 选择状态由父组件持有：两个页面的语义不同（单次查询 vs 长期索引），组件不持久化。 */
export function ConversationMultiSelect({
  options,
  selectedIds,
  onChange,
  disabled,
  emptyHint = '没有匹配的会话',
  triggerLabel = '选择会话'
}: ConversationMultiSelectProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [sortMode, setSortMode] = React.useState<ConversationSortMode>('messages-desc')
  const [typeFilter, setTypeFilter] = React.useState<ConversationTypeFilter>('all')
  const [onlySelected, setOnlySelected] = React.useState(false)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)

  const selectedSet = React.useMemo(() => new Set(selectedIds), [selectedIds])
  const visible = React.useMemo(
    () =>
      sortConversationOptions(
        filterConversationOptions(options, { query, typeFilter, onlySelected, selectedIds }),
        sortMode
      ),
    [options, query, typeFilter, onlySelected, selectedIds, sortMode]
  )
  const summary = React.useMemo(
    () => summarizeSelection(options, selectedIds),
    [options, selectedIds]
  )

  const toggle = React.useCallback(
    (conversationId: string): void => {
      const next = new Set(selectedIds)
      if (next.has(conversationId)) next.delete(conversationId)
      else next.add(conversationId)
      onChange(Array.from(next))
    },
    [onChange, selectedIds]
  )

  const selectVisible = React.useCallback((): void => {
    const next = new Set(selectedIds)
    for (const option of visible) next.add(option.conversationId)
    onChange(Array.from(next))
  }, [onChange, selectedIds, visible])

  const virtualize = visible.length > VIRTUALIZE_THRESHOLD
  const virtualizer = useVirtualizer({
    count: virtualize ? visible.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8
  })

  const triggerText = summary.conversations
    ? `已选 ${summary.conversations} 个会话`
    : triggerLabel

  return (
    <div className="conversation-multi-select">
      <button
        type="button"
        className={cn('cms-trigger', open && 'is-open')}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="cms-trigger-label">{triggerText}</span>
        <span className="cms-trigger-count">
          {summary.conversations
            ? `${summary.unknownCount ? '至少 ' : ''}${summary.messages.toLocaleString()} 条消息`
            : '未选择'}
        </span>
      </button>

      {open ? (
        <div className="cms-panel" role="dialog" aria-label="选择会话">
          <div className="cms-toolbar">
            <input
              className="cms-search"
              type="search"
              value={query}
              placeholder="搜索群名、备注、昵称或微信号"
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              className="cms-select"
              value={sortMode}
              aria-label="排序方式"
              onChange={(event) => setSortMode(event.target.value as ConversationSortMode)}
            >
              {(Object.keys(CONVERSATION_SORT_LABELS) as ConversationSortMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {CONVERSATION_SORT_LABELS[mode]}
                </option>
              ))}
            </select>
          </div>

          <div className="cms-filters">
            {(
              [
                ['all', '全部'],
                ['group', '仅群聊'],
                ['user', '仅单聊'],
                ['selected', '仅已选']
              ] as const
            ).map(([value, label]) => {
              const active =
                value === 'selected' ? onlySelected : !onlySelected && typeFilter === value
              return (
                <button
                  key={value}
                  type="button"
                  className={cn('cms-filter', active && 'is-active')}
                  onClick={() => {
                    if (value === 'selected') {
                      setOnlySelected(true)
                      return
                    }
                    setOnlySelected(false)
                    setTypeFilter(value)
                  }}
                >
                  {label}
                </button>
              )
            })}
            <span className="cms-filter-spacer" />
            <button type="button" className="cms-link" onClick={selectVisible}>
              选择当前结果
            </button>
            <button
              type="button"
              className="cms-link"
              onClick={() => onChange([])}
              disabled={!selectedIds.length}
            >
              清空
            </button>
          </div>

          <div className="cms-list" ref={scrollRef} style={{ height: LIST_HEIGHT }}>
            {visible.length === 0 ? (
              <p className="cms-empty">{emptyHint}</p>
            ) : virtualize ? (
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const option = visible[item.index]
                  return (
                    <div
                      key={option.conversationId}
                      className="cms-row"
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        height: item.size,
                        transform: `translateY(${item.start}px)`
                      }}
                    >
                      <ConversationRow
                        option={option}
                        checked={selectedSet.has(option.conversationId)}
                        onToggle={toggle}
                      />
                    </div>
                  )
                })}
              </div>
            ) : (
              visible.map((option) => (
                <ConversationRow
                  key={option.conversationId}
                  option={option}
                  checked={selectedSet.has(option.conversationId)}
                  onToggle={toggle}
                />
              ))
            )}
          </div>

          <div className="cms-footer">
            <span>
              已选 {summary.conversations} 个 · 共{' '}
              {summary.unknownCount ? '至少 ' : ''}
              {summary.messages.toLocaleString()} 条消息
              {summary.unknownCount ? ` · ${summary.unknownCount} 个会话数量未知` : ''}
            </span>
            <button type="button" className="cms-link" onClick={() => setOpen(false)}>
              完成
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ConversationRow({
  option,
  checked,
  onToggle
}: {
  option: ConversationSelectOption
  checked: boolean
  onToggle: (conversationId: string) => void
}): React.ReactElement {
  const countText = formatConversationCount(
    option.messageCount,
    option.approximate,
    option.countMeasured
  )
  return (
    <label className="cms-row-inner" data-selected={checked ? 'true' : undefined}>
      <Checkbox
        checked={checked}
        aria-label={option.name}
        onCheckedChange={() => onToggle(option.conversationId)}
      />
      <span className="cms-row-main">
        <span className="cms-row-name">{option.name}</span>
        <span className="cms-row-meta">
          {option.type === 'group' ? '群聊' : '单聊'} · {countText} 条
          {option.messageCount !== null && option.approximate ? '（估算）' : ''}
        </span>
      </span>
    </label>
  )
}
