/**
 * Rebuild flow - probe is cheap and labelled, derivation refuses an
 * unconfirmed run (the preflight gate), a seeded workspace completes
 * probe -> confirm -> derive -> derived-with-diff, and failure paths
 * mark the run failed.
 *
 * The store is an in-memory fake; episodes are served through the
 * mocked query; extraction is an injected fake per the RebuildExtractor
 * port.
 *
 * Spec: docs/architecture/brain/retroactive-rebuild.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  runs: new Map<string, Record<string, unknown>>(),
  episodes: [] as Array<Record<string, unknown>>,
  nextId: 1,
}))

vi.mock('../../db/client.js', () => ({
  query: vi.fn(async (text: string, values?: unknown[]) => {
    if (text.includes('count(*) AS n FROM episodes')) {
      return { rows: [{ n: String(state.episodes.length) }] }
    }
    if (text.includes('FROM episodes')) {
      const after = values?.[1] as Date | null
      const afterId = values?.[2] as string | null
      const limit = values?.[3] as number
      const sorted = [...state.episodes].sort((a, b) =>
        (a.created_at as Date).getTime() - (b.created_at as Date).getTime() || String(a.id).localeCompare(String(b.id)),
      )
      const startIdx = after
        ? sorted.findIndex((e) => (e.created_at as Date).getTime() === after.getTime() && e.id === afterId) + 1
        : 0
      return { rows: sorted.slice(startIdx, startIdx + limit) }
    }
    throw new Error(`unexpected query: ${text.slice(0, 60)}`)
  }),
  getPool: vi.fn(() => ({ connect: async () => { throw new Error('unused') } })),
}))

vi.mock('../rebuild-store.js', () => {
  const mapRun = (r: Record<string, unknown>) => ({ ...r }) as never
  return {
    createRebuildRun: vi.fn(async (p: Record<string, unknown>) => {
      const id = `run-${state.nextId++}`
      const run = {
        id,
        workspaceId: p.workspaceId,
        status: 'probed',
        targetPipelineVersion: p.targetPipelineVersion,
        probe: p.probe,
        progress: {},
        diff: null,
        error: null,
        confirmedAt: null,
        derivedAt: null,
        promotedAt: null,
        createdAt: new Date(),
      }
      state.runs.set(id, run)
      return mapRun(run)
    }),
    getRebuildRun: vi.fn(async (id: string) => {
      const r = state.runs.get(id)
      return r ? mapRun(r) : null
    }),
    confirmRebuildRun: vi.fn(async (id: string) => {
      const r = state.runs.get(id)
      if (!r || r.status !== 'probed') return null
      r.status = 'confirmed'
      r.confirmedAt = new Date()
      return mapRun(r)
    }),
    setRebuildStatus: vi.fn(
      async (id: string, from: string | string[], to: string, patch?: Record<string, unknown>) => {
        const r = state.runs.get(id)
        const fromList = Array.isArray(from) ? from : [from]
        if (!r || !fromList.includes(r.status as string)) return null
        r.status = to
        if (patch?.progress) r.progress = patch.progress
        if (patch?.diff) r.diff = patch.diff
        if (patch?.error) r.error = patch.error
        return mapRun(r)
      },
    ),
    updateRebuildProgress: vi.fn(async (id: string, progress: Record<string, unknown>) => {
      const r = state.runs.get(id)
      if (r) r.progress = progress
    }),
    computeRebuildDiff: vi.fn(async () => ({ shadowCount: 5, liveDerivedCount: 3, sample: [] })),
    promoteRebuildRun: vi.fn(),
    cancelRebuildRun: vi.fn(),
  }
})

import { probeRebuild, deriveShadow, confirmRebuildRun, EST_TOKENS_PER_EPISODE } from '../rebuild.js'

function seedEpisodes(n: number) {
  state.episodes = Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
    source_kind: 'chat',
    workspace_id: 'ws1',
    user_id: 'u1',
    assistant_id: 'a1',
    created_by_user_id: 'u1',
    created_at: new Date(2026, 0, 1 + i),
  }))
}

beforeEach(() => {
  state.runs.clear()
  state.episodes = []
  state.nextId = 1
})

describe('[COMP:api/rebuild-flow] probe', () => {
  it('is a count and a labelled estimate - never the work', async () => {
    seedEpisodes(4)
    const run = await probeRebuild({ workspaceId: 'ws1', targetPipelineVersion: 2 })
    expect(run.status).toBe('probed')
    expect(run.probe.episodeCount).toBe(4)
    expect(run.probe.estimatedTokens).toBe(4 * EST_TOKENS_PER_EPISODE)
    expect(String(run.probe.estimateBasis)).toContain('placeholder')
  })
})

describe('[COMP:api/rebuild-flow] derive', () => {
  it('refuses an unconfirmed run - the preflight gate', async () => {
    seedEpisodes(2)
    const run = await probeRebuild({ workspaceId: 'ws1', targetPipelineVersion: 2 })
    await expect(
      deriveShadow({ runId: run.id, extract: async () => ({ written: 1 }) }),
    ).rejects.toThrow('preflight gate')
  })

  it('seeded workspace completes probe -> confirm -> derive with diff', async () => {
    seedEpisodes(7)
    const run = await probeRebuild({ workspaceId: 'ws1', targetPipelineVersion: 2 })
    await confirmRebuildRun(run.id)

    const seen: string[] = []
    const done = await deriveShadow({
      runId: run.id,
      batchSize: 3,
      extract: async (episode, r) => {
        seen.push(episode.id)
        expect(r.targetPipelineVersion).toBe(2)
        return { written: 2 }
      },
    })
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
    expect(done.status).toBe('derived')
    expect(done.progress).toEqual({ processed: 7, written: 14 })
    expect(done.diff).toEqual({ shadowCount: 5, liveDerivedCount: 3, sample: [] })
  })

  it('marks the run failed (with the error) when extraction throws', async () => {
    seedEpisodes(3)
    const run = await probeRebuild({ workspaceId: 'ws1', targetPipelineVersion: 2 })
    await confirmRebuildRun(run.id)
    await expect(
      deriveShadow({
        runId: run.id,
        extract: async (e) => {
          if (e.id.endsWith('2')) throw new Error('extractor exploded')
          return { written: 1 }
        },
      }),
    ).rejects.toThrow('extractor exploded')
    const after = state.runs.get(run.id)!
    expect(after.status).toBe('failed')
    expect(after.error).toContain('extractor exploded')
  })
})
