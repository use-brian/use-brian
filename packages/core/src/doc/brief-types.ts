/**
 * Governed Brief Page structure (project-briefs.md -> "Page representation").
 *
 * A Brief is one canonical Page whose top-level blocks carry two semantic
 * areas, each an id-bounded run of top-level blocks:
 *
 *   heading L2 [directionStartId]   Direction
 *   heading L3 [outcome]            Outcome      ...accepted outcome blocks
 *   heading L3 [rules]              Working rules
 *   heading L3 [decisions]          Accepted decisions
 *   heading L2 [contextStartId]     Current context
 *   heading L3 [findings]           Findings
 *   heading L3 [questions]          Open questions
 *   heading L3 [references]         References and progress
 *
 * The Direction region is [directionStartId, contextStartId). Identity is the
 * stable block id recorded on the binding, never the heading text or the Page
 * title. Pure helpers only: no DB, no Yjs, safe in browser and server.
 *
 * [COMP:doc/brief-types]
 */

import type { Block, HeadingBlock, Op, Ops, Page, TextBlock } from './page-types.js'
import { applyOps } from './ops.js'
import { blocksToMarkdown } from './to-markdown.js'

export const BRIEF_DIRECTION_SECTIONS = ['outcome', 'rules', 'decisions'] as const
export const BRIEF_CONTEXT_SECTIONS = ['findings', 'questions', 'references'] as const
export const BRIEF_SECTION_KEYS = [...BRIEF_DIRECTION_SECTIONS, ...BRIEF_CONTEXT_SECTIONS] as const

export type BriefDirectionSection = (typeof BRIEF_DIRECTION_SECTIONS)[number]
export type BriefContextSection = (typeof BRIEF_CONTEXT_SECTIONS)[number]
export type BriefSectionKey = (typeof BRIEF_SECTION_KEYS)[number]
export type BriefOwnerKind = 'department' | 'project'
export type BriefLocale = 'en' | 'ja' | 'zh' | 'zh-CN'

/** The stable ids a binding records for its Page. */
export type BriefLayout = {
  directionStartId: string
  contextStartId: string
  sectionIds: Record<BriefSectionKey, string>
}

export type BriefDirectionContent = Record<BriefDirectionSection, Block[]>
export type BriefContextContent = Record<BriefContextSection, Block[]>

type Labels = { direction: string; context: string } & Record<BriefSectionKey, string>

/** Built-in section headings, written once in the creator's locale. */
export const BRIEF_SECTION_LABELS: Record<BriefLocale, Labels> = {
  en: {
    direction: 'Direction', context: 'Current context', outcome: 'Outcome', rules: 'Working rules',
    decisions: 'Accepted decisions', findings: 'Findings', questions: 'Open questions', references: 'References and progress',
  },
  ja: {
    direction: '方針', context: '現在の状況', outcome: '成果', rules: '作業ルール',
    decisions: '決定事項', findings: '調査結果', questions: '未解決の質問', references: '参照と進捗',
  },
  zh: {
    direction: '方針', context: '目前狀況', outcome: '成果', rules: '工作規則',
    decisions: '已確認的決定', findings: '發現', questions: '待解問題', references: '參考與進度',
  },
  'zh-CN': {
    direction: '方针', context: '当前状况', outcome: '成果', rules: '工作规则',
    decisions: '已确认的决定', findings: '发现', questions: '待解问题', references: '参考与进度',
  },
}

export function normalizeBriefLocale(value: string | null | undefined): BriefLocale {
  if (value === 'ja' || value === 'zh' || value === 'zh-CN') return value
  if (value?.toLowerCase() === 'zh-cn') return 'zh-CN'
  return 'en'
}

const heading = (id: string, level: 2 | 3, text: string): HeadingBlock => ({ kind: 'heading', id, level, text })

/**
 * The empty Brief: every section exists and is empty. Empty Direction means
 * "not established"; nothing is generated from a Project or Department name.
 */
export function buildBriefSkeleton(locale: BriefLocale, newId: () => string): { layout: BriefLayout; page: Page } {
  const labels = BRIEF_SECTION_LABELS[locale]
  const sectionIds = Object.fromEntries(BRIEF_SECTION_KEYS.map(key => [key, newId()])) as Record<BriefSectionKey, string>
  const layout: BriefLayout = { directionStartId: newId(), contextStartId: newId(), sectionIds }
  const page: Page = {
    blocks: [
      heading(layout.directionStartId, 2, labels.direction),
      ...BRIEF_DIRECTION_SECTIONS.map(key => heading(sectionIds[key], 3, labels[key])),
      heading(layout.contextStartId, 2, labels.context),
      ...BRIEF_CONTEXT_SECTIONS.map(key => heading(sectionIds[key], 3, labels[key])),
    ],
  }
  return { layout, page }
}

