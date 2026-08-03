import type { ExportRequest } from './export'

export type ImageExportAttempt = {
  allowThumbnail: boolean
  preferThumbnail: boolean
  fallback: boolean
}

export function getImageExportAttempts(
  request: Pick<ExportRequest, 'preferOriginal' | 'fallbackThumbnail'>
): ImageExportAttempt[] {
  if (request.preferOriginal === false) {
    return [{ allowThumbnail: true, preferThumbnail: true, fallback: false }]
  }
  const attempts: ImageExportAttempt[] = [
    { allowThumbnail: false, preferThumbnail: false, fallback: false }
  ]
  if (request.fallbackThumbnail !== false) {
    attempts.push({ allowThumbnail: true, preferThumbnail: true, fallback: true })
  }
  return attempts
}
