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
      expect(String(result.data)).toMatch(/no memory with that id/i)
    })

    it('errors without a workspace context', async () => {
      const { deps } = makeDeps()
      const { retractMemory } = byName(createCorrectionTools(deps))
      const result = await retractMemory.execute(
        { memory_id: ROW_ID, reason: 'x' },
        makeContext({ workspaceId: null }),
      )
      expect(result.isError).toBe(true)
      expect(String(result.data)).toMatch(/workspace/i)
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
      expect(String(result.data)).toMatch(/admin/i)
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
