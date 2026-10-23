export const CAROUSEL_DESKTOP_QUERY = '(min-width: 761px) and (hover: hover) and (pointer: fine)'

export function carouselHasDesktopControls(
  agent: Pick<Navigator, 'userAgent' | 'maxTouchPoints'>,
  fineHover: boolean,
): boolean {
  const mobile =
    /Android|iPhone|iPad|iPod/i.test(agent.userAgent) ||
    (/Macintosh/i.test(agent.userAgent) && agent.maxTouchPoints > 1)
  return fineHover && !mobile
}

export function carouselGestureAxis(dx: number, dy: number): 'horizontal' | 'vertical' | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null
  if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.25) return 'horizontal'
  if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx) * 1.25) return 'vertical'
  return null
}

export function carouselSwipeDirection(dx: number, dy: number, width: number): -1 | 0 | 1 {
  if (!Number.isFinite(width) || width <= 0 || carouselGestureAxis(dx, dy) !== 'horizontal')
    return 0
  const threshold = Math.max(36, Math.min(72, width * 0.12))
  if (Math.abs(dx) < threshold) return 0
  return dx < 0 ? 1 : -1
}
