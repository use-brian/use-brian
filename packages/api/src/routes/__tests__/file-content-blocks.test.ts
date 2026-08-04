import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db/users.js', () => ({ findOrCreateUser: vi.fn(), findUserById: vi.fn() }))
vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
vi.mock('../../mcp/inject.js', () => ({ injectMcpTools: vi.fn() }))

import { buildFileContentBlocks } from '../route-helpers.js'


/**
 * SEAM 1 — the attachment turn contract.
 *
 * Everything a large file passes through is observable here: parse ceilings,
 * the inline gate, truncation, the artifact manifest, and the tabular profile.
 * These assert what the MODEL RECEIVES, never which branch produced it.
 *
 * Regression anchor: on 2026-08-02 a 4,159-row CSV reached the model as its
 * first 331 rows and the assistant reported the fragment's date range as the
 * file's. See issue #273.
 */
describe('[COMP:api/route-helpers] Attachment turn contract', () => {
  // A CSV spanning 2023-06 to 2026-07, like the incident file. Rows are wide
  // enough that the first 20,000 chars cover only the earliest months.
  function incidentCsv(rows = 4000): string {
    const out = ['date,exercise,weight,reps']
    for (let i = 0; i < rows; i++) {
      const y = 2023 + Math.floor(i / 1300)
      const mo = ((i % 12) + 1).toString().padStart(2, '0')
      out.push(`${y}-${mo}-15,Bench Press (Barbell) long exercise name,${40 + (i % 60)},${5 + (i % 8)}`)
    }
    return out.join('\n')
  }

  const file = (buffer: Buffer, mimeType: string, fileName: string, id?: string) => ({
    buffer,
    mimeType,
    fileName,
    ...(id ? { id } : {}),
  })

  it('inlines a small text file whole', async () => {
    const body = 'alpha,beta\n1,2\n3,4'
    const r = await buildFileContentBlocks([file(Buffer.from(body), 'text/csv', 'tiny.csv')])
    expect(r.attachmentContext).toContain('alpha,beta')
    expect(r.attachmentContext).toContain('3,4')
  })

  describe('large tabular files', () => {
    it('delivers a profile, not rows', async () => {
      const csv = incidentCsv()
      const r = await buildFileContentBlocks([file(Buffer.from(csv), 'text/csv', 'workouts.csv')])
      expect(r.attachmentContext).toContain('kind="tabular"')
      // The bulk of the data must not be present. Three sample rows are fine;
      // hundreds are the bug.
      const dataLines = r.attachmentContext.split('\n').filter((l) => /Bench Press/.test(l))
      expect(dataLines.length).toBeLessThanOrEqual(3)
    })

    it('states the TRUE row count, not the delivered one', async () => {
      const r = await buildFileContentBlocks([
        file(Buffer.from(incidentCsv(4000)), 'text/csv', 'workouts.csv'),
      ])
      expect(r.attachmentContext).toContain('rows: 4000')
    })

    it('states the TRUE date range, so the incident answer is not expressible', async () => {
      const r = await buildFileContentBlocks([
        file(Buffer.from(incidentCsv(4000)), 'text/csv', 'workouts.csv'),
      ])
      // The file runs to 2026. A block that says so cannot yield "to Feb 2024".
      expect(r.attachmentContext).toMatch(/2026-/)
    })

    it('says the rows are absent and forbids computing totals from the sample', async () => {
      const r = await buildFileContentBlocks([
        file(Buffer.from(incidentCsv()), 'text/csv', 'workouts.csv'),
      ])
      expect(r.attachmentContext).toMatch(/NOT in this message/i)
      expect(r.attachmentContext).toMatch(/do not compute or state any total/i)
    })

    it('stays small regardless of file size', async () => {
      const r = await buildFileContentBlocks([
        file(Buffer.from(incidentCsv(50_000)), 'text/csv', 'huge.csv'),
      ])
      expect(r.attachmentContext.length).toBeLessThan(2000)
      expect(r.attachmentContext).toContain('rows: 50000')
    })

    it('carries a promoted file handle so the rows can be queried', async () => {
      const promoteArtifact = vi.fn().mockResolvedValue({
        fileId: 'wf_123',
        path: '/uploads/x.csv',
        status: 'ready' as const,
        segmentCount: 12,
        truncated: false,
      })
      const r = await buildFileContentBlocks(
        [file(Buffer.from(incidentCsv()), 'text/csv', 'workouts.csv')],
        undefined,
        undefined,
        promoteArtifact,
      )
      expect(promoteArtifact).toHaveBeenCalled()
      expect(r.attachmentContext).toContain('wf_123')
      expect(r.attachmentContext).toMatch(/query the file/i)
    })

    it('admits it cannot compute exact figures when no handle exists', async () => {
      const r = await buildFileContentBlocks([
        file(Buffer.from(incidentCsv()), 'text/csv', 'workouts.csv'),
      ])
      expect(r.attachmentContext).toMatch(/cannot compute exact figures/i)
    })

    // A spreadsheet cannot be exercised end to end here: fabricating a .xlsx
    // needs exceljs, which is core's dependency and would resolve only through
    // hoisting. The xlsx half is covered where the dependency is declared, in
    // packages/core/src/files/__tests__/parsers.test.ts (row fidelity past the
    // old 1,000-row cap) and tabular-profile.test.ts (the Markdown-table shape
    // the xlsx parser emits). Everything below is the CSV half of the lane.

    it('keeps a zero-padded account code as text rather than coercing it', async () => {
      const csv = ['account,amount', ...Array.from({ length: 3000 }, (_, i) => `00${i % 9},${i}.50`)].join('\n')
      const r = await buildFileContentBlocks([file(Buffer.from(csv), 'text/csv', 'ledger.csv')])
      expect(r.attachmentContext).toContain('account (text)')
    })

    it('reports an ambiguous date column as ambiguous instead of guessing', async () => {
      const csv = ['when,amount', ...Array.from({ length: 3000 }, (_, i) => `${(i % 12) + 1}/${(i % 11) + 1}/24,${i}`)].join('\n')
      const r = await buildFileContentBlocks([file(Buffer.from(csv), 'text/csv', 'ledger.csv')])
      expect(r.attachmentContext).toMatch(/ORDERING AMBIGUOUS/)
      expect(r.attachmentContext).toMatch(/confirm with the user/i)
    })
  })

  describe('large prose files keep the existing paths', () => {
    const prose = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(2000)

    it('truncates with a quantified notice when nothing else is wired', async () => {
      const r = await buildFileContentBlocks([
        file(Buffer.from(prose), 'text/plain', 'notes.txt'),
      ])
      expect(r.attachmentContext).toContain('TRUNCATED')
      expect(r.attachmentContext).toContain('20,000')
      expect(r.attachmentContext).not.toContain('kind="tabular"')
    })

    it('emits an artifact manifest when promotion is wired', async () => {
      const promoteArtifact = vi.fn().mockResolvedValue({
        fileId: 'wf_prose',
        path: '/uploads/notes.txt',
        status: 'ready' as const,
        segmentCount: 4,
        truncated: false,
      })
      const r = await buildFileContentBlocks(
        [file(Buffer.from(prose), 'text/plain', 'notes.txt')],
        undefined,
        undefined,
        promoteArtifact,
      )
      expect(r.attachmentContext).toContain('wf_prose')
      expect(r.attachmentContext).not.toContain('TRUNCATED')
    })
  })

  it('sends an image as a content block without dumping bytes into text', async () => {
    const r = await buildFileContentBlocks([
      file(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg', 'photo.jpg', 'c_1'),
    ])
    expect(r.contentBlocks).toHaveLength(1)
    expect(r.contentBlocks[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' })
    expect(r.attachmentContext).toContain('[image]')
  })
})
