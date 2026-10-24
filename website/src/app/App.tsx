import { lazy, Suspense, useEffect } from 'react'
import { useLocation } from 'react-router-dom'

const CatalogApp = lazy(() => import('./CatalogApp'))
const TeleprompterPage = lazy(() =>
  import('../features/teleprompter/Teleprompter').then((module) => ({
    default: module.TeleprompterPage,
  })),
)
const MediaDownloaderPage = lazy(() =>
  import('../features/downloader/MediaDownloader').then((module) => ({
    default: module.MediaDownloaderPage,
  })),
)
export function App() {
  const location = useLocation()
  const isTool = /^\/tools\/(teleprompter|downloader)\/?$/.test(location.pathname)

  useEffect(() => {
    if (isTool) window.scrollTo(0, 0)
  }, [isTool, location.pathname, location.key])

  if (/^\/tools\/teleprompter\/?$/.test(location.pathname))
    return (
      <Suspense
        fallback={
          <p role="status" style={{ padding: 32 }}>
            正在打开菜包口播助手…
          </p>
        }
      >
        <TeleprompterPage />
      </Suspense>
    )
  if (/^\/tools\/downloader\/?$/.test(location.pathname))
    return (
      <Suspense
        fallback={
          <p role="status" style={{ padding: 32 }}>
            正在打开菜包下载助手…
          </p>
        }
      >
        <MediaDownloaderPage />
      </Suspense>
    )

  return (
    <Suspense
      fallback={
        <p role="status" style={{ padding: 32 }}>
          正在打开菜包宇宙…
        </p>
      }
    >
      <CatalogApp />
    </Suspense>
  )
}
