import * as React from 'react'
import {
  MSG_INSERT_SWITCH_LABELS,
  type MsgInsertApplyResult,
  type MsgInsertSwitchName,
  type MsgInsertSwitchStatus,
  type MsgInsertSwitchesSnapshot
} from '../../../../shared/msg-insert-switch'
import { Switch, Spinner, useToast } from '../../components/ui'

/**
 * 「微信消息插入开关」—— 自动化页右上角的两个开关。
 *
 * 分工：
 *   开关值存在 native 侧（每个消息分片 `_tm_config` 表），真正干活的是挂在
 *   `Msg_<md5(roomId)>` 表上的规则；写入由主进程 spawn 一次性 helper 完成。
 *   这里只负责展示与触发，不做任何平台判断。
 *
 * 三个状态都要如实展示，不能只画一个 boolean：
 *   desiredEnabled    用户意图（开关值）
 *   effectiveEnabled  是否真的生效（目标会话规则齐 + 开关值落到相关分片）
 *   ready / total     目标会话的覆盖情况
 *
 * 打开时先 loading、成功才 ON、失败回滚；写失败与「规则没装齐」是两种不同的
 * 提示，不混成一句「设置失败」。
 */
/* 首次拉取失败时的有界重试：2s 一次，最多 20 次（约 40s）。连上即停。 */
const BLOCKED_RETRY_LIMIT = 20
const BLOCKED_RETRY_INTERVAL_MS = 2000

/** 运行期刷新的低频兜底间隔。开销说明见 `refreshQuietly`：指纹没变时只是一次本地读。 */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000

