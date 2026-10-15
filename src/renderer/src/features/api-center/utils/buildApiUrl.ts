export function buildApiUrl(
  host: string,
  port: number,
  path: string,
  params: Record<string, string>
): string {
  let resolvedPath = path
  const pathParameterKeys = new Set(
    Object.keys(params).filter((key) => path.includes(`{${key}}`))
  )
  Object.entries(params).forEach(([key, value]) => {
    const normalized = value.trim()
    if (normalized && resolvedPath.includes(`{${key}}`)) {
      resolvedPath = resolvedPath.replace(`{${key}}`, encodeURIComponent(normalized))
    }
  })
  const url = new URL(resolvedPath, `http://${host}:${port}`)
  Object.entries(params).forEach(([key, value]) => {
    if (pathParameterKeys.has(key)) return
    if (value.trim()) url.searchParams.set(key, value.trim())
  })
  return url.toString()
}

export function isLoopbackHost(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1'].includes(host.trim().toLowerCase())
}
