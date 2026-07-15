import React, { useState } from 'react'

export type ReportTemplateId = 'v1' | 'v2'

interface TemplateMeta {
  id: ReportTemplateId
  label: string
  tagline: string
  preview: { title: string; sections: string[] }
}

const TEMPLATES: TemplateMeta[] = [
  {
    id: 'v1',
    label: '模板1 · 经典日报',
    tagline: '实用信息 / 重要消息 / 金句 / 问答 / 数据可视化',
    preview: {
      title: '经典日报',
      sections: [
        '今日讨论热点',
        'AI 识别的图片精选',
        '实用信息与资源',
        '重要消息汇总',
        '有趣对话或金句',
        '问题与解答',
        '群内数据可视化',
        '词云/关键词'
      ]
    }
  },
  {
    id: 'v2',
    label: '模板2 · 支持图片板块',
    tagline: '包含热点图片与上下文；需要模型服务商支持图片识别',
    preview: {
      title: '支持图片板块',
      sections: [
        '今日讨论热点',
        '重要消息',
        '待办事项和未解决问题',
        '今日名场面',
        '今日群数据',
        '关键词',
        '实用信息与资源',
        '问题与解答',
        '今日剧情时间线',
        '群聊反转现场',
        'AI 识别的图片精选',
        '今日群相册',
        '语音之最',
        '语音时长榜',
        '今日临时人设',
        '话题参与链路'
      ]
    }
  }
]

interface ReportTemplateSelectorProps {
  value: ReportTemplateId
  onChange: (value: ReportTemplateId) => void
  disabled?: boolean
}

export const ReportTemplateSelector: React.FC<ReportTemplateSelectorProps> = ({
  value,
  onChange,
  disabled
}) => {
  const [previewing, setPreviewing] = useState<TemplateMeta | null>(null)
  return (
    <section className="report-section">
      <h3>日报模板</h3>
      <p className="report-section-desc">
        选择日报呈现风格。模板2 支持图片板块，但需要 AI 模型服务商支持图片识别。
      </p>
      <div className="report-template-list">
        {TEMPLATES.map((tpl) => {
          const active = value === tpl.id
          return (
            <div
              key={tpl.id}
              className={`report-template-item ${active ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
            >
              <label>
                <input
                  type="radio"
                  name="report-template"
                  value={tpl.id}
                  checked={active}
                  disabled={disabled}
                  onChange={() => onChange(tpl.id)}
                />
                <div className="report-template-body">
                  <div className="report-template-title">{tpl.label}</div>
                  <div className="report-template-tagline">{tpl.tagline}</div>
                </div>
              </label>
              <button
                type="button"
                className="report-template-preview-btn"
                onClick={() => setPreviewing(tpl)}
              >
                预览
              </button>
            </div>
          )
        })}
      </div>
      {previewing && (
        <div className="report-template-preview-mask" onClick={() => setPreviewing(null)}>
          <div className="report-template-preview-card" onClick={(e) => e.stopPropagation()}>
            <h4>{previewing.preview.title}</h4>
            <p className="muted">{previewing.tagline}</p>
            <div className="report-template-preview-frame">
              <div className="fake-card fake-hero">
                <div className="fake-title">群聊日报 · 预览</div>
                <div className="fake-sub">2026-xx-xx · 基于已加载记录</div>
              </div>
              {previewing.preview.sections.map((s) => (
                <div className="fake-card fake-section" key={s}>
                  <div className="fake-bar" />
                  <div className="fake-section-title">{s}</div>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="report-template-preview-close"
              onClick={() => setPreviewing(null)}
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
