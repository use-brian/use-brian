import { describe, it, expect, vi, type Mock } from 'vitest'
import {
  DeleteByAuthorError,
  HardPurgeError,
  PRIMITIVES_WITH_PHYSICAL_DELETE,
  SoftDeleteError,
  deleteByAuthor,
  hardPurge,
  isPhysicalDeleteOnly,
  softDelete,
  type ApplyHardPurgeInput,
  type ApplySoftDeleteInput,
  type RowSnapshot,
  type SoftDeleteDeps,
  type SoftDeletePrimitive,
  type SoftDeleteRepository,
} from '../soft-delete.js'

// ── Fixtures ────────────────────────────────────────────────────────

const WS = 'ws-1'
const AUTHOR = 'user-author'
const STRANGER = 'user-stranger'
const REASON = 'cleanup'

const SOFT_DELETABLE: readonly SoftDeletePrimitive[] = [
  'entity',
  'task',
  'kb_chunk',
  'contact',
  'company',
  'deal',
  'episode',
] as const

function snapshot(
  primitive: SoftDeletePrimitive,
  overrides: Partial<RowSnapshot> = {},
): RowSnapshot {
  return {
    primitive,
    rowId: `${primitive}-1`,
    workspaceId: WS,
    validTo: null,
    retractedAt: null,
    createdByUserId: AUTHOR,
    ...overrides,
  }
}

interface Wiring {
  repo: SoftDeleteRepository
  readForSoftDelete: Mock<
    (p: SoftDeletePrimitive, ws: string, id: string) => Promise<RowSnapshot | null>
  >
  readForAuthorshipDelete: Mock<
    (p: SoftDeletePrimitive, ws: string, id: string) => Promise<RowSnapshot | null>
  >
  applySoftDelete: Mock<(i: ApplySoftDeleteInput) => Promise<void>>
  applyHardPurge: Mock<(i: ApplyHardPurgeInput) => Promise<void>>
}

function makeRepo(opts: {
  row?: RowSnapshot | null
  authorRow?: RowSnapshot | null
} = {}): Wiring {
  const readForSoftDelete = vi.fn(async (p: SoftDeletePrimitive) =>
    opts.row === undefined ? snapshot(p) : opts.row,
  )
  const readForAuthorshipDelete = vi.fn(async (p: SoftDeletePrimitive) =>
    opts.authorRow === undefined
      ? (opts.row === undefined ? snapshot(p) : opts.row)
      : opts.authorRow,
  )
  const applySoftDelete = vi.fn(async () => {})
  const applyHardPurge = vi.fn(async () => {})
  const repo: SoftDeleteRepository = {
    readForSoftDelete,
    readForAuthorshipDelete,
    applySoftDelete,
    applyHardPurge,
  }
  return {
    repo,
    readForSoftDelete,
    readForAuthorshipDelete,
    applySoftDelete,
    applyHardPurge,
  }
}

function depsWith(wiring: Wiring, now?: Date): SoftDeleteDeps {
  return { repo: wiring.repo, clock: now ? () => now : undefined }
}

async function expectError<C extends string>(
  p: Promise<unknown>,
  Ctor: new (...args: never[]) => Error & { code: C },
  code: C,
) {
  await expect(p).rejects.toBeInstanceOf(Ctor)
  await expect(p).rejects.toMatchObject({ code })
}

// ── Pure helpers ────────────────────────────────────────────────────

describe('[COMP:corrections/soft-delete] isPhysicalDeleteOnly', () => {
  it('returns true for workspace_file', () => {
    expect(isPhysicalDeleteOnly('workspace_file')).toBe(true)
  })

  it('returns false for every other primitive', () => {
    for (const p of SOFT_DELETABLE) {
      expect(isPhysicalDeleteOnly(p)).toBe(false)
    }
  })

  it('exposes the physical-delete primitive list', () => {
    expect(PRIMITIVES_WITH_PHYSICAL_DELETE).toEqual(['workspace_file'])
  })
})

// ── [COMP:corrections/soft-delete] softDelete ───────────────────────

