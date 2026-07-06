/**
 * Unit tests for the entity-merge DB adapter.
 * Component tag: [COMP:corrections/entity-merge-store].
 *
 * Mocks the pg pool/client. Verifies the `EntityMergeRepository` +
 * `SpecializationCascadeRepository` ports: snapshot reads, the
 * transactional applyMerge / applyUndoMerge envelopes, the
 * undone-merge filter on findMergeById, and the cascade table allowlist.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const poolQueries: { text: string; values?: unknown[] }[] = []
const clientQueries: { text: string; values?: unknown[] }[] = []
let poolRows: Record<string, unknown>[] = []
let poolRowCount = 0
let clientInsertRow: Record<string, unknown> | null = null

const fakeClient = {
  query: vi.fn(async (text: string, values?: unknown[]) => {
    clientQueries.push({ text, values })
    if (text.trim().startsWith('INSERT INTO entity_merges')) {
      return { rows: clientInsertRow ? [clientInsertRow] : [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }),
  release: vi.fn(),
}

const fakePool = {
  query: vi.fn(async (text: string, values?: unknown[]) => {
    poolQueries.push({ text, values })
    return { rows: poolRows, rowCount: poolRowCount }
  }),
  connect: vi.fn(async () => fakeClient),
}

vi.mock('../client.js', () => ({
  getPool: () => fakePool,
  query: (text: string, values?: unknown[]) => fakePool.query(text, values),
}))

import {
  createEntityMergeStore,
  createSpecializationCascadeStore,
} from '../entity-merge-store.js'
import type { ApplyMergeInput, EntityMergeRecord } from '@sidanclaw/core'

const repo = createEntityMergeStore()
const cascade = createSpecializationCascadeStore()

const NOW = new Date('2026-05-15T12:00:00Z')

function mergeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm-1',
    workspaceId: 'ws-1',
    survivingId: 'e-survivor',
    mergedId: 'e-merged',
    mergedAt: NOW,
    mergedBy: 'u-1',
    reason: 'duplicate',
    mergedAttributesSnapshot: {
      entityId: 'e-merged',
      displayName: 'Acme Corp',
      attributes: { domain: 'acme.com' },
      tags: [],
      validTo: null,
      supersededBy: null,
      workspaceId: 'ws-1',
    },
    survivingAttributesPreMerge: {
      entityId: 'e-survivor',
      displayName: 'Acme',
      attributes: {},
      tags: [],
      validTo: null,
      supersededBy: null,
      workspaceId: 'ws-1',
    },
    mergedSpecializationPointer: null,
    cascadeApplied: false,
    reconciliationOverrides: null,
    ...over,
  }
}

beforeEach(() => {
  poolQueries.length = 0
  clientQueries.length = 0
  poolRows = []
  poolRowCount = 0
  clientInsertRow = null
  fakePool.query.mockClear()
  fakePool.connect.mockClear()
  fakeClient.query.mockClear()
  fakeClient.release.mockClear()
})

describe('[COMP:corrections/entity-merge-store] readEntityForMerge', () => {
  it('returns a snapshot scoped to the workspace, tags always empty', async () => {
    poolRows = [
      {
        id: 'e-1',
        displayName: 'Acme',
        attributes: { domain: 'acme.com' },
        validTo: null,
        supersededBy: null,
        workspaceId: 'ws-1',
      },
    ]
    const snap = await repo.readEntityForMerge('ws-1', 'e-1')
    expect(snap).not.toBeNull()
    expect(snap!.entityId).toBe('e-1')
    expect(snap!.tags).toEqual([])
    expect(snap!.attributes).toEqual({ domain: 'acme.com' })
    expect(poolQueries[0].values).toEqual(['e-1', 'ws-1'])
  })

  it('returns null when the entity is not in the workspace', async () => {
    poolRows = []
    expect(await repo.readEntityForMerge('ws-1', 'ghost')).toBeNull()
  })
})

describe('[COMP:corrections/entity-merge-store] applyMerge', () => {
  function input(over: Partial<ApplyMergeInput> = {}): ApplyMergeInput {
    return {
      workspaceId: 'ws-1',
      survivingId: 'e-survivor',
      mergedId: 'e-merged',
      mergedBy: 'u-1',
      reason: 'duplicate',
      reconciledAttributes: { domain: 'acme.com' },
      reconciledTags: [],
      mergedAttributesSnapshot: mergeRow().mergedAttributesSnapshot as never,
      survivingAttributesPreMerge: mergeRow().survivingAttributesPreMerge as never,
      mergedSpecializationPointer: null,
      cascadeApplied: false,
      reconciliationOverrides: null,
      now: NOW,
      ...over,
    }
  }

  it('supersedes the merged entity, rewrites survivor attributes, inserts the record', async () => {
    clientInsertRow = mergeRow()
    const record = await repo.applyMerge(input())
    expect(record.id).toBe('m-1')

    const texts = clientQueries.map((q) => q.text)
    expect(texts[0]).toBe('BEGIN')
    // Two-role model: no system_bypass GUC — runs on the system pool (owner).
    expect(texts.every((t) => !t.includes('system_bypass'))).toBe(true)
    // 1. supersede merged
    const supersede = clientQueries.find(
      (q) => q.text.includes('UPDATE entities') && q.text.includes('superseded_by = $3'),
    )
    expect(supersede!.values).toEqual(['e-merged', NOW, 'e-survivor', 'ws-1'])
    // 2. rewrite survivor attributes
    const rewrite = clientQueries.find(
      (q) => q.text.includes('UPDATE entities') && q.text.includes('attributes = $2::jsonb'),
    )
    expect(rewrite!.values?.[0]).toBe('e-survivor')
    expect(rewrite!.values?.[1]).toBe(JSON.stringify({ domain: 'acme.com' }))
    // 3. insert record
    expect(texts.some((t) => t.includes('INSERT INTO entity_merges'))).toBe(true)
    expect(texts[texts.length - 1]).toBe('COMMIT')
    expect(fakeClient.release).toHaveBeenCalledOnce()
  })

  it('ROLLBACKs and rethrows when a statement fails', async () => {
    clientInsertRow = null // INSERT returns no row → rowToMergeRecord throws on undefined
    fakeClient.query.mockImplementationOnce(async (text: string) => {
      clientQueries.push({ text })
      return { rows: [], rowCount: 0 }
    })
    // Force the INSERT to throw.
    fakeClient.query.mockImplementation(async (text: string, values?: unknown[]) => {
      clientQueries.push({ text, values })
      if (text.trim().startsWith('INSERT INTO entity_merges')) {
        throw new Error('insert failed')
      }
      return { rows: [], rowCount: 0 }
    })
    await expect(repo.applyMerge(input())).rejects.toThrow('insert failed')
    expect(clientQueries.map((q) => q.text)).toContain('ROLLBACK')
    expect(fakeClient.release).toHaveBeenCalledOnce()
  })
})

describe('[COMP:corrections/entity-merge-store] applyUndoMerge', () => {
  it('un-supersedes the merged entity, restores survivor, stamps undone', async () => {
    const record = mergeRow() as unknown as EntityMergeRecord
    await repo.applyUndoMerge({
      mergeRecord: record,
      actorUserId: 'u-2',
      reason: 'mistake',
      cascadeReversed: false,
      now: NOW,
    })
    const unSupersede = clientQueries.find(
      (q) => q.text.includes('UPDATE entities') && q.text.includes('valid_to      = NULL'),
    )
    expect(unSupersede!.values).toEqual(['e-merged', 'ws-1'])
    const stampUndone = clientQueries.find((q) => q.text.includes('UPDATE entity_merges'))
    expect(stampUndone!.values).toEqual(['m-1', NOW, 'u-2', 'mistake', false])
    expect(clientQueries.map((q) => q.text).pop()).toBe('COMMIT')
  })
})

describe('[COMP:corrections/entity-merge-store] findMergeById', () => {
  it('filters out already-undone merges (double-undo protection)', async () => {
    poolRows = []
    const found = await repo.findMergeById('ws-1', 'm-1')
    expect(found).toBeNull()
    expect(poolQueries[0].text).toContain('undone_at IS NULL')
  })

  it('returns the record when live', async () => {
    poolRows = [mergeRow()]
    const found = await repo.findMergeById('ws-1', 'm-1')
    expect(found!.id).toBe('m-1')
    expect(found!.mergedAttributesSnapshot.displayName).toBe('Acme Corp')
  })
})

describe('[COMP:corrections/entity-merge-store] isEntityActive', () => {
  it('is true only when valid_to and retracted_at are both null', async () => {
    poolRows = [{ validTo: null, retractedAt: null }]
    expect(await repo.isEntityActive('ws-1', 'e-1')).toBe(true)

    poolRows = [{ validTo: NOW, retractedAt: null }]
    expect(await repo.isEntityActive('ws-1', 'e-1')).toBe(false)

    poolRows = []
    expect(await repo.isEntityActive('ws-1', 'ghost')).toBe(false)
  })
})

describe('[COMP:corrections/entity-merge-store] specialization cascade', () => {
  it('CRM specialization cascade is a no-op post-unification (empty allowlist)', async () => {
    // Post CRM→entity unification there are no specialization rows to
    // cascade to; CASCADE_TABLES is empty, so every CRM sourceKind is
    // rejected by the same guard as an unknown table.
    await expect(
      cascade.applyCascade({
        sourceKind: 'companies',
        mergedSourceId: 'co-merged',
        survivorSourceId: 'co-survivor',
        now: NOW,
      }),
    ).rejects.toThrow(/unsupported sourceKind/)
    await expect(
      cascade.reverseCascade({ sourceKind: 'contacts', mergedSourceId: 'c-1' }),
    ).rejects.toThrow(/unsupported sourceKind/)
  })

  it('rejects a sourceKind outside the allowlist (SQL-injection guard)', async () => {
    await expect(
      cascade.applyCascade({
        sourceKind: 'entities; DROP TABLE entities',
        mergedSourceId: 'x',
        survivorSourceId: 'y',
        now: NOW,
      }),
    ).rejects.toThrow(/unsupported sourceKind/)
  })
})