/** Stable JSON: key order never decides equality. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function canonicalBlocksJson(blocks: readonly Block[] | null): string {
  return blocks === null ? 'invalid' : canonical(blocks)
}

/**
 * The Direction region, or null when the structure is broken (a boundary
 * missing, or the context boundary before the direction boundary). A null
 * region is never equal to a valid one, so a deleted boundary is a change.
 */
export function extractDirectionRegion(page: Page, layout: BriefLayout): Block[] | null {
  const start = page.blocks.findIndex(block => block.id === layout.directionStartId)
  const stop = page.blocks.findIndex(block => block.id === layout.contextStartId)
  if (start < 0 || stop < 0 || stop < start) return null
  return page.blocks.slice(start, stop)
}

export function directionRegionsEqual(a: readonly Block[] | null, b: readonly Block[] | null): boolean {
  return canonicalBlocksJson(a) === canonicalBlocksJson(b)
}

/** Blocks outside the Direction region, in order (context and ordinary notes). */
function outsideRegion(page: Page, layout: BriefLayout): Block[] | null {
  const start = page.blocks.findIndex(block => block.id === layout.directionStartId)
  const stop = page.blocks.findIndex(block => block.id === layout.contextStartId)
  if (start < 0 || stop < 0 || stop < start) return null
  return [...page.blocks.slice(0, start), ...page.blocks.slice(stop)]
}

const structuralDirectionIds = (layout: BriefLayout) => new Set([
  layout.directionStartId, ...BRIEF_DIRECTION_SECTIONS.map(key => layout.sectionIds[key]),
])

/**
 * Split a valid region into its three sections. Null when a structural heading
 * is missing, out of order, or no longer a heading.
 */
export function directionSections(region: readonly Block[] | null, layout: BriefLayout): BriefDirectionContent | null {
  if (!region || region[0]?.id !== layout.directionStartId || region[0].kind !== 'heading') return null
  const positions = BRIEF_DIRECTION_SECTIONS.map(key => region.findIndex(block => block.id === layout.sectionIds[key]))
  if (positions.some(index => index < 1) || positions.some((index, i) => i > 0 && index <= positions[i - 1])) return null
  if (positions.some(index => region[index].kind !== 'heading')) return null
  const content = {} as BriefDirectionContent
  BRIEF_DIRECTION_SECTIONS.forEach((key, i) => {
    content[key] = region.slice(positions[i] + 1, i + 1 < positions.length ? positions[i + 1] : region.length)
  })
  return content
}

/**
 * Current-context sections, from the context boundary up to the next top-level
 * heading of level 1-2 that is not part of the layout (ordinary notes follow
 * it). Null when a context heading is missing or out of order.
 */
export function contextSections(page: Page, layout: BriefLayout): BriefContextContent | null {
  const start = page.blocks.findIndex(block => block.id === layout.contextStartId)
  if (start < 0) return null
  let stop = page.blocks.length
  for (let i = start + 1; i < page.blocks.length; i += 1) {
    const block = page.blocks[i]
    if (block.kind === 'heading' && block.level <= 2) { stop = i; break }
  }
  const area = page.blocks.slice(start, stop)
  const positions = BRIEF_CONTEXT_SECTIONS.map(key => area.findIndex(block => block.id === layout.sectionIds[key]))
  if (positions.some(index => index < 1) || positions.some((index, i) => i > 0 && index <= positions[i - 1])) return null
  const content = {} as BriefContextContent
  BRIEF_CONTEXT_SECTIONS.forEach((key, i) => {
    content[key] = area.slice(positions[i] + 1, i + 1 < positions.length ? positions[i + 1] : area.length)
  })
  return content
}

export type DirectionOpsValidation =
  | { ok: true; page: Page; region: Block[]; sections: BriefDirectionContent }
  | { ok: false; reason: 'ops_invalid' | 'outside_direction' | 'structure_invalid' | 'no_change' }

/**
 * Validate exact typed ops as a Direction change against `page`: every op is a
 * block op inside the region, structural headings are only re-labelled, the
 * result keeps a valid structure, nothing outside the region changes, and the
 * region actually changes. The same check runs when a draft is saved and again
 * on the authoritative state at publication.
 */
