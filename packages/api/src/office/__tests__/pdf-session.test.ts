import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createFlatPdfFixture } from '../../../../core/src/office/__tests__/fixtures/pdf/index.js'
import { createPdfSessionService } from '../pdf-session-service.js'

const userId = randomUUID()
const workspaceId = randomUUID()
const originalFileId = randomUUID()

function fixture() {
  const files = new Map<string, { bytes: Uint8Array; file: { id: string; path: string; storageUri: string; mime: string; sha256: string } }>()
  let row: Record<string, unknown> | null = null
  let live: Record<string, unknown> | null = null
  const writes: string[] = []
  const deletes: string[] = []
  const assets = {
    async write(input: { path: string; bytes: Uint8Array; mime: string }) {
      const id = randomUUID()
      writes.push(input.path)
      const file = { id, path: input.path, storageUri: `gcs://fictional/${workspaceId}/${id}`, mime: input.mime, sha256: '0'.repeat(64) }
      files.set(id, { bytes: input.bytes, file })
      return file
    },
    async read(input: { fileId: string }) { return files.get(input.fileId) ?? null },
    async delete(input: { fileId: string }) { deletes.push(input.fileId); files.delete(input.fileId) },
    async saveDurable() { return { id: randomUUID() } },
  }
  const sessions = {
    async get(_userId: string, artifactId: string) { return row?.id === artifactId ? row : null },
    async findByIdempotency() { return row },
    async create(input: { artifactId: string; workspaceId: string; title: string; snapshot: unknown; snapshotFileId: string; sourceFileId: string }) {
      row = { id: input.artifactId, workspaceId: input.workspaceId, ownerUserId: userId, title: input.title,
        sensitivity: 'internal', compartments: [], projectIds: [], headVersionId: randomUUID(), headVersion: 0,
        expiresAt: new Date(Date.now() + 86_400_000), sourceFileId: input.sourceFileId, snapshotFileId: input.snapshotFileId }
      live = { snapshot: input.snapshot, seq: 1, baseVersion: 0, canonicalHash: '0'.repeat(64) }
      return row
    },
    async listAssets() { return [] }, async trackAsset() { return true }, async untrackAsset() {}, async elevateScope() { return true },
  }
  const service = createPdfSessionService({
    assets: assets as never,
    sessions: sessions as never,
    live: { async get() { return live }, async appendCommand() { return null } } as never,
    async assertWorkspaceMember() { return true },
    async resolveSource({ source }) {
      if (source.id !== originalFileId) return null
      return { bytes: await createFlatPdfFixture(), mime: 'application/pdf', fileName: 'fictional-form.pdf', sensitivity: 'internal' as const, compartments: [], projectIds: [] }
    },
  })
  return { service, writes, deletes, files }
}

describe('[COMP:api/office-pdf-sessions] PDF session service', () => {
  it('copies an accessible source, prepares version zero, and reuses the owner idempotency key', async () => {
    const f = fixture()
    const input = { userId, workspaceId, source: { kind: 'workspace_file' as const, id: originalFileId }, title: 'Fictional form', sensitivity: 'internal' as const, idempotencyKey: 'session-key-0001' }
    const first = await f.service.create(input)
    const second = await f.service.create(input)
    expect(second.artifactId).toBe(first.artifactId)
    expect(first.editorUrl).toBe(`/w/${workspaceId}/office/${first.artifactId}`)
    expect(f.writes).toEqual([
      `/office/sessions/${first.artifactId}/source/source.pdf`,
      `/office/sessions/${first.artifactId}/snapshot/version-0.json`,
    ])
    expect(f.deletes).toEqual([])
    expect([...f.files.keys()]).not.toContain(originalFileId)
  })

  it('fails malformed admission before writing any session-owned byte', async () => {
    const f = fixture()
    const resolver = vi.fn(async () => ({ bytes: new TextEncoder().encode('not a pdf'), mime: 'application/pdf', fileName: 'fictional.pdf', sensitivity: 'internal' as const, compartments: [], projectIds: [] }))
    const write = vi.fn()
    const service = createPdfSessionService({
      assets: { write, read: vi.fn(), delete: vi.fn(), saveDurable: vi.fn() } as never,
      sessions: { findByIdempotency: vi.fn(async () => null) } as never,
      live: {} as never,
      assertWorkspaceMember: async () => true,
      resolveSource: resolver,
    })
    await expect(service.create({ userId, workspaceId, source: { kind: 'workspace_file', id: originalFileId }, title: 'Fictional', sensitivity: 'internal', idempotencyKey: 'session-key-0002' }))
      .rejects.toMatchObject({ code: 'pdf_malformed' })
    expect(write).not.toHaveBeenCalled()
  })
})
