import { describe, it, expect } from 'vitest'
import type { ExtractionSpec } from '@sidanclaw/core'
import { extractionToBlueprintBody } from '../blueprint-from-template.js'

const SPEC: ExtractionSpec = {
  sections: [
    { heading: 'What the business does', instruction: 'Product, customers, revenue.', outputType: 'prose' },
    { heading: 'Open risks', instruction: 'List the blockers.', outputType: 'list' },
  ],
  capture: ['company', 'contact'],
}

describe('[COMP:api/blueprint-from-template] extractionToBlueprintBody', () => {
  it('renders the title and every section heading in order', () => {
    const body = extractionToBlueprintBody('Discovery brief', SPEC)
    expect(body).toContain('# Discovery brief')
    expect(body.indexOf('### 1. What the business does')).toBeGreaterThan(-1)
    expect(body.indexOf('### 2. Open risks')).toBeGreaterThan(
      body.indexOf('### 1. What the business does'),
    )
  })

  it('wires the engine verbs (searchRecording + patchPage) and start_ms provenance into every section', () => {
    const body = extractionToBlueprintBody('B', SPEC)
    expect(body.match(/searchRecording/g)?.length).toBe(2)
    expect(body.match(/patchPage/g)?.length).toBe(2)
    expect(body).toContain('start_ms')
    expect(body).toContain('Product, customers, revenue.')
  })

  it('renders the per-section output shape', () => {
    const body = extractionToBlueprintBody('B', SPEC)
    expect(body).toContain('a tight paragraph') // prose
    expect(body).toContain('a bulleted list') // list
  })

  it('emits a capture section listing the declared kinds', () => {
    const body = extractionToBlueprintBody('B', SPEC)
    expect(body).toContain('## Capture')
    expect(body).toContain('company, contact')
  })

  it('omits the capture section when nothing is captured', () => {
    const body = extractionToBlueprintBody('B', { sections: SPEC.sections, capture: [] })
    expect(body).not.toContain('## Capture')
  })
})
