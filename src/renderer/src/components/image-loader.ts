export type LoadedImage = {
  data: string
  isThumbnail: boolean
}

export type ImageLoadOptions = {
  force?: boolean
  preferThumbnail?: boolean
}

type QueueItem = {
  priority: number
  run: () => Promise<LoadedImage>
  resolve: (value: LoadedImage) => void
  reject: (error: Error) => void
}

const MAX_CONCURRENT_IMAGE_LOADS = 3
const MAX_IMAGE_CACHE_BYTES = 48 * 1024 * 1024
const imageCache = new Map<string, LoadedImage>()
const imageCacheSizes = new Map<string, number>()
const imageRequests = new Map<string, Promise<LoadedImage>>()
const imageQueue: QueueItem[] = []
let activeImageLoads = 0
let imageCacheBytes = 0

function imageIdentityKeys(imageMd5?: string, imageDatName?: string): string[] {
  return [imageMd5 ? `md5:${imageMd5}` : '', imageDatName ? `dat:${imageDatName}` : ''].filter(
    Boolean
  )
}

function cacheMode(options: ImageLoadOptions): string {
  if (options.force) return 'original'
  if (options.preferThumbnail) return 'thumbnail'
  return 'auto'
}

function cacheKeys(
  imageMd5: string | undefined,
  imageDatName: string | undefined,
  options: ImageLoadOptions
): string[] {
  return imageIdentityKeys(imageMd5, imageDatName).map(
    (identity) => `${identity}:${cacheMode(options)}`
  )
}

function getCachedImage(
  imageMd5: string | undefined,
  imageDatName: string | undefined,
  options: ImageLoadOptions
): LoadedImage | undefined {
  const keys = cacheKeys(imageMd5, imageDatName, options)
  for (const key of keys) {
    const cached = imageCache.get(key)
    if (!cached) continue
    imageCache.delete(key)
    imageCache.set(key, cached)
    return cached
  }

  if (!options.force && options.preferThumbnail) {
    for (const identity of imageIdentityKeys(imageMd5, imageDatName)) {
      const fallbackKey = `${identity}:auto`
      const cached = imageCache.get(fallbackKey)
      if (cached) return cached
    }
  }

  return undefined
}

function cacheImage(
  imageMd5: string | undefined,
  imageDatName: string | undefined,
  options: ImageLoadOptions,
  image: LoadedImage
): void {
  const keys = cacheKeys(imageMd5, imageDatName, options)
  const size = image.data.length * 2
  for (const key of keys) {
    const previousSize = imageCacheSizes.get(key) || 0
    imageCacheBytes -= previousSize
    imageCache.delete(key)
    imageCacheSizes.delete(key)
    imageCache.set(key, image)
    imageCacheSizes.set(key, size)
    imageCacheBytes += size
  }

  while (imageCacheBytes > MAX_IMAGE_CACHE_BYTES && imageCache.size > 1) {
    const oldestKey = imageCache.keys().next().value
    if (!oldestKey) break
    imageCache.delete(oldestKey)
    imageCacheBytes -= imageCacheSizes.get(oldestKey) || 0
    imageCacheSizes.delete(oldestKey)
  }
}

function pumpImageQueue(): void {
  while (activeImageLoads < MAX_CONCURRENT_IMAGE_LOADS && imageQueue.length > 0) {
    imageQueue.sort((left, right) => left.priority - right.priority)
    const item = imageQueue.shift()
    if (!item) return
    activeImageLoads += 1
    void item
      .run()
      .then(item.resolve, item.reject)
      .finally(() => {
        activeImageLoads -= 1
        pumpImageQueue()
      })
  }
}

export function getCachedLoadedImage(
  imageMd5?: string,
  imageDatName?: string,
  options: ImageLoadOptions = {}
): LoadedImage | undefined {
  return getCachedImage(imageMd5, imageDatName, options)
}

export function requestImage(
  imageMd5: string | undefined,
  imageDatName: string | undefined,
  sessionId: string | undefined,
  options: ImageLoadOptions = {},
  priority = 0
): Promise<LoadedImage> {
  const cached = getCachedImage(imageMd5, imageDatName, options)
  if (cached) return Promise.resolve(cached)

  const identity = imageIdentityKeys(imageMd5, imageDatName)[0]
  if (!identity) return Promise.reject(new Error('缺少图片标识'))
  const requestKey = `${identity}:${cacheMode(options)}`
  const existingRequest = imageRequests.get(requestKey)
  if (existingRequest) return existingRequest

  const request = new Promise<LoadedImage>((resolve, reject) => {
    imageQueue.push({
      priority,
      resolve,
      reject,
      run: async () => {
        const result = await window.api.getImage(imageMd5, imageDatName, sessionId, options)
        if (!result.success || !result.data?.startsWith('data:image/')) {
          throw new Error(result.error || '加载图片失败')
        }
        const loadedImage = {
          data: result.data,
          isThumbnail: Boolean(result.isThumb)
        }
        cacheImage(imageMd5, imageDatName, options, loadedImage)
        return loadedImage
      }
    })
    pumpImageQueue()
  })
  imageRequests.set(requestKey, request)
  void request.then(
    () => imageRequests.delete(requestKey),
    () => imageRequests.delete(requestKey)
  )
  return request
}
