import { useEffect } from 'react'
import { Link } from 'react-router-dom'

export function NotFoundPage() {
  useEffect(() => {
    document.title = '没有这一页 · 菜包宇宙'
  }, [])

  return (
    <section className="shell letter">
      <h1 className="quiet-title">没有这一页</h1>
      <Link className="btn btn-primary" to="/">
        回到首页
      </Link>
    </section>
  )
}
