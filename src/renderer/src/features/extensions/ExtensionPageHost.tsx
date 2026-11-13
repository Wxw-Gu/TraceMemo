import * as React from 'react'
import {
  EXTENSION_PAGE_HOST_SOURCE,
  isExtensionPageBridgeRequest
} from '../../../../shared/extensions/ipc'
import type {
  ExtensionPageDescriptor,
  ExtensionPageMethod
} from '../../../../shared/extensions/types'
import { Button } from '../../components/ui'

interface ExtensionPageHostProps {
  descriptor: ExtensionPageDescriptor
  onBack: () => void
}

/**
 * 扩展页面容器。
 *
 * 页面在 `sandbox="allow-scripts"` 的 iframe 里运行：没有 Node、没有 preload、
 * 没有 `window.api`，与官方渲染层不同源。它与宿主的唯一通道是 postMessage，
 * 由本组件转成受白名单约束的 `extensionPageRequest`。
 */
export function ExtensionPageHost({
  descriptor,
  onBack
}: ExtensionPageHostProps): React.ReactElement {
  const frameRef = React.useRef<HTMLIFrameElement | null>(null)
  const [loaded, setLoaded] = React.useState(false)
  const [slow, setSlow] = React.useState(false)
  const [reloadKey, setReloadKey] = React.useState(0)

  React.useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 8_000)
    return () => window.clearTimeout(timer)
  }, [reloadKey])

  React.useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      if (!isExtensionPageBridgeRequest(event.data)) return
      const request = event.data
      if (request.extensionId !== descriptor.extensionId) return
      void window.api
        .extensionPageRequest({
          extensionId: descriptor.extensionId,
          method: request.method as ExtensionPageMethod,
          params: request.params ?? {}
        })
        .then((response) => {
          frame.contentWindow?.postMessage(
            {
              source: EXTENSION_PAGE_HOST_SOURCE,
              requestId: request.requestId,
              ok: response.ok,
              ...(response.ok ? { result: response.result } : { error: response.error })
            },
            '*'
          )
        })
        .catch((error) => {
          frame.contentWindow?.postMessage(
            {
              source: EXTENSION_PAGE_HOST_SOURCE,
              requestId: request.requestId,
              ok: false,
              error: {
                code: 'ACTION_FAILED',
                message: error instanceof Error ? error.message : '调用失败'
              }
            },
            '*'
          )
        })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [descriptor.extensionId])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onBack()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onBack])

  return (
    <div className="extension-page-host">
      <header className="extension-page-host-header">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← 返回扩展中心
        </Button>
        <div className="extension-page-host-title">
          <strong>{descriptor.title}</strong>
          <span>{descriptor.extensionId}</span>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setReloadKey((value) => value + 1)}>
          重新加载
        </Button>
      </header>
      <div className="extension-page-host-body">
        {!loaded && (
          <div className="extension-page-host-loading">
            <p>{slow ? '页面尚未响应。扩展页面必须通过 tm.* 与宿主通信。' : '正在加载扩展页面…'}</p>
          </div>
        )}
        <iframe
          key={reloadKey}
          ref={frameRef}
          className="extension-page-frame"
          title={descriptor.title}
          src={descriptor.url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
        />
      </div>
    </div>
  )
}
