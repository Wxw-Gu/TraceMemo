/** 图片消息原始 XML 的查询契约。 */

/** 渲染进程 → 主进程的查询入参。 */
export interface ImageMessageXmlRequest {
  sessionId?: string
  localId?: number
  serverId?: string
  /** 消息创建时间（epoch 秒）。 */
  createTime?: number
}

export interface ImageMessageXmlResult {
  success: boolean
  xml?: string
  error?: string
}
