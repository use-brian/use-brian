import { describe, it, expect } from 'vitest'

import {
  PAGE_TEMPLATES,
  applyTemplateVars,
  defaultTemplateVars,
  getPageTemplate,
  instantiatePageTemplate,
  listPageTemplates,
  pageTemplateIds,
} from '../templates.js'

// A fixed clock so date placeholders are deterministic. 2026-06-24 is a
// Wednesday; ISO week 26.
const NOW = new Date('2026-06-24T12:00:00.000Z')

describe('[COMP:doc/templates] Page templates', () => {
  describe('registry integrity', () => {
    it('exposes a non-empty catalog with unique ids', () => {
      expect(PAGE_TEMPLATES.length).toBeGreaterThan(0)
      const ids = pageTemplateIds()
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('every template carries the required metadata', () => {
      for (const t of PAGE_TEMPLATES) {
        expect(t.id).toMatch(/^[a-z0-9-]+$/)
        expect(t.name.length).toBeGreaterThan(0)
        expect(t.description.length).toBeGreaterThan(0)
        expect(t.icon.length).toBeGreaterThan(0)
        expect(t.keywords.length).toBeGreaterThan(0)
        expect(t.titleTemplate.length).toBeGreaterThan(0)
        expect(t.body.length).toBeGreaterThan(0)
      }
    })

    it('uses hyphens, never the em dash, in user-facing copy', () => {
      for (const t of PAGE_TEMPLATES) {
        expect(t.name + t.description + t.titleTemplate + t.body).not.toContain('—')
      }
    })
  })

  describe('listPageTemplates', () => {
    it('returns summaries without the heavy body', () => {
      const rows = listPageTemplates()
      expect(rows.length).toBe(PAGE_TEMPLATES.length)
      for (const r of rows) {
        expect(r).not.toHaveProperty('body')
        expect(r.id).toBeTruthy()
      }
    })

    it('filters by category', () => {
      const planning = listPageTemplates('planning')
      expect(planning.length).toBeGreaterThan(0)
      expect(planning.every((r) => r.category === 'planning')).toBe(true)
    })
  })

  describe('variable substitution', () => {
    it('derives deterministic date vars from the clock (UTC)', () => {
      const vars = defaultTemplateVars(NOW)
      expect(vars.date).toBe('2026-06-24')
      expect(vars.dateLong).toBe('June 24, 2026')
      expect(vars.weekday).toBe('Wednesday')
      expect(vars.month).toBe('June')
      expect(vars.year).toBe('2026')
      expect(vars.week).toBe('2026-W26')
    })

    it('replaces known placeholders and leaves unknown ones verbatim', () => {
      const out = applyTemplateVars('a {{date}} b {{nope}} c', { date: '2026-06-24' })
      expect(out).toBe('a 2026-06-24 b {{nope}} c')
    })

    it('tolerates inner whitespace in the placeholder', () => {
      expect(applyTemplateVars('{{ date }}', { date: 'X' })).toBe('X')
    })
  })

  describe('instantiatePageTemplate', () => {
    it('returns undefined for an unknown id', () => {
      expect(instantiatePageTemplate('does-not-exist')).toBeUndefined()
    })

    it('resolves the title placeholders against the clock', () => {
      const inst = instantiatePageTemplate('meeting-notes', { now: NOW })
      expect(inst?.title).toBe('Meeting notes - 2026-06-24')
      expect(inst?.icon).toBe('📝')
      expect(inst?.templateId).toBe('meeting-notes')
    })

    it('honors a titleOverride without expanding placeholders in it', () => {
      const inst = instantiatePageTemplate('meeting-notes', {
        now: NOW,
        titleOverride: 'Kickoff {{date}}',
      })
      expect(inst?.title).toBe('Kickoff {{date}}')
    })

    it('produces canonical blocks with non-empty unique ids', () => {
      const inst = instantiatePageTemplate('project-plan', { now: NOW })
      expect(inst).toBeDefined()
      const blocks = inst!.blocks
      expect(blocks.length).toBeGreaterThan(0)
      const ids = blocks.map((b) => b.id)
      expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('mints fresh ids on each instantiation', () => {
      const a = instantiatePageTemplate('standup', { now: NOW })!
      const b = instantiatePageTemplate('standup', { now: NOW })!
      const aIds = new Set(a.blocks.map((bl) => bl.id))
      expect(b.blocks.some((bl) => aIds.has(bl.id))).toBe(false)
    })

    it('maps structured Markdown to the right block kinds', () => {
      const inst = instantiatePageTemplate('weekly-review', { now: NOW })!
      const kinds = new Set(inst.blocks.map((b) => b.kind))
      // headings, a GFM alert -> callout, a GFM table, and a checkbox -> to_do.
      expect(kinds.has('heading')).toBe(true)
      expect(kinds.has('callout')).toBe(true)
      expect(kinds.has('table')).toBe(true)
      expect(kinds.has('to_do')).toBe(true)
    })

    it('respects an injected id generator (deterministic ids)', () => {
      let n = 0
      const genId = () => `tpl-${n++}`
      const inst = instantiatePageTemplate('reading-list', { now: NOW, genId })!
      expect(inst.blocks.every((b) => b.id.startsWith('tpl-'))).toBe(true)
    })

    it('every catalog template instantiates without throwing', () => {
      for (const t of PAGE_TEMPLATES) {
        const inst = instantiatePageTemplate(t.id, { now: NOW })
        expect(inst, t.id).toBeDefined()
        expect(inst!.blocks.length, t.id).toBeGreaterThan(0)
      }
    })
  })

  describe('getPageTemplate', () => {
    it('returns the full definition incl. body', () => {
      const t = getPageTemplate('okrs')
      expect(t?.body).toContain('Objective')
    })
  })
})
