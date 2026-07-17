import { describe, it, expect } from 'vitest'
import { extractionSpecSchema, type ExtractionSpec } from '@sidanclaw/core'
import { extractionToBlueprintBody } from '../blueprint-from-template.js'

const SPEC: ExtractionSpec = extractionSpecSchema.parse({
  fields: [
    { key: 'what-the-business-does', heading: 'What the business does', instruction: 'Product, customers, revenue.', type: 'markdown', outputType: 'prose' },
    { key: 'open-risks', heading: 'Open risks', instruction: 'List the blockers.', type: 'markdown', outputType: 'list' },
    { key: 'budget', heading: 'Budget', instruction: 'Annual number.', type: 'number', required: true },
    { key: 'stage', heading: 'Stage', instruction: 'Pick one.', type: 'enum', options: ['Prospect', 'Won'] },
  ],
  capture: ['company', 'contact'],
})

describe('[COMP:api/blueprint-from-template] extractionToBlueprintBody', () => {
  it('renders the title and every field heading + key in order', () => {
    const body = extractionToBlueprintBody('Discovery brief', SPEC)
    expect(body).toContain('# Discovery brief')
    expect(body.indexOf('### 1. What the business does — `what-the-business-does`')).toBeGreaterThan(-1)
    expect(body.indexOf('### 2. Open risks — `open-risks`')).toBeGreaterThan(
      body.indexOf('### 1. What the business does'),
    )
    expect(body).toContain('### 3. Budget — `budget` (REQUIRED)')
  })

  it('wires the record sink (writeField) into every field with its instruction', () => {
    const body = extractionToBlueprintBody('B', SPEC)
    expect(body.match(/writeField\(/g)?.length).toBe(4)
    expect(body).toContain('writeField("budget"')
    expect(body).toContain('Product, customers, revenue.')
    // The engine, not the body, owns page authorship now.
    expect(body).not.toContain('patchPage')
  })

  it('renders per-type value guidance', () => {
    const body = extractionToBlueprintBody('B', SPEC)
    expect(body).toContain('a tight markdown paragraph') // markdown prose
    expect(body).toContain('a markdown bulleted list') // markdown list
    expect(body).toContain('a plain number') // number
    expect(body).toContain('exactly one of: Prospect, Won') // enum
  })

  it('emits a capture section listing the declared kinds', () => {
    const body = extractionToBlueprintBody('B', SPEC)
    expect(body).toContain('## Capture')
    expect(body).toContain('company, contact')
  })

  it('omits the capture section when nothing is captured', () => {
    const body = extractionToBlueprintBody('B', { fields: SPEC.fields, capture: [] })
    expect(body).not.toContain('## Capture')
  })

  it('renders per-kind capture instructions as bullets under the capture section', () => {
    const spec = extractionSpecSchema.parse({
      fields: SPEC.fields,
      capture: ['task', 'memory'],
      captureInstructions: {
        task: 'One task per maintenance item, imperative title.',
        memory: '  Save one memory per stated client preference.  ',
      },
    })
    const body = extractionToBlueprintBody('B', spec)
    expect(body).toContain('task, memory')
    expect(body).toContain('- task: One task per maintenance item, imperative title.')
    // Instruction text is trimmed at render time.
    expect(body).toContain('- memory: Save one memory per stated client preference.')
  })

  it('ignores instructions for kinds that are not in the capture list', () => {
    const spec = extractionSpecSchema.parse({
      fields: SPEC.fields,
      capture: ['company'],
      captureInstructions: { task: 'Never rendered.' },
    })
    const body = extractionToBlueprintBody('B', spec)
    expect(body).toContain('## Capture')
    expect(body).not.toContain('Never rendered.')
  })

  it('accepts memory as a capture kind (the blueprint-directed memory arm)', () => {
    const spec = extractionSpecSchema.parse({ fields: SPEC.fields, capture: ['memory'] })
    expect(spec.capture).toEqual(['memory'])
  })
})
