import { useEffect, useRef, type RefObject } from 'react'
import * as THREE from 'three'

type Props = {
  surface: RefObject<HTMLElement | null>
  paused: boolean
}
type Ripple = { x: number; z: number; born: number; strength: number }

// Inspired by Franky Hung's MIT-licensed 3D Wave Grid. See THIRD_PARTY_NOTICES.md.
// Instances share one geometry. No layout or React state updates occur per frame.
export default function WaveField({ surface, paused }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const controls = useRef({ paused, ripple: () => {} })
  controls.current.paused = paused

  useEffect(() => {
    const container = host.current
    const target = surface.current
    if (!container || !target) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'low-power',
      })
    } catch {
      return
    }
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 110)
    camera.position.set(0, 25, 21)
    camera.lookAt(0, 0, 0)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setClearColor(0xf7f1eb, 0)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(renderer.domElement)

    scene.add(new THREE.AmbientLight(0xfff7f0, 2.2))
    const light = new THREE.DirectionalLight(0xffffff, 3.1)
    light.position.set(-8, 16, 10)
    light.castShadow = true
    light.shadow.mapSize.set(1024, 1024)
    Object.assign(light.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, far: 60 })
    light.shadow.bias = -0.0005
    light.shadow.normalBias = 0.035
    scene.add(light)

    const geometry = new THREE.BoxGeometry(1.28, 1, 1.28)
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 })
    const size = 30
    const cubes = new THREE.InstancedMesh(geometry, material, size * size)
    cubes.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    cubes.castShadow = true
    cubes.receiveShadow = true
    cubes.frustumCulled = false
    scene.add(cubes)
    const baseColor = new THREE.Color('#e4ddd5')
    const accentColor = new THREE.Color('#d18b9d')
    const color = new THREE.Color()
    const transform = new THREE.Object3D()
    const positions = Array.from({ length: size * size }, (_, i) => ({
      x: ((i % size) - (size - 1) / 2) * 1.3,
      z: (Math.floor(i / size) - (size - 1) / 2) * 1.3,
    }))
    const ripples: Ripple[] = []
    let elapsed = 0
    let last = 0
    let frame = 0
    let visible = true
    let lost = false
    let disposed = false
    let lastPointer = -1
    let lastX = Infinity
    let lastZ = Infinity

    function addRipple(x: number, z: number, strength = 1) {
      if (controls.current.paused || lost) return
      ripples.push({ x, z, born: elapsed, strength })
      if (ripples.length > 12) ripples.shift()
      schedule()
    }
    controls.current.ripple = () => addRipple(1, 3, 1.6)
    function draw() {
      for (let i = 0; i < positions.length; i++) {
        const { x, z } = positions[i]
        let wave = 0
        for (const ripple of ripples) {
          const age = elapsed - ripple.born
          const distance = Math.hypot(x - ripple.x, z - ripple.z)
          const front = distance - age * 6
          wave +=
            Math.cos(front * 1.25) *
            Math.exp((-front * front) / 9) *
            Math.exp(-age * 0.72) *
            ripple.strength
        }
        const lift = THREE.MathUtils.clamp(wave, -0.3, 1.4)
        const height = 0.75 + lift
        transform.position.set(x, height / 2 - 0.75, z)
        transform.scale.set(1, height, 1)
        transform.updateMatrix()
        cubes.setMatrixAt(i, transform.matrix)
        cubes.setColorAt(i, color.copy(baseColor).lerp(accentColor, Math.max(0, lift) * 0.65))
      }
      cubes.instanceMatrix.needsUpdate = true
      if (cubes.instanceColor) cubes.instanceColor.needsUpdate = true
      renderer.render(scene, camera)
    }
    function schedule() {
      if (
        !disposed &&
        !frame &&
        visible &&
        !document.hidden &&
        !lost &&
        !controls.current.paused &&
        ripples.length
      )
        frame = requestAnimationFrame(tick)
    }
    function tick(now: number) {
      frame = 0
      if (disposed || !visible || document.hidden || controls.current.paused || lost) {
        last = 0
        return
      }
      elapsed += last ? Math.min((now - last) / 1000, 0.05) : 0
      last = now
      while (ripples.length && elapsed - ripples[0].born > 5) ripples.shift()
      draw()
      if (ripples.length) schedule()
      else last = 0
    }
    function resize() {
      const { width, height } = container!.getBoundingClientRect()
      if (!width || !height || lost) return
      renderer.setSize(width, height)
      camera.aspect = width / height
      camera.position.set(0, width < 700 ? 29 : 25, width < 700 ? 23 : 21)
      camera.lookAt(0, 0, 0)
      camera.updateProjectionMatrix()
      draw()
    }
    const ray = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const hit = new THREE.Vector3()
    function point(event: PointerEvent) {
      if (
        controls.current.paused ||
        (event.type === 'pointermove' && event.pointerType === 'touch')
      )
        return
      const bounds = container!.getBoundingClientRect()
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      )
      ray.setFromCamera(pointer, camera)
      if (!ray.ray.intersectPlane(plane, hit) || Math.abs(hit.x) > 17 || Math.abs(hit.z) > 17)
        return
      if (
        event.type === 'pointermove' &&
        (event.timeStamp - lastPointer < 65 || Math.hypot(hit.x - lastX, hit.z - lastZ) < 0.65)
      )
        return
      lastPointer = event.timeStamp
      lastX = hit.x
      lastZ = hit.z
      addRipple(hit.x, hit.z, event.type === 'pointerdown' ? 1.5 : 0.75)
    }
    function visibilityChange() {
      last = 0
      schedule()
    }
    function contextLost(event: Event) {
      event.preventDefault()
      lost = true
      cancelAnimationFrame(frame)
      frame = 0
    }
    function contextRestored() {
      lost = false
      resize()
      schedule()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      last = 0
      schedule()
    })
    intersection.observe(target)
    target.addEventListener('pointermove', point, { passive: true })
    target.addEventListener('pointerdown', point, { passive: true })
    document.addEventListener('visibilitychange', visibilityChange)
    renderer.domElement.addEventListener('webglcontextlost', contextLost)
    renderer.domElement.addEventListener('webglcontextrestored', contextRestored)
    resize()
    addRipple(8, 1, 0.9)
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      intersection.disconnect()
      target.removeEventListener('pointermove', point)
      target.removeEventListener('pointerdown', point)
      document.removeEventListener('visibilitychange', visibilityChange)
      renderer.domElement.removeEventListener('webglcontextlost', contextLost)
      renderer.domElement.removeEventListener('webglcontextrestored', contextRestored)
      geometry.dispose()
      material.dispose()
      cubes.dispose()
      light.shadow.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      controls.current.ripple = () => {}
    }
  }, [surface])

  useEffect(() => {
    if (!paused) controls.current.ripple()
  }, [paused])
  return <div className="wave-field" ref={host} aria-hidden="true" />
}