export function validateDirectionOps(page: Page, ops: Ops, layout: BriefLayout): DirectionOpsValidation {
  const before = extractDirectionRegion(page, layout)
  if (!before || !directionSections(before, layout)) return { ok: false, reason: 'structure_invalid' }
  if (!ops.length) return { ok: false, reason: 'no_change' }
  const inRegion = new Set(before.map(block => block.id))
  const structural = structuralDirectionIds(layout)
  const minted = new Set<string>()
  for (const op of ops) {
    if (op.op === 'setTitle' || op.op === 'setIcon') return { ok: false, reason: 'outside_direction' }
    if (op.op === 'add') {
      const anchor = op.after
      if (!anchor || anchor === 'start' || anchor === 'end') return { ok: false, reason: 'outside_direction' }
      if (!inRegion.has(anchor) && !minted.has(anchor)) return { ok: false, reason: 'outside_direction' }
      if (op.block.id && structural.has(op.block.id)) return { ok: false, reason: 'ops_invalid' }
      if (op.block.id) minted.add(op.block.id)
      continue
    }
    if (!inRegion.has(op.blockId) && !minted.has(op.blockId)) return { ok: false, reason: 'outside_direction' }
    if (structural.has(op.blockId) && op.op !== 'edit') return { ok: false, reason: 'ops_invalid' }
    if (op.op === 'edit' && structural.has(op.blockId)) {
      const keys = Object.keys(op.patch).filter(key => key !== 'id' && key !== 'kind')
      if (keys.some(key => key !== 'text')) return { ok: false, reason: 'ops_invalid' }
    }
    if (op.op === 'move') {
      if (op.after === 'start' || op.after === 'end') return { ok: false, reason: 'outside_direction' }
      if (!inRegion.has(op.after) && !minted.has(op.after)) return { ok: false, reason: 'outside_direction' }
    }
  }
  let next: Page
  try {
    next = applyOps(page, ops).page
  } catch {
    return { ok: false, reason: 'ops_invalid' }
  }
  const region = extractDirectionRegion(next, layout)
  const sections = directionSections(region, layout)
  if (!region || !sections) return { ok: false, reason: 'structure_invalid' }
  if (canonicalBlocksJson(outsideRegion(page, layout)) !== canonicalBlocksJson(outsideRegion(next, layout))) {
    return { ok: false, reason: 'outside_direction' }
  }
  if (directionRegionsEqual(before, region)) return { ok: false, reason: 'no_change' }
  return { ok: true, page: next, region, sections }
}

/**
 * Typed ops that set Direction sections to the given lines (one text block per
 * line). Sections not named are left untouched. The human draft editor and
 * Brian's section form both compile to these exact ops.
 */
export function buildDirectionSectionOps(
  page: Page,
  layout: BriefLayout,
  sections: Partial<Record<BriefDirectionSection, readonly string[]>>,
  newId: () => string,
): Ops {
  const current = directionSections(extractDirectionRegion(page, layout), layout)
  if (!current) return []
  const ops: Op[] = []
  for (const key of BRIEF_DIRECTION_SECTIONS) {
    const lines = sections[key]
    if (!lines) continue
    const wanted = lines.map(line => line.trim()).filter(Boolean)
    const existing = current[key]
    const same = existing.length === wanted.length
      && existing.every((block, i) => block.kind === 'text' && (block as TextBlock).text === wanted[i])
    if (same) continue
    for (const block of existing) ops.push({ op: 'delete', blockId: block.id })
    let after = layout.sectionIds[key]
    for (const text of wanted) {
      const id = newId()
      ops.push({ op: 'add', after, block: { kind: 'text', id, text } })
      after = id
    }
  }
  return ops
}

/** Plain lines of a section (one per block), for forms and summaries. */
export function sectionLines(blocks: readonly Block[]): string[] {
  return blocks.map(block => blocksToMarkdown([block]).trim()).filter(Boolean)
}

export function isDirectionEmpty(sections: BriefDirectionContent | null): boolean {
  return !sections || BRIEF_DIRECTION_SECTIONS.every(key => sections[key].length === 0)
}

/** Model-facing rendering of accepted Direction. Empty sections say so. */
export function renderBriefDirection(sections: BriefDirectionContent | null, notEstablished = 'not established'): string {
  if (!sections) return `Direction: ${notEstablished}`
  const titles: Record<BriefDirectionSection, string> = { outcome: 'Outcome', rules: 'Working rules', decisions: 'Accepted decisions' }
  return BRIEF_DIRECTION_SECTIONS.map(key => {
    const body = blocksToMarkdown(sections[key]).trim()
    return `${titles[key]}:\n${body || `(${notEstablished})`}`
  }).join('\n\n')
}

export function renderBriefContext(sections: BriefContextContent | null, maxChars = 4000): string {
  if (!sections) return ''
  const titles: Record<BriefContextSection, string> = { findings: 'Findings', questions: 'Open questions', references: 'References and progress' }
  const text = BRIEF_CONTEXT_SECTIONS.map(key => {
    const body = blocksToMarkdown(sections[key]).trim()
    return body ? `${titles[key]}:\n${body}` : ''
  }).filter(Boolean).join('\n\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n(current context truncated; read the Brief for the rest)` : text
}
