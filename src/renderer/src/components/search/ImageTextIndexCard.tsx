import { useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui'
import {
  describeImageTextCoverage,
  imageTextCoverageState,
  imageTextProcessedPercent
} from '../../../../shared/image-text-index'
import { useImageTextIndexStatus } from './hooks/useImageTextIndexStatus'

type ImageTextIndexCardProps = {
  /** 微信数据是否就绪。 */
  dbReady: boolean
  onNotice: (message: string) => void
}

/**
 * 「图片文字索引」卡片。
 *
 * 与 Knowledge 卡片**平级并列**（同一组索引入口），但刻意是**独立的一维能力**：
 * 文字消息索引完整不代表图片里的文字搜得到。
 *
 * 文案遵从严禁混淆的语义（§9）：这里做的是「识别图片中文字」，不是
 * 「本地识图模型 / 本地 Vision / AI OCR」，也不能暗示能理解场景或表情包。
 */
export function ImageTextIndexCard({ dbReady, onNotice }: ImageTextIndexCardProps): ReactElement {
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
   * 处理时间范围（天）。
   *
   * 存在的意义是**可验证性**：几万张图片的全量回填没法拿来排查问题，
   * 先跑"最近 1 天"这种小窗口才能证明链路真的通了。`0` = 全部历史。
   */
  const [rangeDays, setRangeDays] = useState('0')
  const sinceMs = useMemo(() => {
    const days = Number(rangeDays)
    return Number.isFinite(days) && days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : undefined
  }, [rangeDays])

  // 进页面 / 切换范围时统计一次（数字必须与当前窗口一致，否则确认弹窗会说谎）。
  useEffect(() => {
    if (!dbReady) return
    void refreshCount(sinceMs)
  }, [dbReady, sinceMs, refreshCount])

  const coverage = status?.coverage ?? null
  const progress = status?.progress ?? null
  const coverageState = coverage ? imageTextCoverageState(coverage) : 'not_built'
  /**
   * 处理进度百分比。
   *
   * 刻意不在这里做 `Math.round(x * 100)` —— `45479 / 45707` 会被四舍五入成 `100`，
   * 于是出现了"已建立 · 仅完成 100%"这种自相矛盾的显示。未完成时封顶 99.9%。
   */
  const percent = coverage
    ? imageTextProcessedPercent(coverage.processed, coverage.totalImageMessages)
    : 0
  const systemicFailure = coverage?.systemicFailure === true
  const visualState =
    progress?.state === 'error' || coverageState === 'failed'
      ? 'error'
      : running
        ? 'syncing'
        : paused
          ? 'cancelled'
          : !established
            ? 'unavailable'
            : coverageState === 'complete'
              ? 'ready'
              : 'building'

  const detectedImages = count?.totalImageMessages ?? coverage?.totalImageMessages ?? null
  const countFailed = count !== null && count.failedConversations > 0
  /**
   * 一个会话都没数成。
   *
   * 这时**绝不能显示 0** —— 那会让用户以为账号里没有图片，从而放弃建立索引。
   * 数不出来和确实没有是两件事。
   */
  const nothingCounted =
    count !== null && count.scannedConversations === 0 && count.failedConversations > 0

  const stateLabel = (() => {
    if (progress?.state === 'error') return '建立失败'
    if (running) return `建立中 · ${percent}%`
    if (paused) return `已暂停 · ${percent}%`
    if (!established) return '未建立'
    // 「已建立」不能等于「全失败」：处理过但一条都没成功时必须叫异常。
    if (coverageState === 'failed') return '图片文字索引异常'
    if (coverageState === 'complete') return '已完成'
    return `部分完成 · ${percent}%`
  })()

  /**
   * 点「建立图片文字索引」：**先重新统计、再弹确认**。
   *
   * 确认弹窗里的数字必须新鲜——用户可能刚在微信里收了一批图片。
   * 统计是纯 SQL COUNT，不解密任何图片，所以这一步够快。
   */
  const requestStart = async (): Promise<void> => {
    const fresh = await refreshCount(sinceMs)
    setConfirmCount(fresh?.totalImageMessages ?? detectedImages)
    setConfirming(true)
  }

  const confirmStart = async (): Promise<void> => {
    setConfirming(false)
    await start({ ...(sinceMs ? { sinceMs } : {}) })
  }

  return (
    <>
      <section
        className={`ai-search-knowledge-card ${visualState}`}
        aria-label="图片文字索引状态"
      >
        <div className="ai-search-knowledge-heading">
          <div className="ai-search-knowledge-heading-text">
            <span className="ai-search-knowledge-kicker">IMAGE TEXT INDEX</span>
            <strong className="ai-search-knowledge-state" data-testid="image-text-index-state">
              {stateLabel}
            </strong>
          </div>
          <span className="ai-search-knowledge-dot" aria-hidden />
        </div>

        <p className="ai-search-knowledge-description">
          让「问问微信」也能搜索微信图片中的文字（截图、报价图、公告截图等）。
          识别在本机进行，原始图片无需发送给 AI Provider。
        </p>

        {/* 未建立：先告诉用户这个账号大概有多少图片，再让他决定要不要跑。 */}
        {!established && !running && (
          <>
            <div className="ai-search-knowledge-rows">
              <div className="ai-search-knowledge-row">
                <span className="ai-search-knowledge-label">检测到的图片消息</span>
                <strong className="ai-search-knowledge-value" data-testid="image-text-index-count">
                  {counting
                    ? '统计中…'
                    : nothingCounted
                      ? '无法统计'
                      : detectedImages === null
                        ? '—'
                        : detectedImages.toLocaleString()}
                </strong>
              </div>
            </div>
            <div className="ai-search-knowledge-row">
              <span className="ai-search-knowledge-label">处理范围</span>
              <Select value={rangeDays} onValueChange={setRangeDays}>
                <SelectTrigger data-testid="image-text-index-range" className="h-6 w-[86px] text-[10px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">全量</SelectItem>
                  <SelectItem value="1">近 1 天</SelectItem>
                  <SelectItem value="7">近 7 天</SelectItem>
                  <SelectItem value="30">近 30 天</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {countFailed && (
              <p className="ai-search-knowledge-error" data-testid="image-text-index-count-error">
                {nothingCounted
                  ? `无法统计本账号的图片消息（${count?.error || '读取消息表失败'}）。这不代表账号里没有图片，可以点「重新统计」再试一次。`
                  : `有 ${count?.failedConversations.toLocaleString()} 个会话未能统计，上面的数字可能偏小。`}
              </p>
            )}
          </>
        )}

        {/* 进度：只给真实数字，绝不显示 native handle / hash / HRESULT。 */}
        {(running || paused) && progress && (
          <div className="ai-search-knowledge-pass">
            <div className="ai-search-knowledge-rows">
              <div className="ai-search-knowledge-row">
                <span className="ai-search-knowledge-label">已处理</span>
                <strong
                  className="ai-search-knowledge-value"
                  data-testid="image-text-index-progress"
                >
                  {`${progress.processed.toLocaleString()} / ${progress.totalImageMessages.toLocaleString()}`}
                </strong>
              </div>
            </div>
            <div className="ai-search-sync-progress-track">
              <span
                style={{
                  width: `${Math.min(100, Math.max(0, progress.percent))}%`,
                  ...(progress.totalImageMessages > 0
                    ? {}
                    : { animation: 'ai-search-indeterminate 1.4s ease-in-out infinite' })
                }}
              />
            </div>
            <p className="ai-search-knowledge-pass-line">
              {`${progress.percent}% · 识别出文字 ${progress.indexed.toLocaleString()} · 没有文字 ${progress.empty.toLocaleString()} · 图片已清理 ${progress.missing.toLocaleString()} · 失败 ${progress.failed.toLocaleString()}`}
            </p>
          </div>
        )}

        {/* 已建立：给一份可核对的明细。 */}
        {established && !running && !paused && coverage && (
          <div className="ai-search-knowledge-rows">
            <div className="ai-search-knowledge-row">
              <span className="ai-search-knowledge-label">已识别出文字</span>
              <strong className="ai-search-knowledge-value">
                {coverage.indexed.toLocaleString()}
              </strong>
            </div>
            <div className="ai-search-knowledge-row">
              <span className="ai-search-knowledge-label">没有文字</span>
              <strong className="ai-search-knowledge-value">{coverage.empty.toLocaleString()}</strong>
            </div>
            <div className="ai-search-knowledge-row">
              <span className="ai-search-knowledge-label">图片已清理</span>
              <strong className="ai-search-knowledge-value">
                {coverage.missing.toLocaleString()}
              </strong>
            </div>
            {coverage.failed > 0 && (
              <div className="ai-search-knowledge-row">
                <span className="ai-search-knowledge-label">识别失败</span>
                <strong className="ai-search-knowledge-value">
                  {coverage.failed.toLocaleString()}
                </strong>
              </div>
            )}
            <p className="ai-search-knowledge-pass-line">{describeImageTextCoverage(coverage)}</p>
          </div>
        )}

        {progress?.state === 'error' && (
          <p className="ai-search-knowledge-error">
            {progress.lastError || '图片文字索引建立失败，可以稍后重试。'}
          </p>
        )}
        {/* 「处理过但一条都没成功」= 索引异常，绝不能显示成"已建立"。 */}
        {systemicFailure && (
          <p
            className="ai-search-knowledge-error"
            data-testid="image-text-index-systemic-failure"
          >
            {`${(coverage?.failed ?? 0).toLocaleString()} 条处理失败，成功识别 0 条 —— 当前无法搜索图片中的文字。`}
          </p>
        )}
        {paused && (
          <p className="ai-search-knowledge-error">
            已暂停。已经识别出的结果都保留了，点「继续」会从断点接着做，不会从第一张重新开始。
          </p>
        )}
        {!dbReady && (
          <p className="ai-search-knowledge-error">请先连接微信数据，然后再建立图片文字索引。</p>
        )}

        <div className="ai-search-knowledge-actions">
          {!running && !paused && (
            <Button
              size="sm"
              className="ai-search-knowledge-primary"
              data-testid="image-text-index-start"
              disabled={!dbReady || pending !== null || counting}
              onClick={() => void requestStart()}
            >
              {established ? '更新图片文字索引' : '建立图片文字索引'}
            </Button>
          )}
          {!running && !paused && countFailed && (
            <Button
              size="sm"
              variant="outline"
              className="ai-search-knowledge-cancel"
              data-testid="image-text-index-recount"
              disabled={pending !== null || counting}
              onClick={() => void refreshCount()}
            >
              {counting ? '统计中…' : '重新统计'}
            </Button>
          )}
          {/* 修好之后重跑：只重置失败记录，成功记录与其它数据一律不动。 */}
          {!running && !paused && systemicFailure && (
            <Button
              size="sm"
              variant="outline"
              className="ai-search-knowledge-cancel"
              data-testid="image-text-index-reset-failures"
              disabled={pending !== null}
              onClick={() => void resetFailures()}
            >
              {pending === 'reset' ? '处理中…' : '重试失败的图片'}
            </Button>
          )}
          {/* 派生索引修复：只重建 Knowledge 里的图片搜索索引，**不重新识别任何图片**。
              存在的意义就是"别为修一个索引问题重跑几万张图"。 */}
          {!running && !paused && established && (
            <Button
              size="sm"
              variant="outline"
              className="ai-search-knowledge-cancel"
              data-testid="image-text-index-repair"
              disabled={pending !== null}
              onClick={() => void repair()}
            >
              {pending === 'repair' ? '修复中…' : '修复图片搜索索引'}
            </Button>
          )}
          {running && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="ai-search-knowledge-cancel"
                data-testid="image-text-index-pause"
                disabled={pending !== null}
                onClick={() => void pause()}
              >
                {pending === 'pause' ? '暂停中…' : '暂停'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="ai-search-knowledge-cancel"
                data-testid="image-text-index-cancel"
                disabled={pending !== null}
                onClick={() => void cancel()}
              >
                {pending === 'cancel' ? '取消中…' : '取消'}
              </Button>
            </>
          )}
          {paused && (
            <>
              <Button
                size="sm"
                className="ai-search-knowledge-primary"
                data-testid="image-text-index-resume"
                disabled={pending !== null}
                onClick={() => void resume()}
              >
                {pending === 'resume' ? '继续中…' : '继续'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="ai-search-knowledge-cancel"
                data-testid="image-text-index-cancel"
                disabled={pending !== null}
                onClick={() => void cancel()}
              >
                取消
              </Button>
            </>
          )}
        </div>
      </section>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>建立图片文字索引</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="ai-search-knowledge-confirm">
            <p>
              当前账号检测到约{' '}
              <strong>
                {confirmCount === null ? '未知数量' : confirmCount.toLocaleString()} 条图片消息
              </strong>
              。
            </p>
            <p>
              建立后，TraceMemo 会在本机读取这些图片中的文字，以后可以在「问问微信」里搜索截图、
              报价图、公告截图等图片里的文字，并按结果回到对应的原始图片消息。
            </p>
            <p>识别过程：</p>
            <ul>
              <li>仅在本机进行识别，原始图片不会因为本地识别而自动上传</li>
              <li>可能需要较长时间，可以暂停并稍后继续</li>
              <li>图片已被微信清理或无法解密时会自动跳过</li>
              <li>实际可识别的数量取决于本地图片文件是否仍然存在</li>
            </ul>
            <p>不会修改或删除微信原始图片与聊天记录。</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              data-testid="image-text-index-confirm"
              onClick={() => void confirmStart()}
            >
              开始索引
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
