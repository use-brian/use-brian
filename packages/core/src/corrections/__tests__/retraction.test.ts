import { describe, it, expect, vi, type Mock } from 'vitest'
import {
  EpisodeReExtractionError,
  MemoryPurgeError,
  MemoryRetractionError,
  findRetractedMatch,
  purgeMemory,
  reExtractEpisode,
  retractMemory,
  type ApplyHardPurgeInput,
  type ApplySoftRetractInput,
  type EpisodeDerivationSnapshot,
  type EpisodeReExtractionRepository,
  type FindRetractedMatchArgs,
  type MemoryRetractionRepository,
  type MemoryRetractionSnapshot,
  type RetractionDeps,
  type SupersedeDerivationsInput,
  type TriggerExtractionInput,
} from '../retraction.js'

// ── Fixtures ────────────────────────────────────────────────────────

const WS = 'ws-1'
const ACTOR = 'user-actor'
const REASON = 'user correction'

function snapshot(
  overrides: Partial<MemoryRetractionSnapshot> = {},
): MemoryRetractionSnapshot {
  return {
    id: 'mem-1',
    workspaceId: WS,
    retractedAt: null,
    validTo: null,
    sourceEpisodeId: 'ep-1',
    semanticHash: 'h-1',
    createdByUserId: ACTOR,
    ...overrides,
  }
}

interface MemoryWiring {
  repo: MemoryRetractionRepository
  applySoftRetract: Mock<(i: ApplySoftRetractInput) => Promise<void>>
  applyHardPurge: Mock<(i: ApplyHardPurgeInput) => Promise<void>>
  findRetractedMatch: Mock<
    (a: FindRetractedMatchArgs) => Promise<MemoryRetractionSnapshot | null>
  >
}

function makeMemoryRepo(opts: {
  memory?: MemoryRetractionSnapshot | null
  retractedMatch?: MemoryRetractionSnapshot | null
} = {}): MemoryWiring {
  const applySoftRetract = vi.fn(async () => {})
  const applyHardPurge = vi.fn(async () => {})
  const findRetractedMatchMock = vi.fn(async () => opts.retractedMatch ?? null)
  const repo: MemoryRetractionRepository = {
    readMemoryForRetraction: async () =>
      opts.memory === undefined ? snapshot() : opts.memory,
    applySoftRetract,
    applyHardPurge,
    findRetractedMatch: findRetractedMatchMock,
  }
  return {
    repo,
    applySoftRetract,
    applyHardPurge,
    findRetractedMatch: findRetractedMatchMock,
  }
}

interface EpisodeWiring {
  repo: EpisodeReExtractionRepository
  snapshotDerivations: Mock<
    (ws: string, ep: string) => Promise<readonly EpisodeDerivationSnapshot[]>
  >
  supersedeDerivations: Mock<
    (i: SupersedeDerivationsInput) => Promise<{ supersededCount: number }>
  >
  triggerExtraction: Mock<(i: TriggerExtractionInput) => Promise<void>>
}

function makeEpisodeRepo(opts: {
  episode?: { id: string; workspaceId: string } | null
  derivations?: readonly EpisodeDerivationSnapshot[]
  triggerThrows?: Error
} = {}): EpisodeWiring {
  const derivations = opts.derivations ?? [
    { primitive: 'memory', rowId: 'm-1', validTo: null },
    { primitive: 'task', rowId: 't-1', validTo: null },
  ]
  const snapshotDerivations = vi.fn(async () => derivations)
  const supersedeDerivations = vi.fn(async () => ({
    supersededCount: derivations.length,
  }))
  const triggerExtraction = vi.fn(async () => {
    if (opts.triggerThrows) throw opts.triggerThrows
  })
  const repo: EpisodeReExtractionRepository = {
    readEpisodeForReExtraction: async () =>
      opts.episode === undefined ? { id: 'ep-1', workspaceId: WS } : opts.episode,
    snapshotDerivations,
    supersedeDerivations,
    triggerExtraction,
  }
  return { repo, snapshotDerivations, supersedeDerivations, triggerExtraction }
}

