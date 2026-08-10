import { describe, expect, it } from 'vitest'
import {
  parseGDriveOfflineEnrichmentBundle,
  renderOfflineGDriveEnrichment,
} from '../enrichment-bundle.js'

const entry = {
  fileId: 'drive-file-1',
  version: '128',
  name: 'Renewal playbook',
  mimeType: 'application/vnd.google-apps.document',
  modifiedTime: '2026-08-10T08:30:00.000Z',
  folderPath: ['Company', 'Sales'],
  summary: 'How account teams prepare renewals.',
  keywords: ['renewal', 'approval'],
  content: 'Evidence text.',
}

describe('[COMP:integrations/gdrive-enrichment] offline Drive enrichment bundle', () => {
  it('accepts the strict V1 contract and renders a searchable artifact', () => {
    const parsed = parseGDriveOfflineEnrichmentBundle({
      schemaVersion: 1,
      source: 'google-drive',
      files: [entry],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const text = renderOfflineGDriveEnrichment(parsed.value.files[0])
    expect(text).toContain('# Renewal playbook')
    expect(text).toContain('Company / Sales')
    expect(text).toContain('How account teams prepare renewals.')
    expect(text).toContain('Evidence text.')
  })

  it('rejects unknown fields and missing summaries', () => {
    expect(parseGDriveOfflineEnrichmentBundle({
      schemaVersion: 1,
      source: 'google-drive',
      files: [{ ...entry, unexpected: true }],
    }).ok).toBe(false)
    expect(parseGDriveOfflineEnrichmentBundle({
      schemaVersion: 1,
      source: 'google-drive',
      files: [{ ...entry, summary: '' }],
    }).ok).toBe(false)
  })

  it('caps each HTTP batch at 25 entries', () => {
    expect(parseGDriveOfflineEnrichmentBundle({
      schemaVersion: 1,
      source: 'google-drive',
      files: Array.from({ length: 26 }, (_, i) => ({ ...entry, fileId: `file-${i}` })),
    }).ok).toBe(false)
  })
})
