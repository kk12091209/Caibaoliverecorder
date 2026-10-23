import { useState, type ImgHTMLAttributes } from 'react'

export function MediaImage({
  src,
  fallback,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { fallback: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <img
      {...props}
      src={failed ? fallback : src || fallback}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}
