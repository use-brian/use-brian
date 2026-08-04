import { describe, expect, it } from 'vitest'
import { officeCapabilityManifest, preflightOfficeCandidate, validateOfficeCapabilityManifest } from '../capabilities.js'
import { documentFixture, id } from './fixtures.js'

describe('[COMP:office/capabilities] Office capability and admission contract', () => {
  it('declares every editable path and a reason for every rejection', () => {
    expect(validateOfficeCapabilityManifest()).toEqual([])
    expect(officeCapabilityManifest.capabilities.some((capability) => capability.id === 'animation' && capability.disposition === 'rejected')).toBe(true)
  })

  it('returns object-specific missing-resource diagnostics without mutation', () => {
    const candidate = documentFixture()
    candidate.sections[0].nodes.push({ id: id(31), kind: 'image', resourceId: id(32), altText: 'Logo', decorative: false, widthPt: 100, heightPt: 50 })
    const result = preflightOfficeCandidate(candidate)
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'resource.missing', path: expect.stringContaining('nodes.1') }))
    expect(candidate.resources).toEqual([])
  })
})