function depsWith(opts: {
  memory?: MemoryWiring
  episode?: EpisodeWiring
  now?: Date
}): RetractionDeps {
  return {
    memoryRepo: opts.memory?.repo ?? makeMemoryRepo().repo,
    episodeRepo: opts.episode?.repo,
    clock: opts.now ? () => opts.now! : undefined,
  }
}

async function expectError<C extends string>(
  p: Promise<unknown>,
  Ctor: new (...args: never[]) => Error & { code: C },
  code: C,
) {
  await expect(p).rejects.toBeInstanceOf(Ctor)
  await expect(p).rejects.toMatchObject({ code })
}

// ── [COMP:corrections/retraction] ───────────────────────────────────

describe('[COMP:corrections/retraction] retractMemory', () => {
  it('soft-retracts via applySoftRetract with clock-supplied now', async () => {
    const memory = makeMemoryRepo()
    const now = new Date('2026-05-14T10:00:00Z')
    const result = await retractMemory(
      { workspaceId: WS, memoryId: 'mem-1', actorUserId: ACTOR, reason: REASON },
      depsWith({ memory, now }),
    )
    expect(result).toEqual({ memoryId: 'mem-1', retractedAt: now })
    expect(memory.applySoftRetract).toHaveBeenCalledTimes(1)
    expect(memory.applySoftRetract).toHaveBeenCalledWith({
      workspaceId: WS,
      memoryId: 'mem-1',
      retractedBy: ACTOR,
      reason: REASON,
      now,
    })
  })

  it('rejects memory_not_found', async () => {
    const memory = makeMemoryRepo({ memory: null })
    await expectError(
      retractMemory(
        { workspaceId: WS, memoryId: 'mem-1', actorUserId: ACTOR, reason: REASON },
        depsWith({ memory }),
      ),
      MemoryRetractionError,
      'memory_not_found',
    )
    expect(memory.applySoftRetract).not.toHaveBeenCalled()
  })

  it('rejects memory_already_retracted', async () => {
    const memory = makeMemoryRepo({
      memory: snapshot({ retractedAt: new Date('2026-04-01') }),
    })
    await expectError(
      retractMemory(
        { workspaceId: WS, memoryId: 'mem-1', actorUserId: ACTOR, reason: REASON },
        depsWith({ memory }),
      ),
      MemoryRetractionError,
      'memory_already_retracted',
    )
    expect(memory.applySoftRetract).not.toHaveBeenCalled()
  })

  it('rejects workspace_mismatch', async () => {
    const memory = makeMemoryRepo({ memory: snapshot({ workspaceId: 'ws-2' }) })
    await expectError(
      retractMemory(
        { workspaceId: WS, memoryId: 'mem-1', actorUserId: ACTOR, reason: REASON },
        depsWith({ memory }),
      ),
      MemoryRetractionError,
      'workspace_mismatch',
    )
    expect(memory.applySoftRetract).not.toHaveBeenCalled()
  })

  it('rejects reason_required (empty)', async () => {
    const memory = makeMemoryRepo()
    await expectError(
      retractMemory(
        { workspaceId: WS, memoryId: 'mem-1', actorUserId: ACTOR, reason: '' },
        depsWith({ memory }),
      ),
      MemoryRetractionError,
      'reason_required',
    )
    expect(memory.applySoftRetract).not.toHaveBeenCalled()
  })

  it('rejects reason_required (whitespace)', async () => {
    const memory = makeMemoryRepo()
    await expectError(
      retractMemory(
        { workspaceId: WS, memoryId: 'mem-1', actorUserId: ACTOR, reason: '   ' },
        depsWith({ memory }),
      ),
      MemoryRetractionError,
      'reason_required',
    )
  })
})

