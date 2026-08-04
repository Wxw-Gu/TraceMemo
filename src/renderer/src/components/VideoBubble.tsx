import { useEffect, useMemo, useState } from 'react'

interface VideoBubbleProps {
  md5?: string
  newMd5?: string
  rawMd5?: string
  createTime?: number
  duration?: number
  width?: number
  height?: number
}

export function VideoBubble({
  md5,
  newMd5,
  rawMd5,
  createTime,
  duration,
  width,
  height
}: VideoBubbleProps): React.ReactElement {
  const hashes = useMemo(
    () => [rawMd5, newMd5, md5].filter((value): value is string => Boolean(value)),
    [md5, newMd5, rawMd5]
  )
  const [media, setMedia] = useState<{ url?: string; poster?: string; error?: string }>({})

  useEffect(() => {
    let cancelled = false
    window.api
      .getVideo(hashes, { createTime, duration, width, height })
      .then((result) => {
        if (!cancelled) setMedia(result.success ? result : { error: result.error })
      })
      .catch((error) => {
        if (!cancelled) setMedia({ error: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      cancelled = true
    }
  }, [createTime, duration, hashes, height, width])

  if (!media.url) {
    return <div className="video-placeholder">{media.error || '视频加载中…'}</div>
  }

  return (
    <div className="video-message">
      <video
        className="video-content"
        src={media.url}
        poster={media.poster}
        controls
        preload="metadata"
      />
      {duration ? <span className="video-duration">{duration} 秒</span> : null}
    </div>
  )
}
