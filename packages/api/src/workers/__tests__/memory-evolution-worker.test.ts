/**
 * Unit tests for the workspace memory-evolution worker.
 *
 * The worker's outer shell (timer loop, store reads/writes) is covered
 * by the pure-function helpers that drive it: direction classifiers,
 * snippet builder, and the `processWorkspace` orchestration. We mock
 * the DB at the `query` boundary and verify the worker computes rates
 * correctly + emits the right snippet for each pattern.
 *
 * Per `docs/architecture/brain/corrections.md` → "Workspace-level
 * prompt evolution".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))
vi.mock('../../db/workspace-memory-evolution-store.js', () => ({
  upsertEvolution: vi.fn(),
}))

import {
  buildPromptSnippet,
  classifyScopeDirection,
  classifySensitivityDirection,
  processWorkspace,
  createMemoryEvolutionWorker,
} from '../memory-evolution-worker.js'
import { query } from '../../db/client.js'
import { upsertEvolution } from '../../db/workspace-memory-evolution-store.js'

const mockQuery = vi.mocked(query)
const mockUpsert = vi.mocked(upsertEvolution)

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Direction classifiers ─────────────────────────────────────────

describe('[COMP:brain/memory-evolution-worker] classifyScopeDirection', () => {
  it('detects narrow→wide (user widened model scope)', () => {
    expect(classifyScopeDirection('personal', 'workspace_shared')).toBe('narrow_to_wide')
    expect(classifyScopeDirection('personal', 'workspace')).toBe('narrow_to_wide')
  })

  it('detects wide→narrow (user narrowed model scope)', () => {
    expect(classifyScopeDirection('workspace_shared', 'personal')).toBe('wide_to_narrow')
    expect(classifyScopeDirection('workspace', 'personal')).toBe('wide_to_narrow')
  })

  it('returns neutral for same-direction changes inside the wide tier', () => {
    // Both values are "wide" — that's not a directional correction.
    expect(classifyScopeDirection('workspace_shared', 'workspace')).toBe('neutral')
    expect(classifyScopeDirection('workspace', 'workspace_shared')).toBe('neutral')
  })

  it('returns neutral when values match or are non-strings', () => {
    expect(classifyScopeDirection('personal', 'personal')).toBe('neutral')
    expect(classifyScopeDirection(null, 'personal')).toBe('neutral')
    expect(classifyScopeDirection('personal', undefined)).toBe('neutral')
    expect(classifyScopeDirection({}, [])).toBe('neutral')
  })
})

describe('[COMP:brain/memory-evolution-worker] classifySensitivityDirection', () => {
  it('detects over→under (user lowered model sensitivity)', () => {
    expect(classifySensitivityDirection('confidential', 'internal')).toBe('over_to_under')
    expect(classifySensitivityDirection('internal', 'public')).toBe('over_to_under')
    expect(classifySensitivityDirection('confidential', 'public')).toBe('over_to_under')
  })

  it('detects under→over (user raised model sensitivity)', () => {
    expect(classifySensitivityDirection('internal', 'confidential')).toBe('under_to_over')
    expect(classifySensitivityDirection('public', 'internal')).toBe('under_to_over')
    expect(classifySensitivityDirection('public', 'confidential')).toBe('under_to_over')
  })

  it('returns neutral for matched values or unknowns', () => {
    expect(classifySensitivityDirection('confidential', 'confidential')).toBe('neutral')
    expect(classifySensitivityDirection('weird', 'internal')).toBe('neutral')
    expect(classifySensitivityDirection(null, 'internal')).toBe('neutral')
  })
})

// ── Snippet builder ───────────────────────────────────────────────

describe('[COMP:brain/memory-evolution-worker] buildPromptSnippet', () => {
  it('returns null when every rate is below the 15% significance threshold', () => {
    const snippet = buildPromptSnippet({
      scopeNarrowRate: 0.14,
      scopeWideRate: 0.05,
      sensitivityOverRate: 0.01,
      sensitivityUnderRate: 0.0,
    })
    expect(snippet).toBeNull()
  })

  it('emits scope-narrow rule with top categories when scopeNarrowRate ≥ 15%', () => {
    const snippet = buildPromptSnippet({
      scopeNarrowRate: 0.32,
      scopeWideRate: 0.0,
      sensitivityOverRate: 0.0,
      sensitivityUnderRate: 0.0,
      topScopeNarrowCategories: ['preferences', 'voice', 'roadmap'],
    })
    expect(snippet).not.toBeNull()
    expect(snippet).toContain('# Workspace memory conventions')
    expect(snippet).toContain("lean toward 'workspace_shared'")
    expect(snippet).toContain('"preferences"')
    expect(snippet).toContain('"voice"')
    expect(snippet).toContain('"roadmap"')
  })

  it('omits the category-example sentence when no categories are supplied', () => {
    const snippet = buildPromptSnippet({
      scopeNarrowRate: 0.32,
      scopeWideRate: 0.0,
      sensitivityOverRate: 0.0,
      sensitivityUnderRate: 0.0,
      topScopeNarrowCategories: [],
    })
    expect(snippet).toContain('lean toward')
    expect(snippet).not.toContain("Examples we've observed")
  })

  it('emits scope-wide rule when scopeWideRate ≥ 15%', () => {
    const snippet = buildPromptSnippet({
      scopeNarrowRate: 0.0,
      scopeWideRate: 0.21,
      sensitivityOverRate: 0.0,
      sensitivityUnderRate: 0.0,
    })
    expect(snippet).not.toBeNull()
    expect(snippet).toContain("prefer narrower 'personal' scope")
  })

  it('emits sensitivity-over rule when sensitivityOverRate ≥ 15%', () => {
    const snippet = buildPromptSnippet({
      scopeNarrowRate: 0.0,
      scopeWideRate: 0.0,
      sensitivityOverRate: 0.19,
      sensitivityUnderRate: 0.0,
    })
    expect(snippet).not.toBeNull()
    expect(snippet).toContain("default sensitivity to 'internal'")
  })

  it('emits sensitivity-under rule when sensitivityUnderRate ≥ 15%', () => {
    const snippet = buildPromptSnippet({
      scopeNarrowRate: 0.0,
      scopeWideRate: 0.0,
      sensitivityOverRate: 0.0,
      sensitivityUnderRate: 0.27,
    })
    expect(snippet).not.toBeNull()
    expect(snippet).toContain("escalate sensitivity to 'confidential'")
  })

  it('stacks multiple rules when more than one dimension is significant', () => {
    const snippet = buildPromptSnippet({
      scopeNarrowRate: 0.16,
      scopeWideRate: 0.0,
      sensitivityOverRate: 0.0,
      sensitivityUnderRate: 0.18,
    })
    expect(snippet).not.toBeNull()
    expect(snippet).toContain('lean toward')
    expect(snippet).toContain('escalate sensitivity')
    // Two bullet lines — header + 2 bullets + 1 intro sentence = 4 lines.
    const bulletCount = (snippet ?? '').split('\n').filter((l) => l.startsWith('- ')).length
    expect(bulletCount).toBe(2)
  })

  it('exactly at the threshold (15%) still emits — the check is ≥, not >', () => {
    const snippet = buildPromptSnippet({
      scopeNarrowRate: 0.15,
      scopeWideRate: 0.0,
      sensitivityOverRate: 0.0,
      sensitivityUnderRate: 0.0,
    })
    expect(snippet).not.toBeNull()
  })
})

// ── processWorkspace (rate computation + upsert) ──────────────────

describe('[COMP:brain/memory-evolution-worker] processWorkspace', () => {
  it('skips workspaces with < 10 verifications in the window', async () => {
    // 1st query = saves count, 2nd query = verifications join.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '20' }] } as any)
      .mockResolvedValueOnce({
        rows: Array.from({ length: 7 }, () => ({
          action: 'confirm',
          modelValue: null,
          userValue: null,
          tags: null,
        })),
      } as any)

    const outcome = await processWorkspace('w_low', new Date(Date.now() - 30 * 86400000))
    expect(outcome).toEqual({ outcome: 'skipped', reason: 'below_min_verifications' })
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('computes scope_narrow_rate and emits the corresponding snippet with top categories', async () => {
    // 20 verifications: 5 scope-narrow (personal → workspace_shared) with
    // 3 of them tagged "preferences", 2 "voice"; rest are unrelated
    // confirms. Tags are text[] arrays now (mig 177 folded the old
    // `category` column into `tags`).
    const verifications = [
      ...Array(3).fill({
        action: 'adjust_scope',
        modelValue: 'personal',
        userValue: 'workspace_shared',
        tags: ['preferences'],
      }),
      ...Array(2).fill({
        action: 'adjust_scope',
        modelValue: 'personal',
        userValue: 'workspace_shared',
        tags: ['voice'],
      }),
      ...Array(15).fill({
        action: 'confirm',
        modelValue: null,
        userValue: null,
        tags: null,
      }),
    ]
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '100' }] } as any)
      .mockResolvedValueOnce({ rows: verifications } as any)

    const outcome = await processWorkspace('w_narrow', new Date(Date.now() - 30 * 86400000))
    expect(outcome.outcome).toBe('processed')
    if (outcome.outcome !== 'processed') return
    expect(outcome.totalSaves).toBe(100)
    expect(outcome.totalVerifications).toBe(20)
    expect(outcome.snippetEmitted).toBe(true)

    expect(mockUpsert).toHaveBeenCalledTimes(1)
    const args = mockUpsert.mock.calls[0][0]
    // 5 / 20 = 0.25
    expect(args.scopeNarrowRate).toBe(0.25)
    expect(args.scopeWideRate).toBe(0)
    expect(args.sensitivityOverRate).toBe(0)
    expect(args.sensitivityUnderRate).toBe(0)
    expect(args.promptSnippet).toContain("lean toward 'workspace_shared'")
    expect(args.promptSnippet).toContain('"preferences"')
    expect(args.promptSnippet).toContain('"voice"')
    expect(args.totalSaves30d).toBe(100)
    expect(args.totalVerifications30d).toBe(20)
  })

  it('emits scope-wide snippet when users consistently narrow model scope', async () => {
    const verifications = [
      ...Array(4).fill({
        action: 'adjust_scope',
        modelValue: 'workspace_shared',
        userValue: 'personal',
        tags: ['snark'],
      }),
      ...Array(16).fill({
        action: 'confirm',
        modelValue: null,
        userValue: null,
        tags: null,
      }),
    ]
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '40' }] } as any)
      .mockResolvedValueOnce({ rows: verifications } as any)

    await processWorkspace('w_wide', new Date(Date.now() - 30 * 86400000))
    const args = mockUpsert.mock.calls[0][0]
    expect(args.scopeWideRate).toBe(0.2)
    expect(args.promptSnippet).toContain("prefer narrower 'personal' scope")
  })

  it('emits sensitivity-over snippet when users consistently lower sensitivity', async () => {
    const verifications = [
      ...Array(5).fill({
        action: 'adjust_sensitivity',
        modelValue: 'confidential',
        userValue: 'internal',
        tags: null,
      }),
      ...Array(20).fill({
        action: 'confirm',
        modelValue: null,
        userValue: null,
        tags: null,
      }),
    ]
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '60' }] } as any)
      .mockResolvedValueOnce({ rows: verifications } as any)

    await processWorkspace('w_over', new Date(Date.now() - 30 * 86400000))
    const args = mockUpsert.mock.calls[0][0]
    expect(args.sensitivityOverRate).toBe(0.2)
    expect(args.promptSnippet).toContain("default sensitivity to 'internal'")
  })

  it('emits sensitivity-under snippet when users consistently raise sensitivity', async () => {
    const verifications = [
      ...Array(4).fill({
        action: 'adjust_sensitivity',
        modelValue: 'internal',
        userValue: 'confidential',
        tags: null,
      }),
      ...Array(16).fill({
        action: 'confirm',
        modelValue: null,
        userValue: null,
        tags: null,
      }),
    ]
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '20' }] } as any)
      .mockResolvedValueOnce({ rows: verifications } as any)

    await processWorkspace('w_under', new Date(Date.now() - 30 * 86400000))
    const args = mockUpsert.mock.calls[0][0]
    expect(args.sensitivityUnderRate).toBe(0.2)
    expect(args.promptSnippet).toContain("escalate sensitivity to 'confidential'")
  })

  it('upserts with null snippet when all rates fall below the threshold', async () => {
    // 12 verifications crosses MIN_VERIFICATIONS_FOR_AGGREGATION (10),
    // but no directional pattern crosses 15% — so the upsert still
    // happens (with zeros) but no snippet is emitted. This is the
    // "we saw enough traffic to compute, and the model is consistent"
    // case.
    const verifications = [
      ...Array(1).fill({
        action: 'adjust_scope',
        modelValue: 'personal',
        userValue: 'workspace_shared',
        tags: null,
      }),
      ...Array(11).fill({
        action: 'confirm',
        modelValue: null,
        userValue: null,
        tags: null,
      }),
    ]
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '30' }] } as any)
      .mockResolvedValueOnce({ rows: verifications } as any)

    const outcome = await processWorkspace('w_consistent', new Date(Date.now() - 30 * 86400000))
    expect(outcome.outcome).toBe('processed')
    if (outcome.outcome !== 'processed') return
    expect(outcome.snippetEmitted).toBe(false)
    const args = mockUpsert.mock.calls[0][0]
    expect(args.promptSnippet).toBeNull()
    // 1 / 12 ≈ 0.083 → rounded to .083
    expect(args.scopeNarrowRate).toBeCloseTo(0.083, 3)
  })

  it('rounds rates to 3 decimal places before persisting', async () => {
    const verifications = [
      ...Array(7).fill({
        action: 'adjust_scope',
        modelValue: 'personal',
        userValue: 'workspace',
        tags: null,
      }),
      ...Array(6).fill({
        action: 'confirm',
        modelValue: null,
        userValue: null,
        tags: null,
      }),
    ]
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '20' }] } as any)
      .mockResolvedValueOnce({ rows: verifications } as any)

    await processWorkspace('w_round', new Date(Date.now() - 30 * 86400000))
    const args = mockUpsert.mock.calls[0][0]
    // 7 / 13 = 0.5384615... → rounded to 0.538.
    expect(args.scopeNarrowRate).toBe(0.538)
  })
})

// ── Worker lifecycle ──────────────────────────────────────────────

describe('[COMP:brain/memory-evolution-worker] createMemoryEvolutionWorker', () => {
  it('is idempotent — calling start() twice creates only one timer pair', () => {
    const worker = createMemoryEvolutionWorker({
      tickIntervalMs: 1_000_000,
      firstTickDelayMs: 1_000_000,
    })
    worker.start()
    worker.start() // idempotent
    expect(worker.isRunning).toBe(true)
    worker.stop()
    expect(worker.isRunning).toBe(false)
  })

  it('stop() before start() is a no-op', () => {
    const worker = createMemoryEvolutionWorker({})
    expect(worker.isRunning).toBe(false)
    worker.stop()
    expect(worker.isRunning).toBe(false)
  })

  it('emits tick_complete after a manual tick with zero workspaces', async () => {
    // First tick query — candidate workspaces. Return empty.
    mockQuery.mockResolvedValueOnce({ rows: [] } as any)
    const events: any[] = []
    const worker = createMemoryEvolutionWorker({
      tickIntervalMs: 1_000_000,
      firstTickDelayMs: 1_000_000,
      onEvent: (e) => events.push(e),
    })
    await worker.tick()
    expect(events.map((e) => e.type)).toContain('tick_start')
    expect(events.map((e) => e.type)).toContain('tick_complete')
    const complete = events.find((e) => e.type === 'tick_complete')
    expect(complete.processedCount).toBe(0)
    expect(complete.errorCount).toBe(0)
  })
})
