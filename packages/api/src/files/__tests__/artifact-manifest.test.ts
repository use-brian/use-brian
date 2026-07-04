import { describe, it, expect } from 'vitest'
import { renderArtifactManifest } from '../artifact-manifest.js'

describe('[COMP:files/artifact-manifest] renderArtifactManifest', () => {
  const base = {
    fileId: '3f2a0000-0000-4000-8000-000000000001',
    fileName: 'q3-report.docx',
    mime: 'text/markdown',
    sizeBytes: 421_888,
    charLength: 118_400,
    segmentCount: 96,
    summary: 'Quarterly financial report.',
    status: 'ready' as const,
  }

  it('carries the artifact id, tool hints, and the attached_file envelope', () => {
    const m = renderArtifactManifest(base)
    expect(m).toContain(`<attached_file id="${base.fileId}"`)
    expect(m).toContain('kind="artifact"')
    expect(m).toContain(`searchFileContent with fileId="${base.fileId}"`)
    expect(m).toContain('fromIndex/toIndex')
    expect(m).toContain('96 indexed sections')
    expect(m).toContain('412 KB')
    expect(m).toContain('Quarterly financial report.')
    expect(m).toContain('content NOT inlined')
    expect(m.endsWith('</attached_file>')).toBe(true)
  })

  it('never contains an em dash (user-visible transcript copy rule)', () => {
    for (const status of ['ready', 'pending', 'failed'] as const) {
      expect(renderArtifactManifest({ ...base, status })).not.toContain('—')
    }
  })

  it('pending and failed states change only the status line', () => {
    const pending = renderArtifactManifest({ ...base, status: 'pending' })
    expect(pending).toContain('status: indexing')
    const failed = renderArtifactManifest({ ...base, status: 'failed' })
    expect(failed).toContain('indexing failed')
    expect(failed).toContain('readFileContent')
  })

  it('truncated chunking is stated inline with the section count', () => {
    const m = renderArtifactManifest({ ...base, truncated: true })
    expect(m).toContain('first part only')
  })

  it('omits optional stats gracefully', () => {
    const m = renderArtifactManifest({
      fileId: base.fileId,
      fileName: 'x.txt',
      mime: 'text/plain',
      sizeBytes: 500,
      status: 'pending',
    })
    expect(m).toContain('500 B')
    expect(m).not.toContain('indexed sections')
    expect(m).not.toContain('summary:')
  })
})
