import { lazy, Suspense, useEffect } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { loadCatalog } from '../features/catalog/lib/catalog'
import { Frame } from '../features/catalog/components/Frame'
import { AboutPage } from '../features/catalog/pages/About'
import { HomePage } from '../features/catalog/pages/Home'
import { NotFoundPage } from '../shared/ui/NotFound'
import { WorkPage } from '../features/catalog/pages/Work'
import { WorksPage } from '../features/catalog/pages/Works'

const BrowserPluginsPage = lazy(() =>
  import('../features/plugins/BrowserPlugins').then((module) => ({
    default: module.BrowserPluginsPage,
  })),
)
const BrowserPluginPage = lazy(() =>
  import('../features/plugins/BrowserPlugins').then((module) => ({
    default: module.BrowserPluginPage,
  })),
)

// Start loading releases only when a catalog page is requested.
void loadCatalog()

export default function CatalogApp() {
  const location = useLocation()

  useEffect(() => {
    if (location.hash) {
      const target = document.querySelector(location.hash)
      if (target) {
        target.scrollIntoView()
        return
      }
    }
    window.scrollTo(0, 0)
  }, [location.pathname, location.hash, location.key])

  useEffect(() => {
    const nodes = document.querySelectorAll('[data-reveal]')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      nodes.forEach((node) => node.classList.add('is-in'))
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return
          entry.target.classList.add('is-in')
          observer.unobserve(entry.target)
        })
      },
      { threshold: 0.18 },
    )
    nodes.forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [location.pathname])

  return (
    <Frame>
      <div key={location.pathname} className="page">
        <Routes location={location}>
          <Route path="/" element={<HomePage />} />
          <Route path="/works" element={<WorksPage />} />
          <Route
            path="/works/browser-plugins"
            element={
              <Suspense
                fallback={
                  <p className="shell" role="status">
                    正在打开插件合集…
                  </p>
                }
              >
                <BrowserPluginsPage />
              </Suspense>
            }
          />
          <Route
            path="/works/browser-plugins/:pluginSlug"
            element={
              <Suspense
                fallback={
                  <p className="shell" role="status">
                    正在打开插件…
                  </p>
                }
              >
                <BrowserPluginPage />
              </Suspense>
            }
          />
          <Route path="/works/:slug" element={<WorkPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </div>
    </Frame>
  )
}
