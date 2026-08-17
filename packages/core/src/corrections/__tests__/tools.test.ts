import { describe, it, expect } from 'vitest'
import { createCorrectionTools } from '../tools.js'
import type {
  ApplySoftRetractInput,
  MemoryRetractionRepository,
  MemoryRetractionSnapshot,
} from '../retraction.js'
import type {
  ApplySoftDeleteInput,
  RowSnapshot,
  SoftDeleteRepository,
} from '../soft-delete.js'
import type {
  ApplyRowReclassificationInput,
  RowSensitivitySnapshot,
  SensitivityReclassificationRepository,
} from '../sensitivity-reclassification.js'
import type { ToolContext } from '../../tools/types.js'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = 'user-1'
const ROW_ID = '11111111-1111-4111-8111-111111111111'

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: USER_ID,
    assistantId: 'asst-1',
    sessionId: 'sess-1',
    appId: 'Use Brian',
    channelType: 'web',
    channelId: 'web-1',
    workspaceId: WORKSPACE_ID,
    abortSignal: new AbortController().signal,
    clearance: 'internal',
    ...overrides,
  }
}

type Recorder = {
  softRetract: ApplySoftRetractInput[]
  softDelete: ApplySoftDeleteInput[]
  reclassify: ApplyRowReclassificationInput[]
}

function makeDeps(overrides?: {
  memorySnapshot?: MemoryRetractionSnapshot | null
  rowSnapshot?: RowSnapshot | null
  sensitivitySnapshot?: RowSensitivitySnapshot | null
  role?: 'owner' | 'admin' | 'member' | null
}): {
  deps: Parameters<typeof createCorrectionTools>[0]
  rec: Recorder
} {
  const rec: Recorder = { softRetract: [], softDelete: [], reclassify: [] }

  const role: 'owner' | 'admin' | 'member' | null =
    overrides && 'role' in overrides ? overrides.role ?? null : 'owner'

  const memorySnapshot: MemoryRetractionSnapshot | null =
    overrides && 'memorySnapshot' in overrides
      ? overrides.memorySnapshot ?? null
      : {
          id: ROW_ID,
          workspaceId: WORKSPACE_ID,
          retractedAt: null,
          validTo: null,
          sourceEpisodeId: null,
          semanticHash: null,
          createdByUserId: USER_ID,
        }

  const rowSnapshot: RowSnapshot | null =
    overrides && 'rowSnapshot' in overrides
      ? overrides.rowSnapshot ?? null
      : {
          primitive: 'entity' as const,
          rowId: ROW_ID,
          workspaceId: WORKSPACE_ID,
          validTo: null,
          retractedAt: null,
          createdByUserId: USER_ID,
        }

  const sensitivitySnapshot: RowSensitivitySnapshot | null =
    overrides && 'sensitivitySnapshot' in overrides
      ? overrides.sensitivitySnapshot ?? null
      : {
          primitive: 'entity' as const,
          rowId: ROW_ID,
          workspaceId: WORKSPACE_ID,
          sensitivity: 'confidential' as const,
          sourceEpisodeId: null,
          validTo: null,
        }

  const retraction: MemoryRetractionRepository = {
    async readMemoryForRetraction() {
      return memorySnapshot
    },
    async applySoftRetract(input) {
      rec.softRetract.push(input)
    },
    async applyHardPurge() {},
    async findRetractedMatch() {
      return null
    },
  }

  const softDelete: SoftDeleteRepository = {
    async readForSoftDelete() {
      return rowSnapshot
    },
    async readForAuthorshipDelete() {
      return rowSnapshot
    },
    async applySoftDelete(input) {
      rec.softDelete.push(input)
    },
    async applyHardPurge() {},
  }

  const reclassify: SensitivityReclassificationRepository = {
    async readRowForReclassification() {
      return sensitivitySnapshot
    },
    async applyRowReclassification(input) {
      rec.reclassify.push(input)
    },
    async findDerivedRows() {
      return []
    },
  }

  return {
    deps: {
      retraction,
      softDelete,
      reclassify,
      resolveWorkspaceRole: async () => role,
    },
    rec,
  }
}

function byName(tools: ReturnType<typeof createCorrectionTools>) {
  return {
    retractMemory: tools.find((t) => t.name === 'retractMemory')!,
    deleteBrainRow: tools.find((t) => t.name === 'deleteBrainRow')!,
    reclassifySensitivity: tools.find((t) => t.name === 'reclassifySensitivity')!,
  }
}

