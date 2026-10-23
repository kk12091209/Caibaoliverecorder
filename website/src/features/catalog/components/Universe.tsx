import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as THREE from 'three'
import type { Work } from '../data/works'

function doughMaterial(color: number) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0 })
}

export function Universe({ works }: { works: Work[] }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const [activeName, setActiveName] = useState<string | null>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 40)
    camera.position.set(0, 0.8, 8.2)

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch {
      return
    }
    renderer.setClearColor(0x000000, 0)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)

    const root = new THREE.Group()
    scene.add(root)
    scene.add(new THREE.HemisphereLight(0xfff4f6, 0xf0cfc4, 1.2))
    const sun = new THREE.DirectionalLight(0xfff8f4, 1.05)
    sun.position.set(3, 4, 5)
    scene.add(sun)

    const dough = doughMaterial(0xf3d0c4)
    const pleatMat = doughMaterial(0xe8b7ae)
    const blushMat = doughMaterial(0xee8fa6)
    const ink = doughMaterial(0x4a2434)
    const moonDough = doughMaterial(0xf7c3cf)

    const bun = new THREE.Group()
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.96, 40, 28), dough)
    body.scale.set(1.12, 0.76, 1.12)
    bun.add(body)
    const pleats: THREE.Mesh[] = []
    for (let index = 0; index < 6; index += 1) {
      const pleat = new THREE.Mesh(
        new THREE.TorusGeometry(0.2, 0.028, 8, 10, Math.PI * 0.72),
        pleatMat,
      )
      const turn = (index / 6) * Math.PI * 2
      pleat.position.set(Math.cos(turn) * 0.08, 0.58, Math.sin(turn) * 0.08)
      pleat.rotation.y = -turn + 0.4
      pleat.rotation.x = 0.9
      bun.add(pleat)
      pleats.push(pleat)
    }
    const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 16), ink)
    const rightEye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 16), ink)
    leftEye.position.set(-0.32, 0.12, 1.02)
    rightEye.position.set(0.34, 0.12, 1.02)
    const blush = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 12), blushMat)
    blush.scale.set(1.5, 0.65, 0.35)
    blush.position.set(-0.55, 0.02, 0.98)
    const blushRight = blush.clone()
    blushRight.position.set(0.58, 0.02, 0.98)
    bun.add(leftEye, rightEye, blush, blushRight)
    root.add(bun)

    const orbitRadius = 2.55
    const orbit = new THREE.Group()
    root.add(orbit)
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(orbitRadius - 0.012, orbitRadius + 0.012, 96),
      new THREE.MeshBasicMaterial({
        color: 0xc45d78,
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide,
      }),
    )
    ring.rotation.x = Math.PI / 2
    orbit.add(ring)

    const stars: THREE.Mesh[] = []
    works.forEach((work, index) => {
      const star = new THREE.Mesh(new THREE.SphereGeometry(0.36, 28, 20), moonDough)
      star.scale.set(1.08, 0.82, 1.08)
      const angle = 0.9 + (index / Math.max(works.length, 1)) * Math.PI * 2
      star.userData = { slug: work.slug, name: work.name, angle }
      const spot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 10), blushMat)
      spot.scale.set(1.3, 0.6, 0.3)
      spot.position.set(0.12, 0.05, 0.32)
      star.add(spot)
      orbit.add(star)
      stars.push(star)
    })

    const pointer = new THREE.Vector2(0, 0)
    const raycaster = new THREE.Raycaster()
    const projected = new THREE.Vector3()
    let frame = 0
    let width = 1
    let height = 1
    let dragging = false
    let pending = false
    let moved = false
    let lastX = 0
    let lastY = 0
    let flick = 0
    const spin = { x: 0.62, y: 0.2 }
    let hovered: THREE.Mesh | null = null
    let alive = true
    let pointerSeen = false

    const resize = () => {
      width = mount.clientWidth
      height = mount.clientHeight
      if (width < 1 || height < 1) return
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(mount)

    const pick = () => {
      root.updateMatrixWorld(true)
      camera.updateMatrixWorld(true)
      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObjects(stars, false)
      return (hits[0]?.object as THREE.Mesh | undefined) ?? null
    }

    const onPointerDown = (event: PointerEvent) => {
      if (!mount.contains(event.target as Node)) return
      try {
        mount.setPointerCapture(event.pointerId)
      } catch {
        /* 没有活动指针时忽略，例如测试事件 */
      }
      pending = true
      moved = false
      lastX = event.clientX
      lastY = event.clientY
    }
    const onPointerMove = (event: PointerEvent) => {
      const rect = mount.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      pointerSeen = true
      if (!pending && !dragging) return
      const dx = event.clientX - lastX
      const dy = event.clientY - lastY
      if (!dragging && Math.abs(dx) + Math.abs(dy) < 8) return
      if (event.cancelable) event.preventDefault()
      dragging = true
      moved = true
      mount.classList.add('is-dragging')
      flick = dx * 0.01
      spin.y += dx * 0.006
      spin.x = Math.max(0.42, Math.min(0.82, spin.x + dy * 0.003))
      lastX = event.clientX
      lastY = event.clientY
    }
    const onPointerUp = (event: PointerEvent) => {
      const didDrag = moved
      pending = false
      dragging = false
      moved = false
      mount.classList.remove('is-dragging')
      if (!mount.contains(event.target as Node) || didDrag) return
      const rect = mount.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      const hit = pick()
      const slug = hit?.userData.slug as string | undefined
      if (slug) navigate(`/works/${slug}`)
    }
    const onLeave = () => {
      dragging = false
      pending = false
      mount.classList.remove('is-dragging')
    }

    mount.addEventListener('pointerdown', onPointerDown)
    mount.addEventListener('pointermove', onPointerMove, { passive: false })
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onLeave)
    mount.addEventListener('pointerleave', onLeave)

    const clock = new THREE.Clock()
    let orbitTime = 0
    let previous = 0
    const animate = () => {
      if (!alive) return
      frame = window.requestAnimationFrame(animate)
      const time = clock.getElapsedTime()
      const delta = Math.min(time - previous, 0.05)
      previous = time
      if (!reduced && !dragging) {
        orbitTime += delta
        spin.y += flick
        flick *= 0.9
      }
      root.rotation.y += (spin.y - root.rotation.y) * 0.12
      root.rotation.x += (spin.x - root.rotation.x) * 0.08
      camera.position.x += (pointer.x * 0.22 - camera.position.x) * 0.05
      camera.position.y += (0.55 - camera.position.y) * 0.05
      camera.lookAt(0, 0, 0)

      const closeness = pointerSeen ? Math.max(0, 1 - Math.hypot(pointer.x, pointer.y) * 0.85) : 0
      const breathe = reduced ? 0 : Math.sin(time * 2.1) * 0.018
      const poke = closeness * 0.09
      bun.scale.set(1 + poke * 0.28, 1 - poke + breathe, 1 + poke * 0.28)
      const lookX = pointerSeen ? pointer.x * 0.09 : 0
      const lookY = pointerSeen ? pointer.y * 0.06 : 0
      leftEye.position.x += (-0.32 + lookX - leftEye.position.x) * 0.18
      leftEye.position.y += (0.12 + lookY - leftEye.position.y) * 0.18
      rightEye.position.x += (0.34 + lookX - rightEye.position.x) * 0.18
      rightEye.position.y += (0.12 + lookY - rightEye.position.y) * 0.18
      pleats.forEach((pleat, index) => {
        pleat.rotation.z = Math.sin(time * 1.4 + index) * 0.08
      })

      stars.forEach((star) => {
        const base = star.userData.angle as number
        const theta = base + orbitTime * 0.16
        star.position.set(Math.cos(theta) * orbitRadius, 0, Math.sin(theta) * orbitRadius)
      })

      const hit = dragging || !pointerSeen ? null : pick()
      if (hit !== hovered) {
        hovered = hit
        if (alive) setActiveName((hovered?.userData.name as string | undefined) ?? null)
        mount.style.cursor = hovered ? 'pointer' : dragging ? 'grabbing' : 'grab'
      }
      stars.forEach((star) => {
        const hot = star === hovered
        const nextX = hot ? 1.22 : 1.08
        const nextY = hot ? 0.62 : 0.82
        star.scale.x += (nextX - star.scale.x) * 0.22
        star.scale.y += (nextY - star.scale.y) * 0.22
        star.scale.z = star.scale.x
      })

      const label = labelRef.current
      if (label && hovered) {
        hovered.getWorldPosition(projected)
        projected.project(camera)
        const x = (projected.x * 0.5 + 0.5) * width
        const y = (-projected.y * 0.5 + 0.5) * height
        label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -150%) rotate(-7deg)`
        label.style.opacity = '1'
      } else if (label) {
        label.style.opacity = '0'
      }

      renderer.render(scene, camera)
    }
    animate()

    return () => {
      alive = false
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      mount.removeEventListener('pointerdown', onPointerDown)
      mount.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onLeave)
      mount.removeEventListener('pointerleave', onLeave)
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh
        mesh.geometry?.dispose()
        const material = mesh.material
        if (Array.isArray(material)) material.forEach((item) => item.dispose())
        else material?.dispose()
      })
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [navigate, works])

  return (
    <div className="universe" ref={mountRef} role="img" aria-label="菜包宇宙">
      <div ref={labelRef} className="universe-label" aria-hidden="true">
        {activeName ? <strong>{activeName}</strong> : null}
      </div>
    </div>
  )
}