describe('[COMP:corrections/soft-delete] softDelete', () => {
  it.each(SOFT_DELETABLE)('soft-deletes %s via applySoftDelete', async primitive => {
    const wiring = makeRepo()
    const now = new Date('2026-05-14T10:00:00Z')
    const result = await softDelete(
      {
        primitive,
        workspaceId: WS,
        rowId: `${primitive}-1`,
        actorUserId: AUTHOR,
        reason: REASON,
      },
      depsWith(wiring, now),
    )
    expect(result).toEqual({ primitive, rowId: `${primitive}-1`, deletedAt: now })
    expect(wiring.applySoftDelete).toHaveBeenCalledWith({
      primitive,
      workspaceId: WS,
      rowId: `${primitive}-1`,
      actorUserId: AUTHOR,
      reason: REASON,
      now,
    })
  })

  it('refuses workspace_file with file_physical_delete_only', async () => {
    const wiring = makeRepo()
    await expectError(
      softDelete(
        {
          primitive: 'workspace_file',
          workspaceId: WS,
          rowId: 'file-1',
          actorUserId: AUTHOR,
          reason: REASON,
        },
        depsWith(wiring),
      ),
      SoftDeleteError,
      'file_physical_delete_only',
    )
    expect(wiring.readForSoftDelete).not.toHaveBeenCalled()
    expect(wiring.applySoftDelete).not.toHaveBeenCalled()
  })

  it('rejects row_not_found', async () => {
    const wiring = makeRepo({ row: null })
    await expectError(
      softDelete(
        { primitive: 'task', workspaceId: WS, rowId: 't-1', actorUserId: AUTHOR, reason: REASON },
        depsWith(wiring),
      ),
      SoftDeleteError,
      'row_not_found',
    )
    expect(wiring.applySoftDelete).not.toHaveBeenCalled()
  })

  it('rejects workspace_mismatch', async () => {
    const wiring = makeRepo({ row: snapshot('task', { workspaceId: 'ws-2' }) })
    await expectError(
      softDelete(
        { primitive: 'task', workspaceId: WS, rowId: 't-1', actorUserId: AUTHOR, reason: REASON },
        depsWith(wiring),
      ),
      SoftDeleteError,
      'workspace_mismatch',
    )
  })

  it('rejects already_soft_deleted', async () => {
    const wiring = makeRepo({
      row: snapshot('task', { validTo: new Date('2026-04-01') }),
    })
    await expectError(
      softDelete(
        { primitive: 'task', workspaceId: WS, rowId: 't-1', actorUserId: AUTHOR, reason: REASON },
        depsWith(wiring),
      ),
      SoftDeleteError,
      'already_soft_deleted',
    )
  })

  it('rejects already_retracted', async () => {
    const wiring = makeRepo({
      row: snapshot('task', { retractedAt: new Date('2026-04-01') }),
    })
    await expectError(
      softDelete(
        { primitive: 'task', workspaceId: WS, rowId: 't-1', actorUserId: AUTHOR, reason: REASON },
        depsWith(wiring),
      ),
      SoftDeleteError,
      'already_retracted',
    )
  })

  it('rejects reason_required', async () => {
    const wiring = makeRepo()
    await expectError(
      softDelete(
        { primitive: 'task', workspaceId: WS, rowId: 't-1', actorUserId: AUTHOR, reason: '' },
        depsWith(wiring),
      ),
      SoftDeleteError,
      'reason_required',
    )
  })
})

// ── [COMP:corrections/soft-delete] hardPurge ────────────────────────

describe('[COMP:corrections/soft-delete] hardPurge', () => {
  const ALL_PRIMITIVES: readonly SoftDeletePrimitive[] = [
    ...SOFT_DELETABLE,
    'workspace_file',
  ] as const

  it.each(ALL_PRIMITIVES)('hard-purges %s via applyHardPurge', async primitive => {
    const wiring = makeRepo()
    const now = new Date('2026-05-14T11:00:00Z')
    const result = await hardPurge(
      {
        primitive,
        workspaceId: WS,
        rowId: `${primitive}-1`,
        actorUserId: AUTHOR,
        reason: REASON,
      },
      depsWith(wiring, now),
    )
    expect(result).toEqual({ primitive, rowId: `${primitive}-1`, purgedAt: now })
    expect(wiring.applyHardPurge).toHaveBeenCalledTimes(1)
    const call = wiring.applyHardPurge.mock.calls[0][0]
    expect(call).toMatchObject({
      primitive,
      workspaceId: WS,
      rowId: `${primitive}-1`,
      actorUserId: AUTHOR,
      reason: REASON,
      ticketReference: null,
      now,
    })
    expect(call.snapshot.primitive).toBe(primitive)
  })

  it('passes ticketReference through when supplied', async () => {
    const wiring = makeRepo()
    await hardPurge(
      {
        primitive: 'task',
        workspaceId: WS,
        rowId: 't-1',
        actorUserId: 'op-1',
        reason: 'GDPR',
        ticketReference: 'TICKET-99',
      },
      depsWith(wiring),
    )
    expect(wiring.applyHardPurge.mock.calls[0][0].ticketReference).toBe('TICKET-99')
  })

  it('rejects row_not_found', async () => {
    const wiring = makeRepo({ row: null })
    await expectError(
      hardPurge(
        { primitive: 'task', workspaceId: WS, rowId: 't-1', actorUserId: AUTHOR, reason: REASON },
        depsWith(wiring),
      ),
      HardPurgeError,
      'row_not_found',
    )
    expect(wiring.applyHardPurge).not.toHaveBeenCalled()
  })

  it('rejects workspace_mismatch', async () => {
    const wiring = makeRepo({ row: snapshot('task', { workspaceId: 'ws-2' }) })
    await expectError(
      hardPurge(
        { primitive: 'task', workspaceId: WS, rowId: 't-1', actorUserId: AUTHOR, reason: REASON },
        depsWith(wiring),
      ),
      HardPurgeError,
      'workspace_mismatch',
    )
  })

  it('rejects reason_required', async () => {
    const wiring = makeRepo()
    await expectError(
      hardPurge(
        { primitive: 'task', workspaceId: WS, rowId: 't-1', actorUserId: AUTHOR, reason: '' },
        depsWith(wiring),
      ),
      HardPurgeError,
      'reason_required',
    )
  })
})