describe('[COMP:corrections/tools] createCorrectionTools', () => {
  it('returns the 3 correction tools, all flagged as non-read writes', () => {
    const { deps } = makeDeps()
    const tools = createCorrectionTools(deps)
    expect(tools.map((t) => t.name).sort()).toEqual([
      'deleteBrainRow',
      'reclassifySensitivity',
      'retractMemory',
    ])
    for (const t of tools) {
      expect(t.isReadOnly).toBe(false)
      expect(t.isConcurrencySafe).toBe(false)
    }
  })

  describe('retractMemory', () => {
    it('delegates to the retraction repo with the context workspace + actor', async () => {
      const { deps, rec } = makeDeps()
      const { retractMemory } = byName(createCorrectionTools(deps))

      const result = await retractMemory.execute(
        { memory_id: ROW_ID, reason: 'the brain stored a wrong title' },
        makeContext(),
      )

      expect(result.isError).toBeUndefined()
      expect(rec.softRetract).toHaveLength(1)
      expect(rec.softRetract[0]!).toMatchObject({
        workspaceId: WORKSPACE_ID,
        memoryId: ROW_ID,
        retractedBy: USER_ID,
        reason: 'the brain stored a wrong title',
      })
    })

    it('surfaces the orchestrator error when the memory is missing', async () => {
      const { deps } = makeDeps({ memorySnapshot: null })
      const { retractMemory } = byName(createCorrectionTools(deps))
      const result = await retractMemory.execute(
        { memory_id: ROW_ID, reason: 'x' },
        makeContext(),
      )
      expect(result.isError).toBe(true)
      // The miss ships the discovery pointer + supersession + the verdict,
      // not just the orchestrator's sentence.
      expect(String(result.data)).toContain(ROW_ID)
      expect(String(result.data)).toMatch(/searchBrain/)
      expect(String(result.data)).toMatch(/returned a NEW id/)
      expect(String(result.data)).toMatch(/Do NOT retry this exact id/)
    })

    it('errors without a workspace context', async () => {
      const { deps } = makeDeps()
      const { retractMemory } = byName(createCorrectionTools(deps))
      const result = await retractMemory.execute(
        { memory_id: ROW_ID, reason: 'x' },
        makeContext({ workspaceId: null }),
      )
      expect(result.isError).toBe(true)
      // The gate names the missing surface and the remedy, and rules out a retry.
      expect(String(result.data)).toMatch(/not bound to a workspace/)
      expect(String(result.data)).toMatch(/from a workspace chat/)
      expect(String(result.data)).toMatch(/do not retry/i)
    })

    it('rejects a non-uuid memory_id and an empty reason at the schema', () => {
      const { deps } = makeDeps()
      const { retractMemory } = byName(createCorrectionTools(deps))
      expect(retractMemory.inputSchema.safeParse({ memory_id: 'nope', reason: 'x' }).success).toBe(false)
      expect(retractMemory.inputSchema.safeParse({ memory_id: ROW_ID, reason: '' }).success).toBe(false)
    })
  })

  describe('deleteBrainRow', () => {
    it('soft-deletes a non-memory primitive', async () => {
      const { deps, rec } = makeDeps()
      const { deleteBrainRow } = byName(createCorrectionTools(deps))

      const result = await deleteBrainRow.execute(
        { primitive: 'entity', row_id: ROW_ID, reason: 'duplicate record' },
        makeContext(),
      )

      expect(result.isError).toBeUndefined()
      expect(rec.softDelete).toHaveLength(1)
      expect(rec.softDelete[0]!).toMatchObject({
        primitive: 'entity',
        workspaceId: WORKSPACE_ID,
        rowId: ROW_ID,
        actorUserId: USER_ID,
      })
    })

    it('rejects memory + workspace_file + episode at the schema (wrong correction path)', () => {
      const { deps } = makeDeps()
      const { deleteBrainRow } = byName(createCorrectionTools(deps))
      for (const primitive of ['memory', 'workspace_file', 'episode']) {
        expect(
          deleteBrainRow.inputSchema.safeParse({ primitive, row_id: ROW_ID, reason: 'x' }).success,
        ).toBe(false)
      }
    })
  })

  describe('reclassifySensitivity', () => {
    it('passes triggeredBy=per_row_operator so an operator may also downgrade', async () => {
      const { deps, rec } = makeDeps()
      const { reclassifySensitivity } = byName(createCorrectionTools(deps))

      // confidential -> internal is a downgrade; only per_row_operator allows it.
      const result = await reclassifySensitivity.execute(
        {
          primitive: 'entity',
          row_id: ROW_ID,
          new_sensitivity: 'internal',
          reason: 'not actually confidential',
        },
        makeContext(),
      )

      expect(result.isError).toBeUndefined()
      expect(rec.reclassify).toHaveLength(1)
      expect(rec.reclassify[0]!).toMatchObject({
        triggeredBy: 'per_row_operator',
        direction: 'downgrade',
        newSensitivity: 'internal',
      })
    })

    it('blocks a downgrade for a non-admin member (D.8 asymmetric rule)', async () => {
      const { deps, rec } = makeDeps({ role: 'member' })
      const { reclassifySensitivity } = byName(createCorrectionTools(deps))

      // confidential -> internal is a downgrade; a member may not.
      const result = await reclassifySensitivity.execute(
        {
          primitive: 'entity',
          row_id: ROW_ID,
          new_sensitivity: 'internal',
          reason: 'looks fine to me',
        },
        makeContext(),
      )

      expect(result.isError).toBe(true)
      expect(String(result.data)).toMatch(/restricted to workspace owners and admins/)
      expect(String(result.data)).toMatch(/Nothing was changed/)
      expect(String(result.data)).toMatch(/an admin has to make this change/)
      expect(rec.reclassify).toHaveLength(0)
    })

    it('lets a member raise a tier (the safe direction)', async () => {
      const { deps, rec } = makeDeps({
        role: 'member',
        sensitivitySnapshot: {
          primitive: 'entity',
          rowId: ROW_ID,
          workspaceId: WORKSPACE_ID,
          sensitivity: 'internal',
          sourceEpisodeId: null,
          validTo: null,
        },
      })
      const { reclassifySensitivity } = byName(createCorrectionTools(deps))

      const result = await reclassifySensitivity.execute(
        {
          primitive: 'entity',
          row_id: ROW_ID,
          new_sensitivity: 'confidential',
          reason: 'contains customer financials',
        },
        makeContext(),
      )

      expect(result.isError).toBeUndefined()
      expect(rec.reclassify[0]!).toMatchObject({
        triggeredBy: 'automatic_detection',
        direction: 'upgrade',
      })
    })

    it('rejects an unknown sensitivity tier at the schema', () => {
      const { deps } = makeDeps()
      const { reclassifySensitivity } = byName(createCorrectionTools(deps))
      expect(
        reclassifySensitivity.inputSchema.safeParse({
          primitive: 'entity',
          row_id: ROW_ID,
          new_sensitivity: 'restricted',
          reason: 'x',
        }).success,
      ).toBe(false)
    })
  })
})