describe('[COMP:corrections/retraction] purgeMemory', () => {
  it('hard-purges via applyHardPurge with snapshot for audit', async () => {
    const memory = makeMemoryRepo()
    const now = new Date('2026-05-14T11:00:00Z')
    const result = await purgeMemory(
      { workspaceId: WS, memoryId: 'mem-1', actorUserId: ACTOR, reason: REASON },
      depsWith({ memory, now }),
    )
    expect(result).toEqual({ memoryId: 'mem-1', purgedAt: now })
    expect(memory.applyHardPurge).toHaveBeenCalledTimes(1)
    const call = memory.applyHardPurge.mock.calls[0][0]
    expect(call).toMatchObject({
      workspaceId: WS,
      memoryId: 'mem-1',
      actorUserId: ACTOR,
      reason: REASON,
      now,
    })
    expect(call.snapshot.id).toBe('mem-1')
  })

  it('purges an already-retracted memory (idempotent)', async () => {
    const memory = makeMemoryRepo({
      memory: snapshot({ retractedAt: new Date('2026-04-01') }),
    })
    await expect(
      purgeMemory(
        { workspaceId: WS, memoryId: 'mem-1', actorUserId: ACTOR, reason: REASON },
        depsWith({ memory }),
      ),
    ).resolves.toMatchObject({ memoryId: 'mem-1' })
    expect(memory.applyHardPurge).toHaveBeenCalledTimes(1)
  })

  it('rejects memory_not_found', async () => {
    const memory = makeMemoryRepo({ memory: null })
    await expectError(
      purgeMemory(
        { workspaceId: WS, memoryId: 'mem-1', actorUserId: ACTOR, reason: REASON },
        depsWith({ memory }),
      ),
      MemoryPurgeError,
      'memory_not_found',
    )
    expect(memory.applyHardPurge).not.toHaveBeenCalled()
  })

  it('rejects workspace_mismatch', async () => {
    const memory = makeMemoryRepo({ memory: snapshot({ workspaceId: 'ws-2' }) })
    await expectError(
      purgeMemory(
        { workspaceId: WS, memoryId: 'mem-1', actorUserId: ACTOR, reason: REASON },
        depsWith({ memory }),
      ),
      MemoryPurgeError,
      'workspace_mismatch',
    )
    expect(memory.applyHardPurge).not.toHaveBeenCalled()
  })

  it('rejects reason_required', async () => {
    const memory = makeMemoryRepo()
    await expectError(
      purgeMemory(
        { workspaceId: WS, memoryId: 'mem-1', actorUserId: ACTOR, reason: '' },
        depsWith({ memory }),
      ),
      MemoryPurgeError,
      'reason_required',
    )
  })
})

describe('[COMP:corrections/retraction] findRetractedMatch', () => {
  it('returns the snapshot when port returns one (re-extraction guard hit)', async () => {
    const match = snapshot({ retractedAt: new Date('2026-04-01') })
    const memory = makeMemoryRepo({ retractedMatch: match })
    const result = await findRetractedMatch(
      { workspaceId: WS, sourceEpisodeId: 'ep-1', semanticHash: 'h-1' },
      depsWith({ memory }),
    )
    expect(result).toBe(match)
    expect(memory.findRetractedMatch).toHaveBeenCalledWith({
      workspaceId: WS,
      sourceEpisodeId: 'ep-1',
      semanticHash: 'h-1',
    })
  })

  it('returns null when port returns null (safe to write)', async () => {
    const memory = makeMemoryRepo({ retractedMatch: null })
    await expect(
      findRetractedMatch(
        { workspaceId: WS, sourceEpisodeId: 'ep-1', semanticHash: 'h-1' },
        depsWith({ memory }),
      ),
    ).resolves.toBeNull()
  })
})

