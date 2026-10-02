import type { ExportFormat, ExportMessageKind, ExportNameMode } from '../../../../shared/export'
import type { ExportRange } from './exportTypes'

export interface ExportPreferences {
  format: ExportFormat
  range: ExportRange
  startDate: string
  endDate: string
  selectedKinds: ExportMessageKind[]
  nameMode: ExportNameMode
  includeMedia: boolean
  includeVoiceTranscripts: boolean
  includeAvatars: boolean
  preferOriginal: boolean
  fallbackThumbnail: boolean
  keepMissing: boolean
  zip: boolean
  fileName: string
  outputDirectory: string
}

export const EXPORT_PREFERENCES_STORAGE_KEY = 'tracememo_export_preferences'

const formats: ExportFormat[] = ['html', 'csv', 'json', 'markdown']
const ranges: ExportRange[] = ['all', 'today', 'threeDays', 'sevenDays', 'custom']
const messageKinds: ExportMessageKind[] = [
  'text',
  'image',
  'video',
  'voice',
  'sticker',
  'file',
  'share',
  'location',
  'system'
]
const nameModes: ExportNameMode[] = ['groupNickname', 'remark', 'wechatNickname']

export function loadExportPreferences(defaultNameMode: ExportNameMode): ExportPreferences {
  const defaults: ExportPreferences = {
    format: 'csv',
    range: 'today',
    startDate: '',
    endDate: '',
    selectedKinds: ['text'],
    nameMode: defaultNameMode,
    includeMedia: true,
    includeVoiceTranscripts: true,
    includeAvatars: true,
    preferOriginal: true,
    fallbackThumbnail: true,
    keepMissing: true,
    zip: false,
    fileName: '',
    outputDirectory: ''
  }

  try {
    const stored = window.localStorage.getItem(EXPORT_PREFERENCES_STORAGE_KEY)
    if (!stored) return defaults
    const value = JSON.parse(stored) as Partial<ExportPreferences>
    return {
      format: formats.includes(value.format as ExportFormat)
        ? (value.format as ExportFormat)
        : defaults.format,
      range: ranges.includes(value.range as ExportRange)
        ? (value.range as ExportRange)
        : defaults.range,
      startDate: typeof value.startDate === 'string' ? value.startDate : defaults.startDate,
      endDate: typeof value.endDate === 'string' ? value.endDate : defaults.endDate,
      selectedKinds: Array.isArray(value.selectedKinds)
        ? [
            ...new Set(
              value.selectedKinds.filter((kind): kind is ExportMessageKind =>
                messageKinds.includes(kind as ExportMessageKind)
              )
            )
          ]
        : defaults.selectedKinds,
      nameMode: nameModes.includes(value.nameMode as ExportNameMode)
        ? (value.nameMode as ExportNameMode)
        : defaults.nameMode,
      includeMedia:
        typeof value.includeMedia === 'boolean' ? value.includeMedia : defaults.includeMedia,
      includeVoiceTranscripts:
        typeof value.includeVoiceTranscripts === 'boolean'
          ? value.includeVoiceTranscripts
          : defaults.includeVoiceTranscripts,
      includeAvatars:
        typeof value.includeAvatars === 'boolean' ? value.includeAvatars : defaults.includeAvatars,
      preferOriginal:
        typeof value.preferOriginal === 'boolean' ? value.preferOriginal : defaults.preferOriginal,
      fallbackThumbnail:
        typeof value.fallbackThumbnail === 'boolean'
          ? value.fallbackThumbnail
          : defaults.fallbackThumbnail,
      keepMissing:
        typeof value.keepMissing === 'boolean' ? value.keepMissing : defaults.keepMissing,
      zip: typeof value.zip === 'boolean' ? value.zip : defaults.zip,
      fileName: typeof value.fileName === 'string' ? value.fileName : defaults.fileName,
      outputDirectory:
        typeof value.outputDirectory === 'string' ? value.outputDirectory : defaults.outputDirectory
    }
  } catch {
    return defaults
  }
}

export function saveExportPreferences(preferences: ExportPreferences): void {
  try {
    window.localStorage.setItem(EXPORT_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Export remains usable when browser storage is unavailable.
  }
}
