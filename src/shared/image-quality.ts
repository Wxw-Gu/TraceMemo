export type ExportImageQuality = 'original' | 'medium' | 'thumbnail'

const fileNameOf = (filePath: string): string =>
  String(filePath || '')
    .trim()
    .toLowerCase()
    .split(/[\\/]/)
    .pop() || ''

export const imageFileQuality = (filePath: string): ExportImageQuality => {
  const fileName = fileNameOf(filePath)
  if (!fileName.endsWith('.dat')) return 'original'
  if (/(?:_t(?:_m)?|_thumb|\.thumb|_b|_w|_c)\.dat$/i.test(fileName)) {
    return 'thumbnail'
  }
  if (/(?:_hd|\.hd|_h_m|_h|\.h)\.dat$/i.test(fileName)) return 'original'
  return 'medium'
}

export const imageQualityRank = (quality: ExportImageQuality): number => {
  if (quality === 'original') return 3
  if (quality === 'medium') return 2
  return 1
}
