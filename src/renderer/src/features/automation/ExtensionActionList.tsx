import * as React from 'react'
import type { AutomationAction } from '../../../../shared/automation'
import type { ExtensionActionInfo } from '../../../../shared/extensions/types'
import type { ExtensionActionInputSchema } from '../../../../shared/extensions/action-schema'
import { Button, Input, Switch } from '../../components/ui'

interface ExtensionActionListProps {
  /** 完整动作数组（含固定动作），本组件只挑 `extensionAction`。 */
  actions: AutomationAction[]
  available: ExtensionActionInfo[]
  onChange: (next: AutomationAction[]) => void
}

/**
 * 扩展动作编辑区。
 *
 * 按**数组索引**定位要改的那一条：同类型动作可以有多个，
 * 按 `type` 批量更新会把它们一起改掉。
 */
export function ExtensionActionList({
  actions,
  available,
  onChange
}: ExtensionActionListProps): React.ReactElement {
  const [pendingExtension, setPendingExtension] = React.useState('')
  const [pendingAction, setPendingAction] = React.useState('')

  const extensionActions = actions
    .map((action, index) => ({ action, index }))
    .filter((item) => item.action.type === 'extensionAction')

  const groups = React.useMemo(() => {
    const map = new Map<string, { name: string; actions: ExtensionActionInfo[] }>()
    for (const item of available) {
      const entry = map.get(item.extensionId) ?? { name: item.extensionName, actions: [] }
      entry.actions.push(item)
      map.set(item.extensionId, entry)
    }
    return Array.from(map.entries()).sort((left, right) =>
      left[1].name.localeCompare(right[1].name)
    )
  }, [available])

  const patchAt = (index: number, patch: Partial<AutomationAction>): void => {
    onChange(
      actions.map((action, current) => (current === index ? { ...action, ...patch } : action))
    )
  }

  const removeAt = (index: number): void => {
    onChange(actions.filter((_action, current) => current !== index))
  }

  const addAction = (): void => {
    const info = available.find(
      (item) => item.extensionId === pendingExtension && item.actionId === pendingAction
    )
    if (!info) return
    const input: Record<string, unknown> = {}
    if (info.inputSchema) {
      for (const [key, field] of Object.entries(info.inputSchema.properties)) {
        if (field.default !== undefined) input[key] = field.default
      }
    }
    onChange([
      ...actions,
      {
        type: 'extensionAction',
        enabled: true,
        extensionId: info.extensionId,
        actionId: info.actionId,
        input
      }
    ])
    setPendingAction('')
  }

  const actionsOfSelectedExtension = pendingExtension
    ? available.filter((item) => item.extensionId === pendingExtension)
    : []

  return (
    <div className="automation-extension-actions">
      {extensionActions.length === 0 ? (
        <p className="automation-muted">还没有扩展动作。扩展启用后这里会出现它注册的动作。</p>
      ) : (
        extensionActions.map(({ action, index }) => {
          const info = available.find(
            (item) => item.extensionId === action.extensionId && item.actionId === action.actionId
          )
          const schema: ExtensionActionInputSchema | undefined = info?.inputSchema
          const input = action.input ?? {}
          return (
            <div
              key={`${action.extensionId}-${action.actionId}-${index}`}
              className="automation-action-row"
            >
              <div className="automation-action-main">
                <div className="automation-switch-row compact">
                  <div>
                    <span className="automation-field-label">
                      {info?.title || action.actionId || '未知动作'}
                      <span className="automation-extension-badge">
                        {info?.extensionName || action.extensionId}
                      </span>
                    </span>
                    <small>
                      {info?.available
                        ? info.description || '扩展动作'
                        : info?.unavailableReason || '依赖的扩展不可用，规则会保留但无法执行'}
                    </small>
                  </div>
                  <Switch
                    checked={action.enabled}
                    onCheckedChange={(checked) => patchAt(index, { enabled: checked })}
                  />
                </div>

                {schema && action.enabled && (
                  <div className="automation-extension-fields">
                    {Object.entries(schema.properties).map(([key, field]) => {
                      const required = schema.required?.includes(key) === true
                      const label = field.title || key
                      const value = input[key]
                      return (
                        <label key={key} className="automation-field">
                          <span className="automation-field-label">
                            {label}
                            {required && <span className="automation-required">*</span>}
                          </span>
                          {field.type === 'boolean' ? (
                            <Switch
                              checked={value === true}
                              onCheckedChange={(checked) =>
                                patchAt(index, { input: { ...input, [key]: checked } })
                              }
                            />
                          ) : (
                            <Input
                              type={field.type === 'string' ? 'text' : 'number'}
                              value={value === undefined || value === null ? '' : String(value)}
                              placeholder={field.description || ''}
                              onChange={(event) => {
                                const raw = event.target.value
                                const next: unknown =
                                  field.type === 'string'
                                    ? raw
                                    : raw === ''
                                      ? undefined
                                      : Number(raw)
                                patchAt(index, { input: { ...input, [key]: next } })
                              }}
                            />
                          )}
                        </label>
                      )
                    })}
                  </div>
                )}

                <div className="automation-extension-row-actions">
                  <Button size="sm" variant="ghost" onClick={() => removeAt(index)}>
                    移除
                  </Button>
                </div>
              </div>
            </div>
          )
        })
      )}

      <div className="automation-extension-add">
        <select
          className="automation-select"
          value={pendingExtension}
          aria-label="选择扩展"
          onChange={(event) => {
            setPendingExtension(event.target.value)
            setPendingAction('')
          }}
        >
          <option value="">选择扩展…</option>
          {groups.map(([extensionId, group]) => (
            <option key={extensionId} value={extensionId}>
              {group.name}
              {group.actions.every((item) => !item.available) ? '（不可用）' : ''}
            </option>
          ))}
        </select>
        <select
          className="automation-select"
          value={pendingAction}
          aria-label="选择动作"
          disabled={!pendingExtension}
          onChange={(event) => setPendingAction(event.target.value)}
        >
          <option value="">选择动作…</option>
          {actionsOfSelectedExtension.map((item) => (
            <option key={item.actionId} value={item.actionId} disabled={!item.available}>
              {item.title}
              {item.available ? '' : `（${item.unavailableReason || '不可用'}）`}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          disabled={!pendingExtension || !pendingAction}
          onClick={addAction}
        >
          添加扩展动作
        </Button>
      </div>
    </div>
  )
}