// ── [COMP:corrections/soft-delete] deleteByAuthor ───────────────────

describe('[COMP:corrections/soft-delete] deleteByAuthor', () => {
  it('soft-deletes when actor authored the row, via the bypass-read port', async () => {
    const wiring = makeRepo()
    const now = new Date('2026-05-14T12:00:00Z')
    await deleteByAuthor(
      { primitive: 'task', workspaceId: WS, rowId: 't-1', actorUserId: AUTHOR, reason: REASON },
      depsWith(wiring, now),
    )
    expect(wiring.readForAuthorshipDelete).toHaveBeenCalledTimes(1)
    expect(wiring.readForSoftDelete).not.toHaveBeenCalled()
    expect(wiring.applySoftDelete).toHaveBeenCalledWith({
      primitive: 'task',
      workspaceId: WS,
      rowId: 't-1',
      actorUserId: AUTHOR,
      reason: REASON,
      now,
    })
  })

  it('rejects not_author when actor differs from createdByUserId', async () => {
    const wiring = makeRepo()
    await expectError(
      deleteByAuthor(
        {
          primitive: 'task',
          workspaceId: WS,
          rowId: 't-1',
          actorUserId: STRANGER,
          reason: REASON,
        },
        depsWith(wiring),
      ),
      DeleteByAuthorError,
      'not_author',
    )
    expect(wiring.applySoftDelete).not.toHaveBeenCalled()
  })

  it('rejects row_not_found', async () => {
    const wiring = makeRepo({ authorRow: null })
    await expectError(
      deleteByAuthor(
        { primitive: 'task', workspaceId: WS, rowId: 't-1', actorUserId: AUTHOR, reason: REASON },
        depsWith(wiring),
      ),
      DeleteByAuthorError,
      'row_not_found',
    )
  })

  it('rejects workspace_mismatch', async () => {
    const wiring = makeRepo({
      authorRow: snapshot('task', { workspaceId: 'ws-2' }),
    })
    await expectError(
      deleteByAuthor(
        { primitive: 'task', workspaceId: WS, rowId: 't-1', actorUserId: AUTHOR, reason: REASON },
        depsWith(wiring),
      ),
      DeleteByAuthorError,
      'workspace_mismatch',
    )
  })

  it('rejects already_soft_deleted', async () => {
    const wiring = makeRepo({
      authorRow: snapshot('task', { validTo: new Date('2026-04-01') }),
    })
    await expectError(
      deleteByAuthor(
        { primitive: 'task', workspaceId: WS, rowId: 't-1', actorUserId: AUTHOR, reason: REASON },
        depsWith(wiring),
      ),
      DeleteByAuthorError,
      'already_soft_deleted',
    )
  })

  it('rejects already_retracted', async () => {
    const wiring = makeRepo({
      authorRow: snapshot('task', { retractedAt: new Date('2026-04-01') }),
    })
    await expectError(
      deleteByAuthor(
        { primitive: 'task', workspaceId: WS, rowId: 't-1', actorUserId: AUTHOR, reason: REASON },
        depsWith(wiring),
      ),
      DeleteByAuthorError,
      'already_retracted',
    )
  })

  it('rejects reason_required', async () => {
    const wiring = makeRepo()
    await expectError(
      deleteByAuthor(
        { primitive: 'task', workspaceId: WS, rowId: 't-1', actorUserId: AUTHOR, reason: '' },
        depsWith(wiring),
      ),
      DeleteByAuthorError,
      'reason_required',
    )
  })

  it('refuses workspace_file with file_physical_delete_only', async () => {
    const wiring = makeRepo()
    await expectError(
      deleteByAuthor(
        {
          primitive: 'workspace_file',
          workspaceId: WS,
          rowId: 'file-1',
          actorUserId: AUTHOR,
          reason: REASON,
        },
        depsWith(wiring),
      ),
      DeleteByAuthorError,
      'file_physical_delete_only',
    )
    expect(wiring.readForAuthorshipDelete).not.toHaveBeenCalled()
  })
})
