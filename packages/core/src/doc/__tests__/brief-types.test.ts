import { describe, expect, it } from 'vitest'
import {
  buildBriefSkeleton,
  buildDirectionSectionOps,
  contextSections,
  directionRegionsEqual,
  directionSections,
  extractDirectionRegion,
  isDirectionEmpty,
  normalizeBriefLocale,
  renderBriefDirection,
  validateDirectionOps,
} from '../brief-types.js'
import { applyOps } from '../ops.js'
import type { Page } from '../page-types.js'

let generators = 0
function ids() {
  const prefix = `g${++generators}-`
  let n = 0
  return () => `${prefix}${++n}`
}

function skeleton() {
  return buildBriefSkeleton('en', ids())
}

describe('[COMP:doc/brief-types] Brief Page structure', () => {
  it('builds an empty, not-established Direction with stable section ids', () => {
    const { layout, page } = skeleton()
    const region = extractDirectionRegion(page, layout)
    const sections = directionSections(region, layout)
    expect(sections).not.toBeNull()
    expect(isDirectionEmpty(sections)).toBe(true)
    expect(renderBriefDirection(sections)).toContain('Outcome:\n(not established)')
    expect(contextSections(page, layout)).toEqual({ findings: [], questions: [], references: [] })
    expect(new Set([layout.directionStartId, layout.contextStartId, ...Object.values(layout.sectionIds)]).size).toBe(8)
  })

  it('localizes headings without changing identity', () => {
    const ja = buildBriefSkeleton(normalizeBriefLocale('ja'), ids())
    expect(ja.page.blocks[0]).toMatchObject({ kind: 'heading', text: '方針' })
    expect(normalizeBriefLocale('zh-cn')).toBe('zh-CN')
    expect(normalizeBriefLocale('fr')).toBe('en')
  })

  it('accepts section ops that change only the Direction region', () => {
    const { layout, page } = skeleton()
    const ops = buildDirectionSectionOps(page, layout, { outcome: ['Ship the billing pilot'], rules: ['No customer data leaves the workspace'] }, ids())
    const result = validateDirectionOps(page, ops, layout)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sections.outcome.map(b => (b as { text: string }).text)).toEqual(['Ship the billing pilot'])
    expect(result.sections.rules).toHaveLength(1)
    expect(result.sections.decisions).toEqual([])
    // Rebuilding the same content is no change.
    expect(buildDirectionSectionOps(result.page, layout, { outcome: ['Ship the billing pilot'] }, ids())).toEqual([])
  })

  it('refuses ops that touch context, the title, the boundaries, or nothing', () => {
    const { layout, page } = skeleton()
    const findings = layout.sectionIds.findings
    expect(validateDirectionOps(page, [{ op: 'add', after: findings, block: { kind: 'text', id: 'x', text: 'a fact' } }], layout))
      .toEqual({ ok: false, reason: 'outside_direction' })
    expect(validateDirectionOps(page, [{ op: 'setTitle', title: 'Rules' }], layout)).toEqual({ ok: false, reason: 'outside_direction' })
    expect(validateDirectionOps(page, [{ op: 'delete', blockId: layout.sectionIds.rules }], layout)).toEqual({ ok: false, reason: 'ops_invalid' })
    expect(validateDirectionOps(page, [{ op: 'add', block: { kind: 'text', id: 'y', text: 'appended' } }], layout))
      .toEqual({ ok: false, reason: 'outside_direction' })
    expect(validateDirectionOps(page, [{ op: 'move', blockId: layout.sectionIds.outcome, after: findings }], layout))
      .toEqual({ ok: false, reason: 'ops_invalid' })
    expect(validateDirectionOps(page, [], layout)).toEqual({ ok: false, reason: 'no_change' })
    // Relabelling a structural heading is a Direction change; changing its level is not allowed.
    expect(validateDirectionOps(page, [{ op: 'edit', blockId: layout.sectionIds.rules, patch: { text: 'Rules of play' } }], layout).ok).toBe(true)
    expect(validateDirectionOps(page, [{ op: 'edit', blockId: layout.sectionIds.rules, patch: { level: 1 } as never }], layout))
      .toEqual({ ok: false, reason: 'ops_invalid' })
  })

  it('treats any move, delete or replacement of the region as a change', () => {
    const { layout, page } = skeleton()
    const accepted = applyOps(page, buildDirectionSectionOps(page, layout, { rules: ['Rule one'] }, ids())).page
    const region = extractDirectionRegion(accepted, layout)
    const rule = directionSections(region, layout)!.rules[0]
    const moved: Page = { blocks: [...accepted.blocks.filter(b => b.id !== rule.id), rule] }
    expect(directionRegionsEqual(region, extractDirectionRegion(moved, layout))).toBe(false)
    const noBoundary: Page = { blocks: accepted.blocks.filter(b => b.id !== layout.contextStartId) }
    expect(extractDirectionRegion(noBoundary, layout)).toBeNull()
    expect(directionRegionsEqual(region, null)).toBe(false)
    // Editing only Current context leaves the region equal.
    const contextEdit = applyOps(accepted, [{ op: 'add', after: layout.sectionIds.findings, block: { kind: 'text', id: 'f1', text: 'A finding' } }]).page
    expect(directionRegionsEqual(region, extractDirectionRegion(contextEdit, layout))).toBe(true)
    expect(contextSections(contextEdit, layout)!.findings).toHaveLength(1)
  })
})
