export type SourceRange = { from: number; to: number }

/** The drag includes both touched characters, without splitting emoji or combining marks. */
export function selectionBoundaries(text: string, from = 0) {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
    .map((part) => from + part.index)
    .concat(from + text.length)
}

export function touchedRange(boundaries: number[], anchor: number, focus: number): SourceRange {
  const character = (offset: number) => {
    let lo = 0,
      hi = boundaries.length - 1
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (boundaries[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return Math.min(lo, boundaries.length - 2)
  }
  const a = character(anchor),
    b = character(focus)
  return { from: boundaries[Math.min(a, b)], to: boundaries[Math.max(a, b) + 1] }
}

export function sourceIndex(root: HTMLElement, node: Node, offset: number) {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const run = element?.closest<HTMLElement>('[data-source-run]')
  if (!run || !root.contains(run)) return null
  const prefix = document.createRange()
  prefix.selectNodeContents(run)
  prefix.setEnd(node, offset)
  return Number(run.dataset.sourceRun) + prefix.toString().length
}

export function sourceIndexAtPoint(root: HTMLElement, x: number, y: number) {
  const browserDocument = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const point = browserDocument.caretPositionFromPoint?.(x, y)
  if (point) return sourceIndex(root, point.offsetNode, point.offset)
  const range = browserDocument.caretRangeFromPoint?.(x, y)
  return range ? sourceIndex(root, range.startContainer, range.startOffset) : null
}

export function sourceDomRange(root: HTMLElement, selected: SourceRange) {
  const point = (index: number, end: boolean): [Node, number] | null => {
    const run = [...root.querySelectorAll<HTMLElement>('[data-source-run]')].find((item) => {
      const start = Number(item.dataset.sourceRun),
        finish = start + (item.textContent?.length ?? 0)
      return end ? start < index && finish >= index : start <= index && finish > index
    })
    if (!run) return null
    const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT)
    let remaining = index - Number(run.dataset.sourceRun)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (remaining <= (node.textContent?.length ?? 0)) return [node, remaining]
      remaining -= node.textContent?.length ?? 0
    }
    return null
  }
  const start = point(selected.from, false),
    end = point(selected.to, true)
  if (!start || !end) return null
  const range = document.createRange()
  range.setStart(...start)
  range.setEnd(...end)
  return range
}
