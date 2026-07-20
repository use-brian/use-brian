/**
 * Unit tests for the soft-delete DB adapter.
 * Component tag: [COMP:corrections/soft-delete-store].
 *
 * Mocks the pg pool/client. Verifies the `SoftDeleteRepository` port:
 * snapshot reads (incl. the episode NULL-temporal projection), the
 * transactional soft-delete + audit envelope, the append-only episode
 * rejection, and the audit-then-delete hard-purge envelope.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const poolQueries: { text: string; values?: unknown[] }[] = []
const clientQueries: { text: string; values?: unknown[] }[] = []
let poolRows: Record<string, unknown>[] = []

const fakeClient = {
  query: vi.fn(),
  release: vi.fn(),
}
const fakePool = {
  query: vi.fn(),
  connect: vi.fn(async () => fakeClient),
}

vi.mock('../client.js', () => ({
  getPool: () => fakePool,
  query: (text: string, values?: unknown[]) => fakePool.query(text, values),
}))

import { createSoftDeleteStore } from '../soft-delete-store.js'
import type { RowSnapshot } from '@use-brian/core'

const store = createSoftDeleteStore()
const NOW = new Date('2026-05-18T12:00:00Z')

const fileSnapshot: RowSnapshot = {
  primitive: 'workspace_file',
  rowId: 'f-1',
  workspaceId: 'ws-1',
  validTo: null,
  retractedAt: null,
  createdByUserId: 'u-1',
}

beforeEach(() => {
  poolQueries.length = 0
  clientQueries.length = 0
  poolRows = []
  fakeClient.query.mockReset()
  fakeClient.query.mockImplementation(async (text: string, values?: unknown[]) => {
    clientQueries.push({ text, values })
    return { rows: [], rowCount: 1 }
  })
  fakeClient.release.mockClear()
  fakePool.query.mockReset()
  fakePool.query.mockImplementation(async (text: string, values?: unknown[]) => {
    poolQueries.push({ text, values })
    return { rows: poolRows, rowCount: poolRows.length }
  })
  fakePool.connect.mockClear()
})

describe('[COMP:corrections/soft-delete-store] reads', () => {
  it('readForSoftDelete maps a row to a snapshot', async () => {
    poolRows = [
      { rowId: 'e-1', workspaceId: 'ws-1', validTo: null, retractedAt: null, createdByUserId: 'u-1' },
    ]
    const snap = await store.readForSoftDelete('entity', 'ws-1', 'e-1')
    expect(snap).toEqual({
      primitive: 'entity',
      rowId: 'e-1',
      workspaceId: 'ws-1',
      validTo: null,
      retractedAt: null,
      createdByUserId: 'u-1',
    })
    expect(poolQueries[0].text).toContain('FROM entities')
    expect(poolQueries[0].values).toEqual(['e-1', 'ws-1'])
  })

  it('readForSoftDelete projects episode temporal columns as NULL', async () => {
    poolRows = [
      { rowId: 'ep-1', workspaceId: 'ws-1', validTo: null, retractedAt: null, createdByUserId: 'u-1' },
    ]
    await store.readForSoftDelete('episode', 'ws-1', 'ep-1')
    expect(poolQueries[0].text).toContain('NULL::timestamptz AS "validTo"')
    expect(poolQueries[0].text).toContain('FROM episodes')
  })

  it('readForAuthorshipDelete uses the same system-level read', async () => {
    poolRows = [
      { rowId: 't-1', workspaceId: 'ws-1', validTo: null, retractedAt: null, createdByUserId: 'u-1' },
    ]
    const snap = await store.readForAuthorshipDelete('task', 'ws-1', 't-1')
    expect(snap!.rowId).toBe('t-1')
    expect(poolQueries[0].text).toContain('FROM tasks')
  })

  it('readForSoftDelete returns null when the row is absent', async () => {
    poolRows = []
    expect(await store.readForSoftDelete('entity', 'ws-1', 'ghost')).toBeNull()
  })
})

describe('[COMP:corrections/soft-delete-store] applySoftDelete', () => {
  it('sets valid_to and writes the audit row in one transaction', async () => {
    await store.applySoftDelete({
      primitive: 'task',
      workspaceId: 'ws-1',
      rowId: 't-1',
      actorUserId: 'u-1',
      reason: 'no longer relevant',
      now: NOW,
    })
    const texts = clientQueries.map((q) => q.text)
    expect(texts[0]).toBe('BEGIN')
    expect(texts.find((t) => t.startsWith('UPDATE'))).toContain('UPDATE tasks SET valid_to')
    expect(texts.some((t) => t.includes('INSERT INTO correction_audit'))).toBe(true)
    expect(texts[texts.length - 1]).toBe('COMMIT')
  })

  it('rejects episode — append-only, not soft-deletable', async () => {
    await expect(
      store.applySoftDelete({
        primitive: 'episode',
        workspaceId: 'ws-1',
        rowId: 'ep-1',
        actorUserId: 'u-1',
        reason: 'x',
        now: NOW,
      }),
    ).rejects.toThrow(/append-only/)
  })
})

describe('[COMP:corrections/soft-delete-store] applyHardPurge', () => {
  it('snapshots into correction_audit before deleting the row', async () => {
    await store.applyHardPurge({
      primitive: 'workspace_file',
      workspaceId: 'ws-1',
      rowId: 'f-1',
      actorUserId: 'u-1',
      reason: 'gdpr erasure',
      ticketReference: 'TICK-1',
      snapshot: fileSnapshot,
      now: NOW,
    })
    const texts = clientQueries.map((q) => q.text)
    const auditIdx = texts.findIndex((t) => t.includes('INSERT INTO correction_audit'))
    const deleteIdx = texts.findIndex((t) => t.includes('DELETE FROM workspace_files'))
    expect(auditIdx).toBeGreaterThan(0)
    expect(deleteIdx).toBeGreaterThan(auditIdx)
    expect(texts[texts.length - 1]).toBe('COMMIT')
  })

  it('ROLLBACKs and rethrows when the delete fails', async () => {
    fakeClient.query.mockImplementation(async (text: string, values?: unknown[]) => {
      clientQueries.push({ text, values })
      if (text.includes('DELETE FROM')) throw new Error('delete boom')
      return { rows: [], rowCount: 1 }
    })
    await expect(
      store.applyHardPurge({
        primitive: 'entity',
        workspaceId: 'ws-1',
        rowId: 'e-1',
        actorUserId: 'u-1',
        reason: 'x',
        ticketReference: null,
        snapshot: { ...fileSnapshot, primitive: 'entity', rowId: 'e-1' },
        now: NOW,
      }),
    ).rejects.toThrow('delete boom')
    expect(clientQueries.map((q) => q.text)).toContain('ROLLBACK')
    expect(fakeClient.release).toHaveBeenCalledOnce()
  })
})
