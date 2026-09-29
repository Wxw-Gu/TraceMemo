import * as React from 'react'
import type { AutomationRuleDraft } from '../../../../shared/automation'

/**
 * EffectPreview —— 微信式效果模拟预览。
 *
 * **纯前端模拟**：不调用真实微信发送、不调日报生成、不调 AI。
 * 它的全部作用是在用户按下保存之前，把「这条规则到底会做什么」演一遍。
 *
 * 与表单**逐项联动**（这是验收点）：
 * - 改关键词 → 左侧模拟消息里的内容跟着变；
 * - 改回复文案 → 右侧气泡跟着变；
 * - 关闭「回复确认」→ 右侧气泡消失；
 * - 关闭「必须真正 @我」→ 左侧不再显示 `@你`；
 * - 关闭「生成日报」→ 不再出图片，并说明原因；
 * - 关闭「发送图片」→ 日报仍会生成但不会进群，说明区分开。
 */

const SAMPLE_SENDER_NAME = '张三'

function isActionEnabled(draft: AutomationRuleDraft, type: string): boolean {
  return draft.actions.some((action) => action.type === type && action.enabled)
}

function replyText(draft: AutomationRuleDraft): string {
  const action = draft.actions.find((item) => item.type === 'replyText' && item.enabled)
  return action?.text?.trim() || '（未填写回复内容）'
}

/** 左侧模拟消息的正文：`@你 今日<关键词>`。关键词为空时给一句通用占位，而不是伪造关键词。 */
function sampleIncomingText(draft: AutomationRuleDraft): string {
  const keyword = draft.conditions.keyword.trim()
  const body = keyword ? `今日${keyword}` : '今天群里有什么新消息'
  return draft.conditions.requireMentionMe ? `@你 ${body}` : body
}

export function EffectPreview({ draft }: { draft: AutomationRuleDraft }): React.ReactElement {
  const mentionMe = draft.conditions.requireMentionMe
  const hasReply = isActionEnabled(draft, 'replyText')
  const hasReport = isActionEnabled(draft, 'generateReport')
  const hasSend = isActionEnabled(draft, 'sendReportImage')
  const showReportImage = hasReport && hasSend

  return (
    <section className="automation-preview" aria-label="效果模拟预览">
      <div className="automation-preview-heading">
        <h3>效果预览</h3>
        <span className="automation-preview-badge">仅预览，不会真实发送</span>
      </div>

      <div className="automation-preview-phone">
        <div className="automation-preview-chat">
          {/* 左侧：触发消息 */}
          <div className="automation-chat-row incoming">
            <span className="automation-chat-avatar" aria-hidden="true">
              {SAMPLE_SENDER_NAME.slice(0, 1)}
            </span>
            <div className="automation-chat-body">
              <span className="automation-chat-name">{SAMPLE_SENDER_NAME}</span>
              <span className="automation-chat-bubble">{sampleIncomingText(draft)}</span>
            </div>
          </div>

          {mentionMe ? (
            <p className="automation-preview-hint">
              只有当对方<strong>真正</strong> @ 你时才会触发；正文里手打的「@昵称」不算。
            </p>
          ) : (
            <p className="automation-preview-hint">
              当前不要求 @你，该会话内任何含关键词的消息都会触发。
            </p>
          )}

          {/* 右侧：自动回复 */}
          {hasReply ? (
            <div className="automation-chat-row outgoing">
              <div className="automation-chat-body">
                <span className="automation-chat-name">我</span>
                <span className="automation-chat-bubble">{replyText(draft)}</span>
              </div>
              <span className="automation-chat-avatar self" aria-hidden="true">
                我
              </span>
            </div>
          ) : (
            <p className="automation-preview-hint muted">未启用「回复确认」，命中后不会先回一句。</p>
          )}

          {/* 右侧：日报图片 */}
          {showReportImage ? (
            <div className="automation-chat-row outgoing">
              <div className="automation-chat-body">
                <span className="automation-chat-name">我</span>
                <figure className="automation-chat-image">
                  <div className="automation-chat-image-canvas" aria-hidden="true">
                    <span className="automation-chat-image-title">群聊日报</span>
                    <span className="automation-chat-image-line" />
                    <span className="automation-chat-image-line short" />
                    <span className="automation-chat-image-line" />
                    <span className="automation-chat-image-line short" />
                  </div>
                  <figcaption>日报图片预览</figcaption>
                </figure>
              </div>
              <span className="automation-chat-avatar self" aria-hidden="true">
                我
              </span>
            </div>
          ) : (
            <p className="automation-preview-hint muted">
              {!hasReport
                ? '未启用「生成日报」，命中后不会产出日报。'
                : '日报仍会生成，但未启用发送，不会发到群里。'}
            </p>
          )}
        </div>
      </div>

      <dl className="automation-preview-facts">
        <div>
          <dt>生效范围</dt>
          <dd>
            {draft.conditions.conversationIds.length
              ? `已选 ${draft.conditions.conversationIds.length} 个群`
              : '所有群聊'}
          </dd>
        </div>
        <div>
          <dt>触发间隔</dt>
          <dd>{draft.cooldownSeconds > 0 ? `${draft.cooldownSeconds} 秒` : '不限制'}</dd>
        </div>
        <div>
          <dt>自己发的消息</dt>
          <dd>{draft.conditions.ignoreSelf ? '不触发' : '也会触发'}</dd>
        </div>
      </dl>
    </section>
  )
}
