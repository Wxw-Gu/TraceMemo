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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
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
 * 文案遵从严禁混淆的语义：这里做的是「识别图片中文字」，不是
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
   * 刻意不在这里做 `Math.round(x * 100)` —— 那会把 99.5% 显示成 100%，
   * 于是出现"已建立 · 仅完成 100%"这种自相矛盾的显示。未完成时封顶 99.9%。
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

  /** 识别失败的图片数（派生库的真实统计），决定「更多」里有没有重试入口。 */
  const failureCount = coverage?.failed ?? 0

  /**
   * 中断但**可续做**。
   *
   * `paused` 和 `cancelled` 都能靠 checkpoint 从断点接上（`startPass` 会跳过已完成会话、
   * 命中已有 artifact 不再重复 OCR），所以两者必须给**同一个**「继续」入口。
   * 只认 `paused` 的后果真实发生过：点过「取消」之后卡片只剩「更新图片文字索引」，
   * 状态还被显示成「部分完成 · 2.1%」—— 用户既看不出自己中断过，也找不到继续的地方。
   */
  const interrupted = paused || progress?.state === 'cancelled'

  const stateLabel = (() => {
    if (progress?.state === 'error') return '建立失败'
    if (running) return `建立中 · ${percent}%`
    if (paused) return `已暂停 · ${percent}%`
    // 取消 ≠ 部分完成：进度是保留的，但"被打断过"这件事必须说出来。
    if (progress?.state === 'cancelled') return `已取消 · ${percent}%`
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
            {/*
              速度用最近窗口的实测值（Main 给的就是窗口速度，不是全程平均）。
              样本还不足时如实说"计算中"，不要编一个数 —— 全量回填要跑几小时，
              一个假 ETA 比没有 ETA 更糟。
            */}
            <p
              className="ai-search-knowledge-pass-line"
              data-testid="image-text-index-rate"
            >
              {`当前速度：${
                typeof progress.speedPerSec === 'number' && progress.speedPerSec > 0
                  ? `约 ${progress.speedPerSec.toFixed(1)} 张/秒`
                  : '计算中'
              } · 预计剩余：${formatEta(progress.etaMs)}`}
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

        {/* 这张卡最多并列 3 个操作，横向排会撑破窄侧栏；修饰类把它改成单列堆叠。 */}
        <div className="ai-search-knowledge-actions ai-search-image-index-actions">
          {!running && !interrupted && (
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
          {/*
            修复类操作收进「更多」。

            它们各自只在很窄的情况下才有用（搜索索引不一致 / 有识别失败的图片），
            而主路径永远只有一个：更新索引。平铺出来时，用户看到的是四个都在说
            「索引」的按钮，只能靠猜哪个该点。
          */}
          {!running && (established || failureCount > 0) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="ai-search-knowledge-cancel"
                  data-testid="image-text-index-more"
                  disabled={pending !== null}
                >
                  更多
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* 派生索引修复：只重建 Knowledge 里的图片搜索索引，**不重新识别任何图片**。
                    存在的意义就是"别为修一个索引问题重跑几万张图"。 */}
                {established && (
                  <DropdownMenuItem
                    data-testid="image-text-index-repair"
                    disabled={pending !== null}
                    onSelect={() => void repair()}
                  >
                    图片内容搜不到？修复搜索索引
                  </DropdownMenuItem>
                )}
                {/* 修好之后重跑：只重置失败记录，成功记录与其它数据一律不动。 */}
                {failureCount > 0 && (
                  <DropdownMenuItem
                    data-testid="image-text-index-reset-failures"
                    disabled={pending !== null}
                    onSelect={() => void resetFailures()}
                  >
                    {`重试识别失败的图片（${failureCount.toLocaleString()} 张）`}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
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
          {/*
            中断（暂停 / 取消）之后必须能找到「继续」。
            两种状态的 checkpoint 都是保留的，继续 = 从断点接上，
            所以这里刻意合并成一个入口 —— 否则「取消」过的索引会只剩
            「更新图片文字索引」，用户根本看不出还能接着做。
          */}
          {interrupted && (
            <Button
              size="sm"
              className="ai-search-knowledge-primary"
              data-testid="image-text-index-resume"
              disabled={pending !== null}
              onClick={() => void resume()}
            >
              {pending === 'resume' ? '继续中…' : '继续'}
            </Button>
          )}
          {/* 只有真的处在"暂停中"才有东西可取消：已取消的状态再点取消没有意义。 */}
          {paused && (
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

/**
 * 剩余时间文案。
 *
 * `null` = 分母不可信或速度样本还不足 —— 如实说"计算中"。
 * 刻意不显示 p50 / p95 这类开发指标：这是用户界面，不是性能面板。
 */
function formatEta(etaMs: number | null | undefined): string {
  if (typeof etaMs !== 'number' || !Number.isFinite(etaMs) || etaMs <= 0) return '计算中'
  const totalMinutes = Math.round(etaMs / 60_000)
  if (totalMinutes < 1) return '不到 1 分钟'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`
}
