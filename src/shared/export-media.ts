import type { ExportRequest } from './export'

export type ImageExportAttempt = {
  allowThumbnail: boolean
  preferThumbnail: boolean
}

export function getImageExportAttempts(
  request: Pick<ExportRequest, 'preferOriginal' | 'fallbackThumbnail'>
): ImageExportAttempt[] {
  if (request.preferOriginal === false) {
    return [{ allowThumbnail: true, preferThumbnail: true }]
  }
  const attempts: ImageExportAttempt[] = [{ allowThumbnail: false, preferThumbnail: false }]
  if (request.fallbackThumbnail !== false) {
    attempts.push({ allowThumbnail: true, preferThumbnail: true })
  }
  return attempts
}
