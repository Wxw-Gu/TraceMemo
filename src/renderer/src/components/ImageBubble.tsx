import { useState, useCallback, useEffect, useRef } from 'react'
import type { JSX, KeyboardEvent, MouseEvent } from 'react'
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
  const [usingFallback, setUsingFallback] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadImage = useCallback(
    async (priority = 0) => {
      if (imageUrl) return
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
      if (loading) {
        if (priority === 0) {
          void requestImage(
            imageMd5,
            imageDatName,
            sessionId,
            { preferThumbnail: true },
            priority
          ).catch(() => undefined)
        }
        return
      }

      setLoading(true)
      try {
        const result = await requestImage(
          imageMd5,
          imageDatName,
          sessionId,
          { preferThumbnail: true },
          priority
        )
        if (!mountedRef.current) return
        setImageUrl(result.data)
        setUsingFallback(false)
        setError(null)
      } catch (error) {
        if (!mountedRef.current) return
        if (fallbackUrl) {
          setImageUrl(fallbackUrl)
          setUsingFallback(true)
          setError(null)
        } else {
          setError(error instanceof Error ? error.message : '加载图片失败')
        }
      } finally {
        if (mountedRef.current) setLoading(false)
      }
    },
    [fallbackUrl, imageDatName, imageMd5, imageUrl, loading, sessionId]
  )

  useEffect(() => {
    if (imageUrl || error) return
    const element = containerRef.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      const timer = window.setTimeout(() => void loadImage(0), 0)
      return () => window.clearTimeout(timer)
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.find((candidate) => candidate.isIntersecting)
        if (!entry) return
        const rect = entry.boundingClientRect
        const isInViewport =
          rect.bottom >= 0 &&
          rect.top <= window.innerHeight &&
          rect.right >= 0 &&
          rect.left <= window.innerWidth
        observer.disconnect()
        void loadImage(isInViewport ? 0 : 1)
      },
      { rootMargin: loading ? '0px' : '400px 0px' }
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
      if (result.data.startsWith('data:image/') || result.data.startsWith('wxe-media://')) {
        setImageUrl(result.data)
        setUsingFallback(false)
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

  const handlePreviewKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    void handleClick()
  }

  if (loading) {
    return (
      <div ref={containerRef} className="image-bubble image-loading" onClick={handleClick}>
        <div className="image-loading-skeleton" aria-hidden />
        <div className="image-quality-badge">加载中</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="image-bubble image-error" onClick={() => void loadImage(0)}>
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
    <div
      className="image-bubble image-loaded"
      role="button"
      tabIndex={0}
      aria-label="查看图片"
      onClick={handleClick}
      onKeyDown={handlePreviewKeyDown}
    >
      <img
        src={imageUrl}
        alt="图片"
        className={`image-content ${usingFallback ? 'image-fallback' : ''}`}
      />
      {upgrading && <div className="image-quality-badge">正在查找原图</div>}
      <div className="image-actions">
        <button className="image-action-btn" onClick={handleCopy} title="复制图片">
          复制
        </button>
      </div>
    </div>
  )
}
