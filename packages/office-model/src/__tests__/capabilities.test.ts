import { describe, expect, it } from 'vitest'
import { officeCapabilityManifest, preflightOfficeCandidate, validateOfficeCapabilityManifest } from '../capabilities.js'
import { documentFixture, id } from './fixtures.js'

describe('[COMP:office/capabilities] Office capability and admission contract', () => {
  it('declares every editable path and a reason for every rejection', () => {
    expect(validateOfficeCapabilityManifest()).toEqual([])
    expect(officeCapabilityManifest.capabilities.some((capability) => capability.id === 'animation' && capability.disposition === 'rejected')).toBe(true)
    expect(officeCapabilityManifest.capabilities.filter((capability) => capability.family === 'spreadsheet' && capability.disposition === 'rejected').map((capability) => capability.id)).toEqual(expect.arrayContaining(['spreadsheetChart', 'spreadsheetTable', 'spreadsheetHyperlink', 'spreadsheetRichText', 'spreadsheetFilter', 'spreadsheetProtection']))
    expect(officeCapabilityManifest.capabilities.filter((capability) => capability.family === 'spreadsheet' && capability.browserAuthoring === 'manual').map((capability) => capability.id)).toEqual(['worksheet', 'cellValue', 'cellFormula', 'rowColumnDimensions', 'worksheetImage'])
    expect(officeCapabilityManifest.capabilities.filter((capability) => (capability.family === 'document' || capability.family === 'shared') && capability.browserAuthoring === 'manual').map((capability) => capability.id)).toEqual(['richText', 'hyperlink', 'table', 'image', 'namedStyles', 'heading', 'nestedList', 'pageSetup', 'pageBreak', 'sectionBreak', 'headerFooter', 'pageNumber'])
    expect(officeCapabilityManifest.capabilities.find((capability) => capability.id === 'chart')?.browserAuthoring).toBe('projection-only')
    expect(officeCapabilityManifest.capabilities.find((capability) => capability.id === 'video')?.browserAuthoring).toBe('projection-only')
    expect(officeCapabilityManifest.capabilities.filter((capability) => capability.disposition === 'editable' && capability.assistantAuthoring === 'command')).toHaveLength(35)
    expect(officeCapabilityManifest.capabilities.find((capability) => capability.id === 'spreadsheetPdf')?.assistantAuthoring).toBe('action-only')
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
