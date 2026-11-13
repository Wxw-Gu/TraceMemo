import { promises as fs } from 'node:fs'
import path from 'node:path'
import { protocol } from 'electron'
import { isSafeRelativeEntryPath } from '../../shared/extensions/manifest'
import { isPathInside, type ExtensionPaths } from './extension-paths'

export const EXTENSION_SCHEME = 'tm-extension'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

/**
 * 扩展页面协议：只接受 `tm-extension://<extensionId>/<path>`，realpath 必须仍在
 * 扩展目录内；响应带严格 CSP（无外链、无内联脚本、无网络）。
 *
 * `registerSchemesAsPrivileged` 必须在 app ready 前调用。
 */
export function registerExtensionScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: EXTENSION_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: true
      }
    }
  ])
}

export function installExtensionProtocolHandler(paths: ExtensionPaths): void {
  protocol.handle(EXTENSION_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const extensionId = url.hostname.toLowerCase()
      if (!/^[a-z0-9.-]{3,128}$/.test(extensionId)) return notFound()
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      if (!isSafeRelativeEntryPath(relative)) return notFound()

      const root = paths.installDir(extensionId)
      const resolved = path.resolve(root, relative)
      if (!isPathInside(root, resolved)) return notFound()
      const realRoot = await fs.realpath(root).catch(() => null)
      const realFile = await fs.realpath(resolved).catch(() => null)
      if (!realRoot || !realFile) return notFound()
      if (!isPathInside(realRoot, realFile)) return notFound()

      const stat = await fs.stat(realFile)
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return notFound()
      const body = await fs.readFile(realFile)
      const contentType =
        MIME_TYPES[path.extname(realFile).toLowerCase()] || 'application/octet-stream'
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Security-Policy': [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "font-src 'self' data:",
            "connect-src 'none'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'"
          ].join('; '),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store'
        }
      })
    } catch {
      return notFound()
    }
  })
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  })
}
