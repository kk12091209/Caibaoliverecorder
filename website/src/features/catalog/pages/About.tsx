import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useWorks } from '../lib/catalog'

export function AboutPage() {
  const works = useWorks()
  useEffect(() => {
    document.title = '关于 · 菜包宇宙'
  }, [])

  return (
    <section className="shell letter">
      <div>
        {works.map((work) => (
          <Link key={work.slug} to={`/works/${work.slug}`}>
            {work.name}
          </Link>
        ))}
      </div>
    </section>
  )
}
