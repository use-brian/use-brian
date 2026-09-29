import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createFictionalSignaturePng, createFlatPdfFixture, createSupportedPdfFixture } from '../../../../core/src/office/__tests__/fixtures/pdf/index.js'
import { PDF_EDITING_SESSION_RUNTIME, canBootPdfEditingSession, createPdfSessionService } from '../pdf-session-service.js'

const userId = randomUUID()
const workspaceId = randomUUID()
const originalFileId = randomUUID()
const signatureAttachmentId = randomUUID()

function fixture(options: { supported?: boolean; signature?: boolean } = {}) {
  const files = new Map<string, { bytes: Uint8Array; file: { id: string; path: string; storageUri: string; mime: string; sha256: string } }>()
  let row: Record<string, unknown> | null = null
  let live: Record<string, unknown> | null = null
  const tracked: Array<{ fileId: string; role: string; contentSha256: string }> = []
  const writes: string[] = []
  const deletes: string[] = []
  const signatureCommits: unknown[] = []
  const assets = {
    async write(input: { path: string; bytes: Uint8Array; mime: string }) {
      const id = randomUUID()
      writes.push(input.path)
      const file = { id, path: input.path, storageUri: `gcs://fictional/${workspaceId}/${id}`, mime: input.mime, sha256: createHash('sha256').update(input.bytes).digest('hex') }
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
    async create(input: { artifactId: string; workspaceId: string; title: string; snapshot: unknown; snapshotFileId: string; sourceFileId: string; sourceSha256: string; signatureFileId?: string; signatureSha256?: string }) {
      row = { id: input.artifactId, workspaceId: input.workspaceId, ownerUserId: userId, title: input.title,
        sensitivity: 'internal', compartments: [], projectIds: [], headVersionId: randomUUID(), headVersion: 0,
        expiresAt: new Date(Date.now() + 86_400_000), sourceFileId: input.sourceFileId, snapshotFileId: input.snapshotFileId }
      live = { snapshot: input.snapshot, seq: 1, baseVersion: 0, canonicalHash: '0'.repeat(64) }
      tracked.push({ fileId: input.sourceFileId, role: 'source', contentSha256: input.sourceSha256 })
      tracked.push({ fileId: input.snapshotFileId, role: 'snapshot', contentSha256: files.get(input.snapshotFileId)!.file.sha256 })
      if (input.signatureFileId && input.signatureSha256) tracked.push({ fileId: input.signatureFileId, role: 'signature', contentSha256: input.signatureSha256 })
      return row
    },
    async listAssets() { return tracked },
    async trackAsset(input: { fileId: string; role: string; contentSha256: string }) { tracked.push(input); return true },
    async untrackAsset(_userId: string, _artifactId: string, fileId: string) { const index = tracked.findIndex((asset) => asset.fileId === fileId); if (index >= 0) tracked.splice(index, 1) },
    async elevateScope() { return true },
    async commitSignaturePlacement(input: { snapshot: unknown; expectedVersion: number }) {
      signatureCommits.push(input)
      if (!row || !live || row.headVersion !== input.expectedVersion) return null
      row = { ...row, headVersion: input.expectedVersion + 1 }
      live = { ...live, snapshot: input.snapshot, baseVersion: input.expectedVersion + 1, seq: Number(live.seq) + 1 }
      return { version: input.expectedVersion + 1 }
    },
    async commitRevision(input: { snapshot: unknown; expectedVersion: number }) {
      if (!row || !live || row.headVersion !== input.expectedVersion) return null
      row = { ...row, headVersion: input.expectedVersion + 1 }
      live = { ...live, snapshot: input.snapshot, baseVersion: input.expectedVersion + 1, seq: Number(live.seq) + 1 }
      return { version: input.expectedVersion + 1 }
    },
  }
  const service = createPdfSessionService({
    assets: assets as never,
    sessions: sessions as never,
    live: { async get() { return live }, async appendCommand() { return null } } as never,
    async assertWorkspaceMember() { return true },
    async resolveSource({ source }) {
      if (source.id === originalFileId) return { bytes: options.supported ? await createSupportedPdfFixture() : await createFlatPdfFixture(), mime: 'application/pdf', fileName: 'fictional-form.pdf', sensitivity: 'internal' as const, compartments: [], projectIds: [] }
      if (options.signature && source.id === signatureAttachmentId) return { bytes: await createFictionalSignaturePng(), mime: 'image/png', fileName: 'fictional-signature.png', sensitivity: 'confidential' as const, compartments: [], projectIds: [] }
      return null
    },
  })
  return { service, writes, deletes, files, signatureCommits }
}

describe('[COMP:api/office-pdf-sessions] PDF session service', () => {
  it('boots only with the complete same-build capability inventory', () => {
    expect(canBootPdfEditingSession()).toBe(true)
    expect(Object.values(PDF_EDITING_SESSION_RUNTIME).every(Boolean)).toBe(true)
  })

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

  it('[COMP:office/pdf-tools] previews, commits, and idempotently replays one exact approved signature', async () => {
    const f = fixture({ supported: true, signature: true })
    const ready = await f.service.create({
      userId, workspaceId,
      source: { kind: 'file_cache', id: originalFileId, expectedSessionId: randomUUID() },
      signatureSource: { kind: 'file_cache', id: signatureAttachmentId, expectedSessionId: randomUUID() },
      title: 'Fictional agreement', sensitivity: 'internal', idempotencyKey: 'signature-session-1',
    })
    expect(ready.targets.length).toBeGreaterThan(0)
    expect(ready.signatureResourceId).toBeDefined()
    const target = ready.targets[0]!
    const input = {
      userId, assistantId: randomUUID(), approverUserId: userId, approvalId: randomUUID(),
      artifactId: ready.artifactId, targetId: target.targetId,
      signatureResourceId: ready.signatureResourceId!, expectedSourceHash: ready.sourceHash,
      expectedVersion: ready.version, idempotencyKey: 'place-signature-1',
    }
    const described = await f.service.describeSignature(input)
    expect(described).toMatchObject({ title: 'Fictional agreement', fileName: 'fictional-form.pdf', pageNumber: target.pageNumber, rect: target.rect, version: 0 })
    const preview = await f.service.previewSignature(input)
    expect(preview?.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    await expect(f.service.placeSignature(input)).resolves.toEqual({ artifactId: ready.artifactId, version: 1 })
    await expect(f.service.placeSignature(input)).resolves.toEqual({ artifactId: ready.artifactId, version: 1 })
    expect(f.signatureCommits).toHaveLength(1)
  }, 30_000)

  it('[COMP:office/pdf-tools] makes owner, source, version, target, and resource drift stale without mutation', async () => {
    const f = fixture({ supported: true, signature: true })
    const ready = await f.service.create({
      userId, workspaceId,
      source: { kind: 'file_cache', id: originalFileId },
      signatureSource: { kind: 'file_cache', id: signatureAttachmentId },
      title: 'Fictional agreement', sensitivity: 'internal', idempotencyKey: 'signature-session-2',
    })
    const base = {
      userId, assistantId: randomUUID(), approverUserId: userId, approvalId: randomUUID(), artifactId: ready.artifactId,
      targetId: ready.targets[0]!.targetId, signatureResourceId: ready.signatureResourceId!,
      expectedSourceHash: ready.sourceHash, expectedVersion: 0, idempotencyKey: 'place-signature-drift',
    }
    for (const changed of [
      { approverUserId: randomUUID() },
      { expectedSourceHash: 'f'.repeat(64) },
      { expectedVersion: 1 },
      { targetId: randomUUID() },
      { signatureResourceId: randomUUID() },
    ]) {
      await expect(f.service.placeSignature({ ...base, ...changed })).resolves.toBe('pdf_signature_approval_stale')
    }
    expect(f.signatureCommits).toHaveLength(0)
  }, 30_000)
})
