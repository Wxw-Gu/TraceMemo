import React, { useEffect, useState } from 'react'
import {
  REPORT_TASK_STEPS,
  ReportGenerationPhase,
  VoiceTranscriptionProgress
} from '../../hooks/useGroupReportGeneration'

interface ReportTaskStatusPanelProps {
  phase: ReportGenerationPhase
  error: string
  voiceTranscriptionProgress: VoiceTranscriptionProgress | null
  voiceTranscriptionEnabled: boolean
  onRetry: () => void
}

export function ReportTaskStatusPanel({
  phase,
  error,
  voiceTranscriptionProgress,
  voiceTranscriptionEnabled,
  onRetry
}: ReportTaskStatusPanelProps): React.ReactElement {
  const taskSteps = voiceTranscriptionEnabled
    ? REPORT_TASK_STEPS
    : REPORT_TASK_STEPS.filter((step) => step.id !== 'transcribingVoice')
  const activeIndex = taskSteps.findIndex((step) => step.id === phase)
  const completedAll = phase === 'success'
  const [logPath, setLogPath] = useState('')

  useEffect(() => {
    void window.api
      .getAppLogPath()
      .then(setLogPath)
      .catch(() => undefined)
  }, [])

  return (
    <aside className="report-task-panel">
      <div className="report-task-header">
        <h2>任务状态</h2>
        <p>
          {completedAll
            ? '生成完成'
            : phase === 'error'
              ? '生成失败'
              : activeIndex >= 0
                ? `${activeIndex + 1}/${taskSteps.length}`
                : '等待开始'}
        </p>
      </div>
      <div className="report-task-steps">
        {taskSteps.map((step, index) => {
          const state =
            completedAll || (activeIndex >= 0 && index < activeIndex)
              ? 'done'
              : activeIndex === index
                ? 'active'
                : 'waiting'
          return (
            <div key={step.id} className={`report-task-step ${state}`}>
              <span className="report-task-dot" aria-hidden />
              <div>
                <b>{step.label}</b>
                <small>
                  {state === 'done' ? '已完成' : state === 'active' ? '进行中' : '等待中'}
                </small>
              </div>
            </div>
          )
        })}
      </div>
      {phase === 'transcribingVoice' && voiceTranscriptionProgress && (
        <div className="report-voice-progress">
          <div>
            <span>语音转写</span>
            <strong>
              {voiceTranscriptionProgress.processed}/{voiceTranscriptionProgress.total}
            </strong>
          </div>
          <progress
            value={voiceTranscriptionProgress.processed}
            max={Math.max(1, voiceTranscriptionProgress.total)}
            aria-label="语音转写进度"
          />
          <small>
            成功 {voiceTranscriptionProgress.succeeded} 条，失败 {voiceTranscriptionProgress.failed}{' '}
            条
          </small>
        </div>
      )}
      {phase === 'error' && (
        <div className="report-task-error">
          <b>错误摘要</b>
          <p>{error}</p>
          <button type="button" onClick={onRetry}>
            重试
          </button>
          <button type="button" onClick={() => void window.api.revealAppLog()}>
            打开诊断日志
          </button>
          {logPath && <small className="report-task-log-path">{logPath}</small>}
        </div>
      )}
      {phase === 'success' && (
        <div className="report-task-success">
          <b>生成成功</b>
          <p>HTML 与 PNG 已导出，可以查看生成结果。</p>
        </div>
      )}
      <div className="report-task-note">
        模型调用耗时取决于你配置的服务，当前只展示真实执行阶段。
      </div>
    </aside>
  )
}
