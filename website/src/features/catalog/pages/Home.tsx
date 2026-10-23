import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Link } from 'react-router-dom'
import { ProductCarousel } from '../components/ProductCarousel'
import { ArrowRightIcon, ArrowTopRightIcon } from '@radix-ui/react-icons'
import { useWorks } from '../lib/catalog'
import { makeShowcase } from '../data/showcase'
import './home.css'

const WaveField = lazy(() => import('../components/WaveField'))

class WaveBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

export function HomePage() {
  const works = useWorks()
  const entries = useMemo(
    () => makeShowcase(works).filter((entry) => entry.kind === 'software' && entry.image),
    [works],
  )
  const surface = useRef<HTMLElement>(null)
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )

  useEffect(() => {
    document.title = '菜包宇宙'
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(preference.matches)
    preference.addEventListener('change', update)
    return () => preference.removeEventListener('change', update)
  }, [])

  return (
    <div className="wave-home">
      <section className="wave-hero" ref={surface} aria-labelledby="home-title">
        <WaveBoundary>
          <Suspense fallback={null}>
            <WaveField surface={surface} paused={reducedMotion} />
          </Suspense>
        </WaveBoundary>
        <div className="wave-hero-wash" aria-hidden="true" />
        <div className={`home-shell hero-layout${entries.length ? '' : ' hero-layout-solo'}`}>
          <div className="home-intro">
            <p className="home-eyebrow">CAIBAO UNIVERSE</p>
            <h1 id="home-title">
              做点有用的，
              <br />
              <em>也做点有趣的。</em>
            </h1>
            <p className="home-description">软件、实验，和一些新的尝试。</p>
            <div className="home-actions">
              <Link className="btn btn-primary" to="/works">
                浏览产品 <ArrowRightIcon aria-hidden="true" />
              </Link>
              <Link className="home-text-link" to="/about">
                关于菜包 <ArrowTopRightIcon aria-hidden="true" />
              </Link>
            </div>
          </div>
          <ProductCarousel entries={entries} />
        </div>
      </section>
    </div>
  )
}
