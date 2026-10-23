import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useWorks } from '../lib/catalog'

export function WorksPage() {
  const works = useWorks()
  useEffect(() => {
    document.title = '产品 · 菜包宇宙'
  }, [])

  return (
    <section className="shell page-intro">
      <h1 className="quiet-title">产品</h1>
      <div className="work-list">
        {works.map((work) => (
          <Link key={work.slug} to={`/works/${work.slug}`} className="name-row">
            <strong>{work.name}</strong>
            <small>{work.version}</small>
          </Link>
        ))}
      </div>
    </section>
  )
}
