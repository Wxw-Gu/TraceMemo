import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/index.scss'

window.addEventListener('error', (event) => {
  void window.api
    .writeAppLog({
      level: 'error',
      scope: 'renderer',
      message: event.message || 'Renderer 未捕获错误',
      details: {
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
        stack: event.error instanceof Error ? event.error.stack : undefined
      }
    })
    .catch(() => undefined)
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  void window.api
    .writeAppLog({
      level: 'error',
      scope: 'renderer',
      message: reason instanceof Error ? reason.message : 'Renderer Promise 未处理拒绝',
      details: {
        stack: reason instanceof Error ? reason.stack : undefined,
        reason: reason instanceof Error ? undefined : String(reason)
      }
    })
    .catch(() => undefined)
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
