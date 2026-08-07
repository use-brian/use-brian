import { describe, expect, it } from 'vitest'
import { inferOfficeTemplateRouting, officeTemplateRoutingDiagnostics } from '../templates/routing.js'
import { completePresentationSnapshot, id } from './fixtures.js'

describe('[COMP:office/template-routing] Presentation template routing', () => {
  it('deterministically maps source slides and editable objects into reviewable recipes', () => {
    const snapshot = completePresentationSnapshot()
    const first = inferOfficeTemplateRouting(snapshot, 'upload')
    const second = inferOfficeTemplateRouting(snapshot, 'upload')

    expect(first).toEqual(second)
    expect(first.source).toBe('upload')
    expect(first.slideRecipes).toHaveLength(snapshot.slides.length)
    expect(first.slideRecipes[0]).toMatchObject({ slideId: snapshot.slides[0].id, role: 'cover', enabled: true, reviewed: false })
    expect(first.slideRecipes[1]).toMatchObject({ slideId: snapshot.slides[1].id, role: 'closing', repeatable: false, maxUses: 1 })
    expect(first.fields.some((field) => field.targetIds.includes(id(38)))).toBe(false)
    expect(first.slideRecipes.flatMap((recipe) => recipe.fieldIds).sort()).toEqual(first.fields.map((field) => field.id).sort())
    expect(officeTemplateRoutingDiagnostics(snapshot, first)).toEqual([])
  })

  it('rejects cross-slide targets and field types incompatible with their mapped objects', () => {
    const snapshot = completePresentationSnapshot()
    const routing = inferOfficeTemplateRouting(snapshot, 'upload')
    const firstField = routing.fields[0]
    const invalid = structuredClone(routing)
    invalid.fields[0] = { ...firstField, type: 'image', targetIds: [snapshot.slides[1].objects[0].id] }

    expect(officeTemplateRoutingDiagnostics(snapshot, invalid)).toEqual(expect.arrayContaining([
      expect.stringContaining('outside the source slide'),
      expect.stringContaining('incompatible with target object'),
    ]))

    invalid.slideRecipes.pop()
    expect(officeTemplateRoutingDiagnostics(snapshot, invalid)).toEqual(expect.arrayContaining([
      expect.stringContaining('Source slide 2 has no recipe'),
    ]))
  })

  it('bounds content-heavy recipe names and gives untitled slides a readable fallback', () => {
    const snapshot = structuredClone(completePresentationSnapshot())
    snapshot.slides[0].title = `  ${'Decision context and supporting evidence '.repeat(12)}  `
    snapshot.slides[1].title = '   '

    const routing = inferOfficeTemplateRouting(snapshot, 'upload')

    expect(routing.slideRecipes[0].name.length).toBeLessThanOrEqual(200)
    expect(routing.slideRecipes[0].name).toMatch(/\.\.\.$/)
    expect(routing.slideRecipes[0].name).not.toMatch(/\s{2,}/)
    expect(routing.slideRecipes[1].name).toBe('Slide 2')
    expect(officeTemplateRoutingDiagnostics(snapshot, routing)).toEqual([])
  })

  it('keeps inferred field registry names unique when several slides share a role', () => {
    const snapshot = structuredClone(completePresentationSnapshot())
    const closingObject = snapshot.slides[1].objects[0]
    if (closingObject?.kind !== 'text') throw new Error('Fixture closing object must be text')
    const middleSlide = (slideId: number, objectId: number, runId: number, title: string) => ({
      ...snapshot.slides[1],
      id: id(slideId),
      title,
      objects: [{ ...closingObject, id: id(objectId), runs: [{ ...closingObject.runs[0], id: id(runId), text: title }] }],
      readingOrder: [id(objectId)],
    })
    snapshot.slides.splice(1, 0,
      middleSlide(80, 81, 82, 'How it works for teams'),
      middleSlide(83, 84, 85, 'How it works for knowledge'),
    )

    const routing = inferOfficeTemplateRouting(snapshot, 'upload')
    expect(new Set(routing.fields.map((field) => field.name)).size).toBe(routing.fields.length)
    expect(routing.fields.map((field) => field.name)).toEqual(expect.arrayContaining([
      'process.slide-2.content-1',
      'process.slide-3.content-1',
    ]))
  })

  it('derives text limits from box geometry and inherited display typography', () => {
    const snapshot = structuredClone(completePresentationSnapshot())
    const closing = snapshot.slides[1].objects[0]
    if (closing?.kind !== 'text') throw new Error('Fixture closing object must be text')
    closing.geometry = { ...closing.geometry, widthPt: 570, heightPt: 135 }
    closing.runs = closing.runs.map((run) => ({ ...run, style: { ...run.style, fontSizePt: 42 } }))

    const routing = inferOfficeTemplateRouting(snapshot, 'upload')
    const field = routing.fields.find((candidate) => candidate.targetIds.includes(closing.id))

    expect(field?.maxLength).toBe(54)
    expect(field?.maxLength).toBeLessThan(70)
  })
})
