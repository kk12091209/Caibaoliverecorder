import { useEffect, useRef, useState } from 'react'
import type { WorkImage } from '../data/works'
import './product-image.css'

export const DETAIL_IMAGE_SIZES =
  '(max-width: 640px) calc(100vw - 50px), (max-width: 1100px) calc(100vw - 80px), (max-width: 1232px) calc(100vw - 128px), 1104px'
export const HERO_IMAGE_SIZES =
  '(max-width: 760px) calc(100vw - 48px), (max-width: 1100px) calc(53.5vw - 65px), (max-width: 1552px) calc(53.5vw - 110px), 721px'

/** Keep the allocated space, but reveal only a complete, decoded image. */
export function ProductImage({
  image,
  sizes,
  priority = false,
  eager = priority,
}: {
  image: WorkImage
  sizes: string
  priority?: boolean
  eager?: boolean
}) {
  const ref = useRef<HTMLImageElement>(null)
  const [readySource, setReadySource] = useState('')
  const [failedSource, setFailedSource] = useState('')
  const ready = readySource === image.src
  const failed = failedSource === image.src
  useEffect(() => {
    const element = ref.current!
    let disposed = false
    const fail = () => {
      if (!disposed) setFailedSource(image.src)
    }
    const reveal = async () => {
      const source = element.currentSrc
      try {
        await element.decode()
      } catch {
        if (!element.complete || !element.naturalWidth) {
          fail()
          return
        }
      }
      if (!disposed && element.currentSrc === source && element.naturalWidth) {
        setReadySource(image.src)
        setFailedSource('')
      }
    }
    element.addEventListener('load', reveal)
    element.addEventListener('error', fail)
    if (element.complete) {
      if (element.naturalWidth) void reveal()
      else fail()
    }
    return () => {
      disposed = true
      element.removeEventListener('load', reveal)
      element.removeEventListener('error', fail)
    }
  }, [image.src, image.srcSet, image.avifSrcSet])

  return (
    <picture
      className={`product-image${ready ? ' is-ready' : ''}`}
      style={{ aspectRatio: `${image.width} / ${image.height}` }}
    >
      {image.avifSrcSet && <source type="image/avif" srcSet={image.avifSrcSet} sizes={sizes} />}
      <img
        ref={ref}
        src={image.src}
        srcSet={image.srcSet}
        sizes={sizes}
        alt={image.alt}
        width={image.width}
        height={image.height}
        loading={eager ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'auto'}
        decoding="async"
      />
      {failed && !ready && (
        <span className="product-image-error" role="status">
          操作图暂时无法加载，请刷新重试。
        </span>
      )}
    </picture>
  )
}
