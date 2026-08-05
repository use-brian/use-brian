import { describe, expect, it } from 'vitest'
import { createOfficeArtifactStore, type OfficeDbQuery } from '../office-artifacts.js'
import { createOfficeCommentStore } from '../office-comments.js'
import { createOfficeGenerationStore } from '../office-generation.js'
import { createOfficeTemplateStore } from '../office-templates.js'
import { APP_LEVEL_ASSISTANT_ID } from '@use-brian/shared'

type Call = { userId: string; sql: string; params: unknown[] }

function fakeDb(rowsByMarker: Record<string, unknown[]> = {}) {
  const calls: Call[] = []
  const query: OfficeDbQuery = async (userId, sql, params) => {
    calls.push({ userId, sql, params })
    const marker = Object.keys(rowsByMarker).find((candidate) => sql.includes(candidate))
    return { rows: (marker ? rowsByMarker[marker] : []) as never[] }
  }
  return { calls, query }
}

describe('[COMP:api/office-store] Office stores', () => {
  it('creates a workspace/actor-scoped artifact shell', async () => {
    const db = fakeDb({ 'INSERT INTO office_artifacts': [{ id: 'a1' }] })
    const row = await createOfficeArtifactStore(db.query).createShell({ userId: 'u1', workspaceId: 'w1', family: 'document', title: 'Doc', templateVersionId: null, capabilityVersion: 1, sensitivity: 'internal' })
    expect(row).toEqual({ id: 'a1' })
    expect(db.calls[0]).toMatchObject({ userId: 'u1', params: ['w1', 'document', 'Doc', 'u1', null, 1, 'internal', [], [], 'artifact'] })
  })

  it('never persists the app-level policy sentinel as an assistant foreign key', async () => {
    const db = fakeDb({ 'INSERT INTO office_generation_jobs': [{ id: 'j1' }] })
    await createOfficeGenerationStore(db.query).create({
      userId: 'u1', workspaceId: 'w1', artifactId: 'a1', assistantId: APP_LEVEL_ASSISTANT_ID,
      jobKind: 'create', brief: { assistantId: APP_LEVEL_ASSISTANT_ID }, authorityProjection: {},
      idempotencyKey: 'request-12345678',
    })
    expect(db.calls[0]?.params[3]).toBeNull()
    expect(db.calls[0]?.params[5]).toBe(JSON.stringify({ assistantId: APP_LEVEL_ASSISTANT_ID }))
  })

  it('qualifies the leased job projection against the update target', async () => {
    const db = fakeDb({ 'RETURNING j.id': [{ id: 'j1' }] })
    const claimed = await createOfficeGenerationStore(db.query).claim({
      userId: 'u1',
      leaseToken: '30000000-0000-4000-8000-000000000001',
      leaseMs: 120_000,
      jobKinds: ['template_compile'],
    })
    expect(claimed).toEqual({ id: 'j1' })
    expect(db.calls[0]?.sql).toContain('RETURNING j.id')
    expect(db.calls[0]?.sql).toContain('j.created_at AS "createdAt"')
  })

  it('deletes only a still-empty shell with no generation job', async () => {
    const db = fakeDb({ 'DELETE FROM office_artifacts': [{ id: 'a1' }] })
    await expect(createOfficeArtifactStore(db.query).deleteEmptyShell('u1', 'a1')).resolves.toBe(true)
    expect(db.calls[0]?.sql).toContain('head_version = 0')
    expect(db.calls[0]?.sql).toContain('NOT EXISTS')
  })

  it('projects bigint artifact heads as JSON-safe numbers', async () => {
    const db = fakeDb({
      'WHERE workspace_id = $1': [],
      'FROM office_artifacts WHERE id = $1': [],
      'INSERT INTO office_artifacts': [{ id: 'a1' }],
    })
    const store = createOfficeArtifactStore(db.query)
    await store.list('u1', 'w1', 'active')
    await store.get('u1', 'a1')
    await store.createShell({ userId: 'u1', workspaceId: 'w1', family: 'document', title: 'Doc', templateVersionId: null, capabilityVersion: 1, sensitivity: 'internal' })
    expect(db.calls).toHaveLength(3)
    for (const call of db.calls) expect(call.sql).toContain('head_version::int AS "headVersion"')
  })

  it('commits a version with one locked CAS statement and returns conflict as null', async () => {
    const success = fakeDb({ 'WITH current_head': [{ id: 'v2', version: 2 }] })
    const store = createOfficeArtifactStore(success.query)
    const committed = await store.commitVersion({ userId: 'u1', artifactId: 'a1', expectedVersion: 1, snapshotFileId: 'f1', snapshotHash: 'a'.repeat(64), operationClock: new Uint8Array([1]), schemaVersion: 1, capabilityVersion: 1, origin: 'manual', authorType: 'user', authorUserId: 'u1', summary: 'Edit' })
    expect(committed).toEqual({ id: 'v2', version: 2 })
    expect(success.calls[0].sql).toContain('FOR UPDATE')
    const conflict = fakeDb()
    expect(await createOfficeArtifactStore(conflict.query).commitVersion({ userId: 'u1', artifactId: 'a1', expectedVersion: 0, snapshotFileId: 'f1', snapshotHash: 'b'.repeat(64), operationClock: new Uint8Array(), schemaVersion: 1, capabilityVersion: 1, origin: 'manual', authorType: 'user', summary: 'Stale' })).toBeNull()
  })

  it('creates immutable template versions and declarative resources', async () => {
    const db = fakeDb({ 'WITH next': [{ id: 'tv1', version: 1 }], 'INSERT INTO office_resources': [{ id: 'r1' }] })
    const store = createOfficeTemplateStore(db.query)
    expect(await store.addVersion({ userId: 'u1', templateId: 't1', workspaceId: 'w1', bundleFileId: 'f1', bundleHash: 'c'.repeat(64), capabilityVersion: 1, locales: ['en-US'], tags: [], whenToUse: ['reports'], whenNotToUse: ['slides'], exampleRequests: ['make a report'], fieldSchema: {}, admissionReceipt: {}, provenance: {}, status: 'admitted' })).toEqual({ id: 'tv1', version: 1 })
    expect(await store.addResource({ userId: 'u1', workspaceId: 'w1', kind: 'font', name: 'Brand', fileId: 'f2', hash: 'd'.repeat(64), mime: 'font/otf', licence: {}, embeddingRights: 'allowed', sensitivity: 'internal' })).toEqual({ id: 'r1' })
  })

  it('links a scratch template to its draft artifact and only deletes an empty draft', async () => {
    const db = fakeDb({ 'INSERT INTO office_templates\n': [{ id: 't1' }], 'DELETE FROM office_templates': [{ id: 't1' }] })
    const store = createOfficeTemplateStore(db.query)
    await expect(store.createDraft({ userId: 'u1', workspaceId: 'w1', family: 'document', name: 'Memo', description: 'Internal memo', sensitivity: 'internal', draftArtifactId: 'a1' })).resolves.toEqual({ id: 't1' })
    expect(db.calls[0]?.params).toEqual(['w1', 'document', 'Memo', 'Internal memo', 'u1', 'internal', 'a1'])
    await expect(store.deleteEmptyDraft('u1', 't1')).resolves.toBe(true)
    expect(db.calls[1]?.sql).toContain('current_version_id IS NULL')
    expect(db.calls[1]?.sql).toContain('NOT EXISTS')
  })

  it('stores one thread plus idempotent explicit-Brian trigger message', async () => {
    const db = fakeDb({ 'WITH thread': [{ threadId: 't1', messageId: 'm1' }] })
    const receipt = await createOfficeCommentStore(db.query).createThread({ userId: 'u1', workspaceId: 'w1', artifactId: 'a1', artifactVersionId: 'v1', anchor: { kind: 'object', targetIds: ['o1'] }, body: '@Brian tighten this', brianTriggerKey: 'event-1' })
    expect(receipt).toEqual({ threadId: 't1', messageId: 'm1' })
    expect(db.calls[0].sql).toContain("CASE WHEN $11 IS NULL THEN NULL ELSE 'queued' END")
  })
})
