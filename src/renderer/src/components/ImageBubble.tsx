import { useState, useCallback, useEffect, useRef } from 'react'
import type { JSX, MouseEvent } from 'react'
import { getCachedLoadedImage, requestImage } from './image-loader'

interface ImageBubbleProps {
  imageMd5?: string
  imageDatName?: string
  sessionId?: string
  isThumb?: boolean
  fallbackUrl?: string
  onImageClick?: (imageUrl: string) => void
}

export function ImageBubble({
  imageMd5,
  imageDatName,
  sessionId,
  fallbackUrl,
  onImageClick
}: ImageBubbleProps): JSX.Element {
  const initialCachedImage = getCachedLoadedImage(imageMd5, imageDatName, {
    preferThumbnail: true
  })
  const [imageUrl, setImageUrl] = useState<string | null>(initialCachedImage?.data || null)
  const [loading, setLoading] = useState(false)
  const [upgrading, setUpgrading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isThumbnail, setIsThumbnail] = useState(Boolean(initialCachedImage?.isThumbnail))
  const [usingFallback, setUsingFallback] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)
  const backgroundUpgradeRef = useRef(false)

  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  const upgradeOriginalInBackground = useCallback(() => {
    if (!isThumbnail || backgroundUpgradeRef.current || (!imageMd5 && !imageDatName)) return
    backgroundUpgradeRef.current = true
    void requestImage(imageMd5, imageDatName, sessionId, { force: true }, 1)
      .then((original) => {
        if (!mountedRef.current) return
        setImageUrl(original.data)
        setIsThumbnail(false)
      })
      .catch(() => undefined)
  }, [imageDatName, imageMd5, isThumbnail, sessionId])

  const loadImage = useCallback(async () => {
    if (imageUrl || loading) return
    if (!imageMd5 && !imageDatName) {
      if (fallbackUrl) {
        setImageUrl(fallbackUrl)
        setUsingFallback(true)
        setError(null)
        return
      }
      setError('缺少图片标识')
      return
    }

    setLoading(true)
    try {
      const result = await requestImage(
        imageMd5,
        imageDatName,
        sessionId,
        { preferThumbnail: true },
        0
      )
      setImageUrl(result.data)
      setUsingFallback(false)
      setIsThumbnail(result.isThumbnail)
      setError(null)
      if (result.isThumbnail) upgradeOriginalInBackground()
    } catch (error) {
      if (fallbackUrl) {
        setImageUrl(fallbackUrl)
        setUsingFallback(true)
        setError(null)
      } else {
        setError(error instanceof Error ? error.message : '加载图片失败')
      }
    } finally {
      setLoading(false)
    }
  }, [
    fallbackUrl,
    imageDatName,
    imageMd5,
    imageUrl,
    loading,
    sessionId,
    upgradeOriginalInBackground
  ])

  useEffect(() => {
    if (initialCachedImage?.isThumbnail) upgradeOriginalInBackground()
  }, [initialCachedImage?.isThumbnail, upgradeOriginalInBackground])

  useEffect(() => {
    if (imageUrl || loading || error) return
    const element = containerRef.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      const timer = window.setTimeout(() => void loadImage(), 0)
      return () => window.clearTimeout(timer)
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        void loadImage()
      },
      { rootMargin: '400px 0px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [error, imageUrl, loadImage, loading])

  const handleCopy = async (event: MouseEvent): Promise<void> => {
    event.stopPropagation()
    if (!imageUrl) return
    await window.api.copyImage(imageUrl)
    alert('图片已复制')
  }

  const handleClick = async (): Promise<void> => {
    if (!imageUrl && !error) return
    if (!imageMd5 && !imageDatName) {
      if (imageUrl) onImageClick?.(imageUrl)
      return
    }

    if (upgrading) {
      if (imageUrl) onImageClick?.(imageUrl)
      return
    }

    setUpgrading(true)
    try {
      const result = await requestImage(imageMd5, imageDatName, sessionId, { force: true }, 0)
      if (result.data.startsWith('data:image/')) {
        setImageUrl(result.data)
        setUsingFallback(false)
        setIsThumbnail(result.isThumbnail)
        setError(null)
        onImageClick?.(result.data)
        return
      }
    } catch {
      // Fall back to the already visible image.
    } finally {
      setUpgrading(false)
    }

    if (imageUrl) onImageClick?.(imageUrl)
  }

  if (loading) {
    return (
      <div className="image-bubble image-loading" onClick={handleClick}>
        <div className="image-loading-skeleton" aria-hidden />
        <div className="image-quality-badge">加载中</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="image-bubble image-error" onClick={loadImage}>
        <div className="image-error-text">{error || '图片未缓存'}</div>
        <div className="image-quality-badge">加载失败</div>
      </div>
    )
  }

  if (!imageUrl) {
    return (
      <div ref={containerRef} className="image-bubble image-placeholder">
        <div className="image-loading-skeleton" aria-hidden />
        <div className="image-quality-badge">加载中</div>
      </div>
    )
  }

  return (
    <div className="image-bubble image-loaded" onClick={handleClick}>
      <img
        src={imageUrl}
        alt="图片"
        className={`image-content ${usingFallback ? 'image-fallback' : ''}`}
      />
      {(upgrading || isThumbnail) && (
        <div className="image-quality-badge">{upgrading ? '正在查找原图' : '缩略图'}</div>
      )}
      <div className="image-actions">
        <button className="image-action-btn" onClick={handleCopy} title="复制图片">
          复制
        </button>
      </div>
    </div>
  )
}
