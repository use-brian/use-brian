/**
 * [COMP:doc/starter-blueprints] — the installable starter catalog.
 *
 * The property that matters: a starter must be indistinguishable from a
 * blueprint a human authored in the editor. If it round-trips, it can be edited
 * after install; if it does not, we have shipped a template the owner cannot
 * change.
 */

import { describe, expect, it } from 'vitest'
import {
  MEETING_NOTES_STARTER,
  STARTER_BLUEPRINTS,
  findStarterBlueprint,
  starterExtractionSpec,
} from '../starter-blueprints.js'
import {
  blocksToExtractionSpec,
  extractionSpecToBlocks,
  extractionSpecSchema,
} from '../custom-template-types.js'

describe('[COMP:doc/starter-blueprints] round-trip', () => {
  it('derives a spec through the same path the editor uses', () => {
    const spec = starterExtractionSpec(MEETING_NOTES_STARTER)
    expect(spec).not.toBeNull()
    expect(spec!.fields.map((f) => f.key)).toEqual([
      'summary',
      'context',
      'key-points',
      'pain-points',
      'options',
      'decisions',
      'action-items',
      'quotes',
    ])
  })

  it('survives blocks → spec → blocks → spec unchanged', () => {
    // The install contract: the stored blocks re-derive the same contract the
    // fill ran under, so editing and re-saving in the WYSIWYG editor is lossless.
    const spec = starterExtractionSpec(MEETING_NOTES_STARTER)!
    const reSpec = blocksToExtractionSpec(extractionSpecToBlocks(spec), MEETING_NOTES_STARTER.capture)
    expect(reSpec).toEqual(spec)
  })

  it('passes the schema the create route validates against', () => {
    // If this fails, "install" would 400 — the starter would be uninstallable.
    expect(() => extractionSpecSchema.parse(starterExtractionSpec(MEETING_NOTES_STARTER))).not.toThrow()
  })
})

describe('[COMP:doc/starter-blueprints] the meeting contract', () => {
  it('marks exactly the sections whose absence means a failed fill', () => {
    // A meeting with no notable quotes is normal; a brief with no summary is
    // broken. Requiring everything would stamp every honest brief incomplete.
    const spec = starterExtractionSpec(MEETING_NOTES_STARTER)!
    expect(spec.fields.filter((f) => f.required).map((f) => f.key)).toEqual([
      'summary',
      'key-points',
      'decisions',
      'action-items',
    ])
  })

  it('asks every section for the citation the UI linkifies', () => {
    // The [H:MM:SS] text is what the render-time decoration turns into a seek
    // link and what the write path resolves into a typed pointer. A section that
    // forgets to ask for it produces prose you cannot click.
    for (const field of starterExtractionSpec(MEETING_NOTES_STARTER)!.fields) {
      expect(field.instruction, `${field.key} must demand a citation`).toContain('[H:MM:SS]')
    }
  })

  it('captures tasks and contacts so action items become real rows', () => {
    expect(MEETING_NOTES_STARTER.capture).toEqual(['task', 'contact'])
  })

  it('gives every field a non-empty instruction — it IS the model’s prompt', () => {
    for (const field of starterExtractionSpec(MEETING_NOTES_STARTER)!.fields) {
      expect(field.instruction.length).toBeGreaterThan(40)
      expect(field.type).toBe('markdown')
    }
  })
})

describe('[COMP:doc/starter-blueprints] catalog', () => {
  it('finds a starter by id and refuses an unknown one', () => {
    expect(findStarterBlueprint('meeting-notes')).toBe(MEETING_NOTES_STARTER)
    expect(findStarterBlueprint('nope')).toBeNull()
  })

  it('has unique ids', () => {
    expect(new Set(STARTER_BLUEPRINTS.map((s) => s.id)).size).toBe(STARTER_BLUEPRINTS.length)
  })
})