// ── Failure copy ─────────────────────────────────────────────────────
// docs/architecture/engine/tool-executor.md → "Failure copy". Two shapes the
// old bare `err.message` could not distinguish: a MISS (wrong id — re-resolve
// and try again) and a TERMINAL state (the end state already holds — stop).

describe('[COMP:corrections/tools] failure copy', () => {
  it('retractMemory reports an already-retracted memory as terminal, not as a bad id', async () => {
    const { deps } = makeDeps({
      memorySnapshot: {
        id: ROW_ID,
        workspaceId: WORKSPACE_ID,
        retractedAt: new Date('2026-08-01T00:00:00Z'),
        validTo: null,
        sourceEpisodeId: null,
        semanticHash: null,
        createdByUserId: USER_ID,
      },
    })
    const { retractMemory } = byName(createCorrectionTools(deps))
    const result = await retractMemory.execute({ memory_id: ROW_ID, reason: 'wrong' }, makeContext())
    expect(result.isError).toBe(true)
    const body = String(result.data)
    expect(body).toContain(`Memory ${ROW_ID} is ALREADY retracted`)
    expect(body).toContain('nothing changed and nothing needed to')
    expect(body).toContain('Do NOT retry this id')
    // It must NOT send the model hunting for a different tool.
    expect(body).toContain('do not look for another retract tool')
  })

  it('deleteBrainRow ships the per-primitive discovery tool on a miss', async () => {
    const { deps } = makeDeps({ rowSnapshot: null })
    const { deleteBrainRow } = byName(createCorrectionTools(deps))
    const result = await deleteBrainRow.execute(
      { primitive: 'contact', row_id: ROW_ID, reason: 'gone' },
      makeContext(),
    )
    expect(result.isError).toBe(true)
    const body = String(result.data)
    expect(body).toContain(ROW_ID)
    expect(body).toContain('Nothing was deleted')
    expect(body).toContain('listContacts')
    expect(body).toContain('returned a NEW id')
    expect(body).toContain('Do NOT retry this exact id')
  })

  it('deleteBrainRow reports an already-deleted row as terminal', async () => {
    const { deps } = makeDeps({
      rowSnapshot: {
        primitive: 'entity',
        rowId: ROW_ID,
        workspaceId: WORKSPACE_ID,
        validTo: new Date('2026-08-01T00:00:00Z'),
        retractedAt: null,
        createdByUserId: USER_ID,
      },
    })
    const { deleteBrainRow } = byName(createCorrectionTools(deps))
    const result = await deleteBrainRow.execute(
      { primitive: 'entity', row_id: ROW_ID, reason: 'gone' },
      makeContext(),
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('is ALREADY deleted')
    expect(String(result.data)).toContain('Do NOT retry this id')
  })
})