describe('[COMP:corrections/retraction] reExtractEpisode', () => {
  it('supersedes derivations and triggers extraction', async () => {
    const episode = makeEpisodeRepo()
    const now = new Date('2026-05-14T12:00:00Z')
    const result = await reExtractEpisode(
      {
        workspaceId: WS,
        episodeId: 'ep-1',
        operatorUserId: 'op-1',
        ticketReference: 'TICKET-42',
        reason: 'fix bad extraction',
      },
      depsWith({ episode, now }),
    )
    expect(result).toEqual({
      episodeId: 'ep-1',
      derivationsSuperseded: 2,
      extractionTriggered: true,
    })
    expect(episode.snapshotDerivations).toHaveBeenCalledTimes(1)
    expect(episode.supersedeDerivations).toHaveBeenCalledTimes(1)
    expect(episode.triggerExtraction).toHaveBeenCalledTimes(1)
    expect(episode.supersedeDerivations.mock.calls[0][0]).toMatchObject({
      workspaceId: WS,
      episodeId: 'ep-1',
      operatorUserId: 'op-1',
      ticketReference: 'TICKET-42',
      reason: 'fix bad extraction',
      now,
    })
  })

  it('passes the full derivation list to the supersession port (none retracted)', async () => {
    const derivations: readonly EpisodeDerivationSnapshot[] = [
      { primitive: 'memory', rowId: 'm-1', validTo: null },
      { primitive: 'task', rowId: 't-1', validTo: null },
      { primitive: 'entity_link', rowId: 'el-1', validTo: null },
      { primitive: 'entity', rowId: 'e-1', validTo: null },
    ]
    const episode = makeEpisodeRepo({ derivations })
    await reExtractEpisode(
      {
        workspaceId: WS,
        episodeId: 'ep-1',
        operatorUserId: 'op-1',
        ticketReference: 'T-1',
        reason: 'fix',
      },
      depsWith({ episode }),
    )
    expect(episode.supersedeDerivations.mock.calls[0][0].derivations).toEqual(
      derivations,
    )
  })

  it('rejects episode_not_found', async () => {
    const episode = makeEpisodeRepo({ episode: null })
    await expectError(
      reExtractEpisode(
        {
          workspaceId: WS,
          episodeId: 'ep-1',
          operatorUserId: 'op-1',
          ticketReference: 'T-1',
          reason: 'fix',
        },
        depsWith({ episode }),
      ),
      EpisodeReExtractionError,
      'episode_not_found',
    )
    expect(episode.supersedeDerivations).not.toHaveBeenCalled()
  })

  it('rejects workspace_mismatch', async () => {
    const episode = makeEpisodeRepo({
      episode: { id: 'ep-1', workspaceId: 'ws-2' },
    })
    await expectError(
      reExtractEpisode(
        {
          workspaceId: WS,
          episodeId: 'ep-1',
          operatorUserId: 'op-1',
          ticketReference: 'T-1',
          reason: 'fix',
        },
        depsWith({ episode }),
      ),
      EpisodeReExtractionError,
      'workspace_mismatch',
    )
    expect(episode.supersedeDerivations).not.toHaveBeenCalled()
  })

  it('rejects ticket_required when ticketReference is empty', async () => {
    const episode = makeEpisodeRepo()
    await expectError(
      reExtractEpisode(
        {
          workspaceId: WS,
          episodeId: 'ep-1',
          operatorUserId: 'op-1',
          ticketReference: '',
          reason: 'fix',
        },
        depsWith({ episode }),
      ),
      EpisodeReExtractionError,
      'ticket_required',
    )
  })

  it('rejects reason_required when reason is empty', async () => {
    const episode = makeEpisodeRepo()
    await expectError(
      reExtractEpisode(
        {
          workspaceId: WS,
          episodeId: 'ep-1',
          operatorUserId: 'op-1',
          ticketReference: 'T-1',
          reason: '',
        },
        depsWith({ episode }),
      ),
      EpisodeReExtractionError,
      'reason_required',
    )
  })

  it('wraps extraction-trigger failure', async () => {
    const episode = makeEpisodeRepo({ triggerThrows: new Error('queue down') })
    await expectError(
      reExtractEpisode(
        {
          workspaceId: WS,
          episodeId: 'ep-1',
          operatorUserId: 'op-1',
          ticketReference: 'T-1',
          reason: 'fix',
        },
        depsWith({ episode }),
      ),
      EpisodeReExtractionError,
      'extraction_trigger_failed',
    )
  })

  it('rejects when episodeRepo is missing from deps', async () => {
    const memory = makeMemoryRepo()
    await expectError(
      reExtractEpisode(
        {
          workspaceId: WS,
          episodeId: 'ep-1',
          operatorUserId: 'op-1',
          ticketReference: 'T-1',
          reason: 'fix',
        },
        { memoryRepo: memory.repo },
      ),
      EpisodeReExtractionError,
      'extraction_trigger_failed',
    )
  })
})
