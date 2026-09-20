import React, { useEffect, useMemo, useState } from 'react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui'
import {
  describeImageTextCoverage,
  imageTextCoverageState,
  imageTextPhaseLabel,
  imageTextProcessedPercent,
  imageTextStateLabel,
  imageTextStateTone
} from '../../../../shared/image-text-index'
import { useImageTextIndexStatus } from './hooks/useImageTextIndexStatus'
import {
  IndexStatusBadge,
  type IndexStatusTone
} from '../../features/settings/components/IndexStatusBadge'

interface ImageTextIndexSummaryProps {
  dbReady: boolean
  onNotice: (message: string) => void
}

/**
 * 「图片文字索引」卡片（**设置页宽版**）。
 *
 * 为什么不是直接复用 `ImageTextIndexCard`：那个组件是给**问问微信侧栏**写的，
 * 而侧栏最窄时正文只有约 145px（见 `search.scss` 的注释）。
 * 四列 metric 布局塞进 145px 会直接崩掉 —— 反过来让侧栏继续用表格布局又浪费设置页的宽度。
 * 所以两者**共享全部数据来源与文案函数**（`useImageTextIndexStatus` +
 * `shared/image-text-index`），只有**版式**不同。
 *
 * 状态徽章、统计数字、进度条都走公共组件/函数，不存在第二套计算口径。
 */
