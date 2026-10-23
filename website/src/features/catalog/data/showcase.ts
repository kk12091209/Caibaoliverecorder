import type { Work, WorkImage } from './works'

export type ShowcaseImage = WorkImage
export type ShowcaseEntry = {
  id: string
  kind: 'software' | 'experiment' | 'writing'
  title: string
  description: string
  href: string
  meta?: string
  version?: string
  featured?: boolean
  image?: ShowcaseImage
}

export const showcaseLabels = { software: '软件', experiment: '实验', writing: '文章' }

// Add real published experiments or articles here. Software comes from works.ts.
// Empty kinds are not displayed as empty categories or placeholder cards.
export const additionalEntries: ShowcaseEntry[] = []

export function makeShowcase(works: Work[]): ShowcaseEntry[] {
  return [
    ...works.map((work): ShowcaseEntry => ({
      id: work.slug,
      kind: 'software',
      title: work.name,
      description: work.showcase?.description ?? work.tagline,
      href: `/works/${work.slug}`,
      meta: work.showcase?.meta ?? work.platforms.map((platform) => platform.label).join(' / '),
      version: work.version,
      featured: work.featured,
      image: work.showcase?.image,
    })),
    ...additionalEntries,
  ]
}
