import React from 'react'
import { Button } from '../../components/ui'

/**
 * LeaveMonitorAutomationEntry —— 退群监控页上的「退群通知自动化」入口。
 *
 * 只做导航：跳到「自动化 → 规则 → 退群通知」。
 * 它不变更退群监控的任何配置，也不触发发送。
 *
 * 之所以把职责拆开说清楚：退群监控负责「谁退出了」，
 * 自动化负责「检测到之后做什么」—— 入口名字必须体现这个分界。
 */
export function LeaveMonitorAutomationEntry({
  onOpen
}: {
  onOpen?: () => void
}): React.ReactElement | null {
  if (!onOpen) return null
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onOpen}
      aria-label="配置退群通知自动化"
      className="exit-monitor-automation-entry"
    >
      退群通知自动化 →
    </Button>
  )
}