export function ImageTextIndexSummary({
  dbReady,
  onNotice
}: ImageTextIndexSummaryProps): React.ReactElement {
  const {
    status,
    count,
    counting,
    pending,
    running,
    paused,
    established,
    refreshCount,
    start,
    pause,
    resume,
    cancel,
    resetFailures,
    repair
  } = useImageTextIndexStatus({ dbReady, onNotice })
  const [confirming, setConfirming] = useState(false)
  const [confirmCount, setConfirmCount] = useState<number | null>(null)
  /**
   * 处理范围（天）。`0` = 全部历史。
   *
   * 保留这个选择器是因为它来自真实业务能力，不是装饰：全量回填几万张图没法用来排查问题，
   * 先跑「最近 1 天」才能证明链路真的通了。
   */
  const [rangeDays, setRangeDays] = useState('0')
  const sinceMs = useMemo(() => {
    const days = Number(rangeDays)
    return Number.isFinite(days) && days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : undefined
  }, [rangeDays])

  useEffect(() => {
    if (!dbReady) return
    void refreshCount(sinceMs)
  }, [dbReady, sinceMs, refreshCount])

  const coverage = status?.coverage ?? null
  const progress = status?.progress ?? null
  const coverageState = coverage ? imageTextCoverageState(coverage) : 'not_built'
  const percent = coverage
    ? imageTextProcessedPercent(coverage.processed, coverage.totalImageMessages)
    : 0
  const interrupted = paused || progress?.state === 'cancelled'
  const phaseLabel = progress?.currentPhase ? imageTextPhaseLabel(progress.currentPhase) : null

  const labelInput = {
    progressState: progress?.state,
    running,
    paused,
    established,
    coverageState,
    percent
  }
  const stateLabel = imageTextStateLabel(labelInput)
  const tone = imageTextStateTone(labelInput) as IndexStatusTone

  const detectedImages = count?.totalImageMessages ?? coverage?.totalImageMessages ?? null
  const nothingCounted =
    count !== null && count.scannedConversations === 0 && count.failedConversations > 0
  const failureCount = coverage?.failed ?? 0

  const requestStart = async (): Promise<void> => {
    const fresh = await refreshCount(sinceMs)
    setConfirmCount(fresh?.totalImageMessages ?? detectedImages)
    setConfirming(true)
  }

  return (
    <section className="local-index-card" aria-label="图片文字索引状态">
      <header className="local-index-card-head">
        <div className="local-index-card-title">
          <h3>图片文字索引</h3>
          <p>本地 OCR 提取图片文字，让截图、报价图也能被搜到</p>
        </div>
        <IndexStatusBadge label={stateLabel} tone={tone} />
      </header>

      {/* 未建立：先给一个可核对的图片量，再让用户决定跑不跑 */}
      {!established && !running ? (
        <>
          <div className="local-index-stats">
            <div className="local-index-stat">
              <strong className="local-index-stat-value">
                {counting
                  ? '统计中…'
                  : nothingCounted
                    ? '无法统计'
                    : detectedImages === null
                      ? '—'
                      : detectedImages.toLocaleString()}
              </strong>
              <span className="local-index-stat-label">检测到图片消息</span>
            </div>
          </div>
          <div className="local-index-inline">
            <span className="local-index-stat-label">处理范围</span>
            <Select value={rangeDays} onValueChange={setRangeDays}>
              <SelectTrigger className="h-7 w-[110px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">全部历史</SelectItem>
                <SelectItem value="1">近 1 天</SelectItem>
                <SelectItem value="7">近 7 天</SelectItem>
                <SelectItem value="30">近 30 天</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {nothingCounted ? (
            <p className="local-index-note is-error">
              {`无法统计本账号的图片消息（${count?.error || '读取消息表失败'}）。这不代表没有图片，可以重新统计再试一次。`}
            </p>
          ) : null}
        </>
      ) : null}

      {/* 运行中 / 暂停：原地切进度，按钮按真实状态显隐，不允许重复点 */}
      {(running || paused) && progress ? (
        <div className="local-index-progress">
          <div className="local-index-progress-head">
            <span>识别图片文字</span>
            <span className="local-index-progress-count">
              {progress.processed.toLocaleString()} / {progress.totalImageMessages.toLocaleString()}
            </span>
          </div>
          {/* 复用项目 `Progress`（更新页 / 导出任务中心同一组件），不另起一套轨道样式。 */}
          <Progress
            value={Math.min(100, Math.max(0, progress.percent))}
            aria-label="图片文字索引进度"
          />
          <p className="local-index-note">
            {phaseLabel ?? '正在识别…'}
            {` · 识别出文字 ${progress.indexed.toLocaleString()} · 无文字 ${progress.empty.toLocaleString()}`}
          </p>
        </div>
      ) : null}

      {/* 已建立：四个可核对的数字 */}
      {established && !running && !paused && coverage ? (
        <>
          <div className="local-index-stats is-four">
            <div className="local-index-stat">
              <strong className="local-index-stat-value">
                {coverage.indexed.toLocaleString()}
              </strong>
              <span className="local-index-stat-label">已识别文字</span>
            </div>
            <div className="local-index-stat">
              <strong className="local-index-stat-value">{coverage.empty.toLocaleString()}</strong>
              <span className="local-index-stat-label">无文字图片</span>
            </div>
            <div className="local-index-stat">
              <strong className="local-index-stat-value">
                {coverage.missing.toLocaleString()}
              </strong>
              <span className="local-index-stat-label">图片已清理</span>
            </div>
            <div className="local-index-stat">
              <strong className="local-index-stat-value">{coverage.failed.toLocaleString()}</strong>
              <span className="local-index-stat-label">识别失败</span>
            </div>
          </div>
        </>
      ) : null}

      {progress?.state === 'error' ? (
        <p className="local-index-note is-error">
          {progress.lastError || '图片文字索引建立失败，可以稍后重试。'}
        </p>
      ) : null}
      {coverage?.systemicFailure === true ? (
        <p className="local-index-note is-error">
          {`${(coverage.failed ?? 0).toLocaleString()} 条处理失败，成功识别 0 条 —— 当前无法搜索图片中的文字。`}
        </p>
      ) : null}
      {paused ? (
        <p className="local-index-note">已暂停。已识别的结果都保留了，点「继续」会从断点接着做。</p>
      ) : null}
      {!dbReady ? (
        <p className="local-index-note is-error">请先连接微信数据，然后再建立图片文字索引。</p>
      ) : null}

      {/* footer：左侧覆盖量说明，右侧操作。按钮不再悬浮在 stats 右下角。 */}
      <div className="local-index-footer">
        {established && !running && !paused && coverage ? (
          <p className="local-index-note">{describeImageTextCoverage(coverage)}</p>
        ) : null}
        <div className="local-index-actions">
          {running ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void pause()}
              >
                {pending === 'pause' ? '暂停中…' : '暂停'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void cancel()}
              >
                {pending === 'cancel' ? '取消中…' : '取消'}
              </Button>
            </>
          ) : null}

          {/* 中断过就一定要有「继续」：checkpoint 是保留的，续做不会从头开始。 */}
          {interrupted ? (
            <Button size="sm" disabled={pending !== null} onClick={() => void resume()}>
              {pending === 'resume' ? '继续中…' : '继续'}
            </Button>
          ) : null}

          {!running && !interrupted ? (
            <>
              {/* 修复类操作各自只在很窄的场景有用，收进「更多」；
                平铺出来会让用户面对四个都带「索引」字样的按钮。 */}
              {established || failureCount > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label="更多操作"
                      disabled={pending !== null}
                    >
                      ···
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {established ? (
                      <DropdownMenuItem disabled={pending !== null} onSelect={() => void repair()}>
                        图片内容搜不到？修复搜索索引
                      </DropdownMenuItem>
                    ) : null}
                    {failureCount > 0 ? (
                      <DropdownMenuItem
                        disabled={pending !== null}
                        onSelect={() => void resetFailures()}
                      >
                        {`重试识别失败的图片（${failureCount.toLocaleString()} 张）`}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <Button
                size="sm"
                disabled={!dbReady || pending !== null || counting}
                onClick={() => void requestStart()}
              >
                {/* 统计图片数期间按钮是禁用的；这时如实说"统计中"，
                  而不是灰着一个写着「更新索引」却点不动的按钮。 */}
                {counting ? '统计中…' : established ? '更新索引' : '建立图片文字索引'}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* 确认弹窗复用 `confirming` 状态；保持与侧栏卡片一致的二次确认语义。 */}
      {confirming ? (
        <div className="local-index-confirm" role="dialog" aria-label="建立图片文字索引">
          <p>
            当前账号检测到约{' '}
            <strong>
              {confirmCount === null ? '未知数量' : confirmCount.toLocaleString()} 条图片消息
            </strong>
            。
          </p>
          <p>
            识别仅在本机进行，原始图片不会因为本地识别而自动上传；可能需要较长时间，可以暂停稍后继续。
          </p>
          <div className="local-index-actions">
            <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setConfirming(false)
                void start({ ...(sinceMs ? { sinceMs } : {}) })
              }}
            >
              开始索引
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