export function MessageInsertSwitches(): React.JSX.Element {
  const { toast } = useToast()
  const [snapshot, setSnapshot] = React.useState<MsgInsertSwitchesSnapshot | null>(null)
  const [pending, setPending] = React.useState<MsgInsertSwitchName | null>(null)
  const [blockedReason, setBlockedReason] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)

  /**
   * 拉一次状态。返回是否成功 —— 调用方据此决定要不要重试。
   */
  const refresh = React.useCallback(async (): Promise<boolean> => {
    const api = window.api
    if (!api?.getMsgInsertSwitches) {
      setBlockedReason('当前版本不支持微信消息插入开关')
      setLoading(false)
      return false
    }
    try {
      const result = await api.getMsgInsertSwitches()
      setSnapshot(result)
      /* 数据库没连上时不能假装能改；但已经有数据时不要把界面打回禁用态。 */
      setBlockedReason(result.success ? null : result.detail || '微信数据库尚未连接')
      return result.success
    } catch (error) {
      setBlockedReason(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setLoading(false)
    }
  }, [])

  /*
   * 首次拉取失败要**有界重试**。
   *
   * 自动化页常常在微信库还没连上的时候就被打开（冷启动、刚切库、微信还没起来），
   * 这时只拉一次就会把开关永久置灰 —— 用户看到的是「灰的」，但真实原因只是「还没连上」，
   * 而且切走再回来才会恢复。所以这里连上就停、连不上退避重试，最多 20 次（约 40s）。
   *
   * 不轮询：一旦拿到 success=true 就彻底停，不会有常驻定时器。
   */
  React.useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    const run = async (): Promise<void> => {
      const ok = await refresh()
      if (cancelled || ok || attempt >= BLOCKED_RETRY_LIMIT) return
      attempt += 1
      timer = setTimeout(() => void run(), BLOCKED_RETRY_INTERVAL_MS)
    }
    void run()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [refresh])

  /**
   * 运行期刷新：**窗口重新聚焦** + **低频兜底**。
   *
   * 只在挂载时拉一次不够用：微信运行期间会新建 `message_N.db`，目标会话集合随之变化，
   * 而规则补齐只在启动时跑过一次 —— 于是 `ready / total` 会一直差着几个。
   *
   * 刻意不做高频轮询：主进程侧会先比对消息分片清单指纹，没变就只做纯读立刻返回，
   * 变了才 spawn 一次 helper，所以这一次调用的实际开销通常只是一次本地读。
   */
  const refreshQuietly = React.useCallback(async (): Promise<void> => {
    const api = window.api
    if (!api?.refreshMsgInsertSwitches) return
    try {
      const result = await api.refreshMsgInsertSwitches()
      setSnapshot(result)
      if (result.success) setBlockedReason(null)
    } catch {
      /* 静默：一次后台刷新失败不应该把已经可用的界面打回禁用态。 */
    }
  }, [])

  React.useEffect(() => {
    const timer = window.setInterval(() => void refreshQuietly(), REFRESH_INTERVAL_MS)
    const onFocus = (): void => void refreshQuietly()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refreshQuietly])

  /** 把结果里的失败原因翻成人话；native code 只进日志。 */
  const humanize = React.useCallback((result: MsgInsertApplyResult): string => {
    const status = result.status
    if (result.errorCode === 'HELPER_NOT_FOUND') return '缺少写入组件，请重新安装或更新 TraceMemo'
    if (result.errorCode === 'DATABASE_UNAVAILABLE') return '微信数据库未连接'
    if (result.errorCode === 'NO_TARGET_ROOMS') return '没有可作用的目标会话'
    if (status && status.failedShards > 0) {
      return `设置失败：${status.failedShards} 个消息库写入失败`
    }
    if (
      status &&
      status.totalInstallableRooms > 0 &&
      status.readyInstallableRooms < status.totalInstallableRooms
    ) {
      return `开启失败：${
        status.totalInstallableRooms - status.readyInstallableRooms
      } 个会话的消息规则安装失败`
    }
    return result.message || '设置失败，请稍后重试'
  }, [])

  const handleToggle = React.useCallback(
    async (name: MsgInsertSwitchName, next: boolean): Promise<void> => {
      const api = window.api
      if (!api?.setMsgInsertSwitch || pending) return
      setPending(name)
      try {
        const result = await api.setMsgInsertSwitch(name, next)
        /* 不乐观更新：写的是微信库里的规则 + 开关，失败必须回滚到真实状态。
         * 先拿主进程只读复核的结果，再决定开关画成什么。 */
        setSnapshot((prev) =>
          prev ? { ...prev, switches: { ...prev.switches, [name]: result.status } } : prev
        )
        if (!result.success) {
          toast({ description: humanize(result), variant: 'destructive', duration: 4000 })
          /* 复核一次，确保界面与库里真实状态一致（而不是停在乐观值上）。 */
          await refresh()
          return
        }
        if (result.detail) console.warn('[MsgInsert]', result.detail)
        await refresh()
      } catch (error) {
        toast({
          description: error instanceof Error ? error.message : '设置失败',
          variant: 'destructive',
          duration: 4000
        })
        await refresh()
      } finally {
        setPending(null)
      }
    },
    [humanize, pending, refresh, toast]
  )

  /*
   * helper 缺失时**提前**禁用，而不是等用户点了再弹「缺少写入组件」。
   * 写开关必须靠那个一次性子进程，缺了它这个开关根本没法工作 ——
   * 让人点了才失败是最差的一种交互。
   */
  /*
   * 写入组件缺失 = **这个能力还没开放**，不是安装坏了。
   *
   * 主进程对微信库只有只读连接，任何写入都要 spawn 那个一次性写入组件；当前分发的
   * 安装包不带它（它随发送运行时按需分发），所以「微信内防撤回提示」与
   * 「微信内退群监控消息」一律按"下个版本开放"呈现 —— 不该让用户去排查自己的安装。
   * （machine-readable 的原因仍然是 snapshot.helperAvailable，授权层可以据此判断。）
   */
  const helperMissing = snapshot?.helperAvailable === false
  const blocked = blockedReason ?? (helperMissing ? '该能力将在下个版本开放' : null)
  const disabled = blocked !== null

  return (
    <div className="automation-msg-insert-switches" title={blocked ?? undefined}>
      {loading ? <Spinner /> : null}
      {MSG_INSERT_SWITCH_LABELS.map(({ name, label, hint }) => {
        const status: MsgInsertSwitchStatus | undefined = snapshot?.switches?.[name]
        const busy = pending === name
        /* rules 型：显示「已就绪 / 可安装」；事件驱动型没有覆盖率这个概念。 */
        const showCoverage = status?.mode === 'rules' && status.totalInstallableRooms > 0
        const partial =
          status?.desiredEnabled === true &&
          status.totalInstallableRooms > 0 &&
          status.readyInstallableRooms < status.totalInstallableRooms
        /* 内部口径（roomsWithoutTable 之类的「暂无消息表」计数）不面向普通用户，
         * 只留在诊断/tooltip 里，不上主界面。 */
        const scopeHint =
          status?.mode === 'event' && (status.monitoredRoomCount || 0) > 0
            ? `覆盖全部群聊（${status.monitoredRoomCount} 个）`
            : null
        return (
          /* 刻意用 span 而不是 label：<label> 会把点击转发给里面的 Switch，
             于是「点文字」也会切换开关。写微信库的开关不该这么容易被误触。 */
          <span
            key={name}
            className={`automation-msg-insert-switch ${disabled ? 'is-disabled' : ''}`}
            title={[hint, status?.message].filter(Boolean).join('\n') || blocked || hint}
          >
            <span className="automation-msg-insert-switch-label">{label}</span>
            {/* 写微信库要 spawn 子进程 + 装规则，耗时以秒计。
                只把开关置灰会让人以为卡死，所以显式给「处理中」。 */}
            {busy ? (
              <span className="automation-msg-insert-switch-busy">
                <Spinner />
                处理中…
              </span>
            ) : null}
            <Switch
              checked={status?.desiredEnabled === true}
              disabled={disabled || pending !== null}
              onCheckedChange={(checked) => void handleToggle(name, checked === true)}
              aria-label={label}
            />
            {status && showCoverage ? (
              <span
                className={`automation-msg-insert-switch-count ${partial ? 'is-warning' : ''}`}
                title="已就绪 / 可安装"
              >
                {partial ? '⚠ ' : ''}
                {status.readyInstallableRooms} / {status.totalInstallableRooms} 已启用
              </span>
            ) : null}
            {scopeHint ? (
              <span className="automation-msg-insert-switch-scope" title="覆盖范围，不是规则覆盖率">
                {scopeHint}
              </span>
            ) : null}
          </span>
        )
      })}
    </div>
  )
}
