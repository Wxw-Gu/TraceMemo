import * as React from 'react'

import { Button, Switch, useToast } from '../../components/ui'
import type {
  ScheduledReportNotificationCapability,
  ScheduledReportNotificationSettings
} from '../../../../shared/scheduled-report'
import type { AutomationRule } from '../../../../shared/automation'
import { automationApi } from './model/api'

/**
 * ScheduledReportNotificationPanel —— **微信异常通知**的入口。
 *
 * 这是「定时日报」功能的一项**全局能力**（不是某条规则的配置）：
 * 定时任务在生成 / 发送失败时，经 Agent Hub 给用户推一条微信。
 *
 * 迁移前它挂在旧「日报 → 定时日报」页面上；那个页面退役后，入口挪到这里 ——
 * 能力本身一行没改，绝不因为删页面而静默丢掉。
 */

export interface ScheduledReportNotificationPanelProps {
  /** 当前正在编辑的规则（用于「发送测试错误通知」；新建时可传 null）。 */
  rule: AutomationRule | null
  /** 异常通知依赖 Agent Hub：未就绪时给一个可操作的去处。 */
  onOpenAgentHub?: () => void
}

export function ScheduledReportNotificationPanel({
  rule,
  onOpenAgentHub
}: ScheduledReportNotificationPanelProps): React.ReactElement {
  const { toast } = useToast()
  const [settings, setSettings] = React.useState<ScheduledReportNotificationSettings>({
    enabled: false
  })
  const [capability, setCapability] = React.useState<ScheduledReportNotificationCapability>({
    ready: false
  })
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)

  const load = React.useCallback(async (): Promise<void> => {
    const [nextSettings, nextCapability] = await Promise.all([
      automationApi.getScheduledReportNotificationSettings(),
      automationApi.getScheduledReportNotificationCapability()
    ])
    setSettings(nextSettings)
    setCapability(nextCapability)
  }, [])

  React.useEffect(() => {
    let disposed = false
    setLoading(true)
    void load().finally(() => {
      if (!disposed) setLoading(false)
    })
    return () => {
      disposed = true
    }
  }, [load])

  const handleToggle = async (enabled: boolean): Promise<void> => {
    setSaving(true)
    const result = await automationApi.setScheduledReportNotificationEnabled(enabled)
    setSaving(false)
    if (!result.success) {
      // 开启失败时 main 侧会带出真实原因（Agent Hub 未连接 / 未绑定接收者 / 测试发送失败）。
      toast({
        description: result.error || '异常通知设置失败',
        variant: 'destructive',
        duration: 4000
      })
      await load()
      return
    }
    setSettings(result.data)
    toast({
      description: result.data.enabled ? '已开启微信异常通知' : '已关闭微信异常通知',
      duration: 2800
    })
  }

  const handleTest = async (): Promise<void> => {
    if (!rule) {
      toast({ description: '请先保存这条定时日报，再发送测试通知', variant: 'destructive', duration: 3200 })
      return
    }
    setTesting(true)
    const result = await automationApi.testScheduledReportErrorNotification(rule.id)
    setTesting(false)
    toast({
      description: result.success ? '测试通知已发送，请查看微信' : result.error || '测试通知发送失败',
      variant: result.success ? undefined : 'destructive',
      duration: 4000
    })
  }

  const capabilityHint = capability.ready
    ? capability.recipient
      ? `通知将发送给：${capability.recipient}`
      : '通知接收者已就绪'
    : capability.error || '异常通知能力尚未就绪。'

  return (
    <section className="automation-section automation-notification-panel">
      <div className="automation-section-heading">
        <h3>微信异常通知</h3>
      </div>
      <p className="automation-section-lead">
        定时日报生成或发送失败时，通过 Agent Hub 给你发一条微信。关闭后不会再推送。
      </p>

      <div className="automation-inline-row">
        <div>
          <span className="automation-field-label">开启异常通知</span>
          <small>{capabilityHint}</small>
          {!capability.ready && onOpenAgentHub ? (
            <Button variant="link" size="sm" onClick={onOpenAgentHub}>
              去连接 Agent Hub
            </Button>
          ) : null}
        </div>
        <Switch
          checked={settings.enabled}
          disabled={loading || saving || (!capability.ready && !settings.enabled)}
          onCheckedChange={(checked) => void handleToggle(checked)}
          aria-label="开启微信异常通知"
        />
      </div>

      {settings.enabled ? (
        <div className="automation-inline-row">
          <div>
            <span className="automation-field-label">发送测试错误通知</span>
            <small>验证 Agent Hub 推送链路是否通畅。</small>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={testing || !rule}
            onClick={() => void handleTest()}
          >
            {testing ? '发送中…' : '发送测试'}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
