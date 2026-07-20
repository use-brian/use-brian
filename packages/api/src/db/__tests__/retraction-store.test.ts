/**
 * Unit tests for the retraction / re-extraction DB adapters.
 * Component tag: [COMP:corrections/retraction-store].
 *
 * Mocks the pg pool/client. Verifies the `MemoryRetractionRepository` +
 * `EpisodeReExtractionRepository` ports: snapshot reads, the soft-retract
 * UPDATE, the transactional audit-then-delete purge envelope, the
 * retracted-match guard query, the per-table derivation snapshot, and
 * the re-extraction outbox enqueue.
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

import {
  createMemoryRetractionStore,
  createEpisodeReExtractionStore,
} from '../retraction-store.js'
import type { MemoryRetractionSnapshot } from '@use-brian/core'

const memoryRepo = createMemoryRetractionStore()
const episodeRepo = createEpisodeReExtractionStore()
const NOW = new Date('2026-05-18T12:00:00Z')

const snapshot: MemoryRetractionSnapshot = {
  id: 'mem-1',
  workspaceId: 'ws-1',
  retractedAt: null,
  validTo: null,
  sourceEpisodeId: null,
  semanticHash: null,
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

describe('[COMP:corrections/retraction-store] createMemoryRetractionStore', () => {
  it('readMemoryForRetraction maps a row to a snapshot', async () => {
    poolRows = [
      {
        id: 'mem-1',
        workspaceId: 'ws-1',
        retractedAt: null,
        validTo: null,
        sourceEpisodeId: 'ep-1',
        semanticHash: 'h-1',
        createdByUserId: 'u-1',
      },
    ]
    const snap = await memoryRepo.readMemoryForRetraction('ws-1', 'mem-1')
    expect(snap).toEqual({
      id: 'mem-1',
      workspaceId: 'ws-1',
      retractedAt: null,
      validTo: null,
      sourceEpisodeId: 'ep-1',
      semanticHash: 'h-1',
      createdByUserId: 'u-1',
    })
    expect(poolQueries[0].values).toEqual(['mem-1', 'ws-1'])
  })

  it('readMemoryForRetraction returns null when absent', async () => {
    poolRows = []
    expect(await memoryRepo.readMemoryForRetraction('ws-1', 'ghost')).toBeNull()
  })

  it('applySoftRetract stamps retracted_at + reason + valid_to', async () => {
    await memoryRepo.applySoftRetract({
      workspaceId: 'ws-1',
      memoryId: 'mem-1',
      retractedBy: 'u-1',
      reason: 'user correction',
      now: NOW,
    })
    const q = poolQueries[0]
    expect(q.text).toContain('UPDATE memories')
    expect(q.text).toContain('retracted_at')
    expect(q.text).toContain('COALESCE(valid_to, $3)')
    expect(q.values).toEqual(['mem-1', 'ws-1', NOW, 'user correction', 'u-1'])
  })

  it('applyHardPurge audits then deletes inside one transaction', async () => {
    await memoryRepo.applyHardPurge({
      workspaceId: 'ws-1',
      memoryId: 'mem-1',
      actorUserId: 'u-1',
      reason: 'gdpr erasure',
      snapshot,
      now: NOW,
    })
    const texts = clientQueries.map((q) => q.text)
    expect(texts[0]).toBe('BEGIN')
    const auditIdx = texts.findIndex((t) => t.includes('INSERT INTO correction_audit'))
    const deleteIdx = texts.findIndex((t) => t.includes('DELETE FROM memories'))
    expect(auditIdx).toBeGreaterThan(0)
    // The existence record must be written before the row vanishes.
    expect(deleteIdx).toBeGreaterThan(auditIdx)
    expect(texts[texts.length - 1]).toBe('COMMIT')
    expect(fakeClient.release).toHaveBeenCalledOnce()
  })

  it('applyHardPurge ROLLBACKs and rethrows when the delete fails', async () => {
    fakeClient.query.mockImplementation(async (text: string, values?: unknown[]) => {
      clientQueries.push({ text, values })
      if (text.includes('DELETE FROM memories')) throw new Error('delete failed')
      return { rows: [], rowCount: 1 }
    })
    await expect(
      memoryRepo.applyHardPurge({
        workspaceId: 'ws-1',
        memoryId: 'mem-1',
        actorUserId: 'u-1',
        reason: 'x',
        snapshot,
        now: NOW,
      }),
    ).rejects.toThrow('delete failed')
    expect(clientQueries.map((q) => q.text)).toContain('ROLLBACK')
    expect(fakeClient.release).toHaveBeenCalledOnce()
  })

  it('findRetractedMatch filters on retracted_at IS NOT NULL', async () => {
    poolRows = [
      {
        id: 'mem-r',
        workspaceId: 'ws-1',
        retractedAt: NOW,
        validTo: NOW,
        sourceEpisodeId: 'ep-1',
        semanticHash: 'h-1',
        createdByUserId: 'u-1',
      },
    ]
    const match = await memoryRepo.findRetractedMatch({
      workspaceId: 'ws-1',
      sourceEpisodeId: 'ep-1',
      semanticHash: 'h-1',
    })
    expect(match!.id).toBe('mem-r')
    expect(poolQueries[0].text).toContain('retracted_at IS NOT NULL')
    expect(poolQueries[0].values).toEqual(['ws-1', 'ep-1', 'h-1'])
  })
})

describe('[COMP:corrections/retraction-store] createEpisodeReExtractionStore', () => {
  it('readEpisodeForReExtraction returns id + workspaceId', async () => {
    poolRows = [{ id: 'ep-1', workspaceId: 'ws-1' }]
    expect(await episodeRepo.readEpisodeForReExtraction('ws-1', 'ep-1')).toEqual({
      id: 'ep-1',
      workspaceId: 'ws-1',
    })
  })

  it('snapshotDerivations gathers live rows across the four derived tables', async () => {
    fakePool.query.mockImplementation(async (text: string, values?: unknown[]) => {
      poolQueries.push({ text, values })
      if (text.includes('FROM memories')) {
        return { rows: [{ rowId: 'm-1', validTo: null }], rowCount: 1 }
      }
      if (text.includes('FROM tasks')) {
        return { rows: [{ rowId: 't-1', validTo: null }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const derivations = await episodeRepo.snapshotDerivations('ws-1', 'ep-1')
    expect(derivations).toEqual([
      { primitive: 'memory', rowId: 'm-1', validTo: null },
      { primitive: 'task', rowId: 't-1', validTo: null },
    ])
    expect(poolQueries.every((q) => q.text.includes('valid_to IS NULL'))).toBe(true)
  })

  it('supersedeDerivations supersedes each derivation and audits the count', async () => {
    const result = await episodeRepo.supersedeDerivations({
      workspaceId: 'ws-1',
      episodeId: 'ep-1',
      derivations: [
        { primitive: 'memory', rowId: 'm-1', validTo: null },
        { primitive: 'task', rowId: 't-1', validTo: null },
      ],
      operatorUserId: 'op-1',
      ticketReference: 'TICK-9',
      reason: 'systematic mis-extraction',
      now: NOW,
    })
    // fakeClient returns rowCount 1 per UPDATE → two rows superseded.
    expect(result.supersededCount).toBe(2)
    const texts = clientQueries.map((q) => q.text)
    expect(texts.filter((t) => t.startsWith('UPDATE'))).toHaveLength(2)
    expect(texts.some((t) => t.includes('INSERT INTO correction_audit'))).toBe(true)
    expect(texts[texts.length - 1]).toBe('COMMIT')
  })

  it('triggerExtraction enqueues a re_extract outbox job with a fresh content hash', async () => {
    await episodeRepo.triggerExtraction({
      workspaceId: 'ws-1',
      episodeId: 'ep-1',
      operatorUserId: 'op-1',
    })
    const q = poolQueries[0]
    expect(q.text).toContain('INSERT INTO extraction_outbox')
    expect(q.values?.[0]).toBe('ws-1')
    expect(q.values?.[1]).toBe('ep-1')
    expect(q.values?.[2]).toBe('re_extract')
    expect(String(q.values?.[3])).toMatch(/^re_extract:/)
  })
})
