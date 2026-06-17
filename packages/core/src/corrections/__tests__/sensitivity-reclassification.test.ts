import { describe, it, expect, vi, type Mock } from 'vitest'
import type { Sensitivity } from '../../security/sensitivity.js'
import {
  ChannelRuleSupersessionError,
  SensitivityReclassificationError,
  cascadedSensitivity,
  inferDirection,
  reclassifyRowSensitivity,
  requiresOperator,
  supersedeChannelSensitivityRule,
  type ApplyRowReclassificationInput,
  type ChannelSensitivityRule,
  type ChannelSensitivityRuleRepository,
  type DerivedRowRef,
  type FindDerivedRowsInput,
  type InsertSupersedingRuleInput,
  type ReclassifiablePrimitive,
  type RowSensitivitySnapshot,
  type SensitivityReclassificationDeps,
  type SensitivityReclassificationRepository,
  type TriggeredBy,
} from '../sensitivity-reclassification.js'

// ── Fixtures ────────────────────────────────────────────────────────

const WS = 'ws-1'
const ACTOR = 'user-actor'
const REASON = 'classification change'

function rowSnap(
  overrides: Partial<RowSensitivitySnapshot> = {},
): RowSensitivitySnapshot {
  return {
    primitive: 'memory',
    rowId: 'm-1',
    workspaceId: WS,
    sensitivity: 'internal',
    sourceEpisodeId: 'ep-1',
    validTo: null,
    ...overrides,
  }
}

function rule(overrides: Partial<ChannelSensitivityRule> = {}): ChannelSensitivityRule {
  return {
    id: 'rule-prior',
    workspaceId: WS,
    sourceKind: 'slack',
    sourceRefMatch: { channel: 'C123' },
    defaultSensitivity: 'internal',
    appliedFrom: new Date('2026-03-01'),
    supersededAt: null,
    supersededBy: null,
    ...overrides,
  }
}

interface RowWiring {
  repo: SensitivityReclassificationRepository
  readRowForReclassification: Mock<
    (
      p: ReclassifiablePrimitive,
      ws: string,
      id: string,
    ) => Promise<RowSensitivitySnapshot | null>
  >
  applyRowReclassification: Mock<(i: ApplyRowReclassificationInput) => Promise<void>>
  findDerivedRows: Mock<(i: FindDerivedRowsInput) => Promise<readonly DerivedRowRef[]>>
}

function makeRowRepo(opts: {
  row?: RowSensitivitySnapshot | null
  /** Map of `${primitive}:${rowId}` → derived rows. */
  derivedBySource?: Record<string, readonly DerivedRowRef[]>
} = {}): RowWiring {
  const readRowForReclassification = vi.fn(
    async (p: ReclassifiablePrimitive) =>
      opts.row === undefined ? rowSnap({ primitive: p }) : opts.row,
  )
  const applyRowReclassification = vi.fn(async () => {})
  const findDerivedRows = vi.fn(async (input: FindDerivedRowsInput) => {
    const key = `${input.sourcePrimitive}:${input.sourceRowId}`
    return opts.derivedBySource?.[key] ?? []
  })
  const repo: SensitivityReclassificationRepository = {
    readRowForReclassification,
    applyRowReclassification,
    findDerivedRows,
  }
  return { repo, readRowForReclassification, applyRowReclassification, findDerivedRows }
}

interface RuleWiring {
  repo: ChannelSensitivityRuleRepository
  readRule: Mock<(ws: string, id: string) => Promise<ChannelSensitivityRule | null>>
  insertSupersedingRule: Mock<
    (i: InsertSupersedingRuleInput) => Promise<{ newRuleId: string }>
  >
  findRowsUnderRuleScope: Mock<
    (i: { workspaceId: string; ruleId: string }) =>
      Promise<readonly RowSensitivitySnapshot[]>
  >
}

function makeRuleRepo(opts: {
  rule?: ChannelSensitivityRule | null
  newRuleId?: string
  scopedRows?: readonly RowSensitivitySnapshot[]
} = {}): RuleWiring {
  const readRule = vi.fn(async () => (opts.rule === undefined ? rule() : opts.rule))
  const insertSupersedingRule = vi.fn(async () => ({
    newRuleId: opts.newRuleId ?? 'rule-new',
  }))
  const findRowsUnderRuleScope = vi.fn(async () => opts.scopedRows ?? [])
  const repo: ChannelSensitivityRuleRepository = {
    readRule,
    insertSupersedingRule,
    findRowsUnderRuleScope,
  }
  return { repo, readRule, insertSupersedingRule, findRowsUnderRuleScope }
}

function depsWith(opts: {
  row?: RowWiring
  rule?: RuleWiring
  now?: Date
}): SensitivityReclassificationDeps {
  return {
    rowRepo: opts.row?.repo ?? makeRowRepo().repo,
    ruleRepo: opts.rule?.repo,
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

// ── Pure helpers ────────────────────────────────────────────────────

describe('[COMP:corrections/sensitivity-reclassification] inferDirection', () => {
  it('detects upgrade (public→internal, internal→confidential)', () => {
    expect(inferDirection('public', 'internal')).toBe('upgrade')
    expect(inferDirection('internal', 'confidential')).toBe('upgrade')
    expect(inferDirection('public', 'confidential')).toBe('upgrade')
  })

  it('detects downgrade (confidential→internal, internal→public)', () => {
    expect(inferDirection('confidential', 'internal')).toBe('downgrade')
    expect(inferDirection('internal', 'public')).toBe('downgrade')
    expect(inferDirection('confidential', 'public')).toBe('downgrade')
  })

  it('detects no_change at every tier', () => {
    for (const s of ['public', 'internal', 'confidential'] as const) {
      expect(inferDirection(s, s)).toBe('no_change')
    }
  })
})

describe('[COMP:corrections/sensitivity-reclassification] requiresOperator', () => {
  it('returns true only for downgrade not driven by per_row_operator', () => {
    expect(requiresOperator('downgrade', 'channel_rule')).toBe(true)
    expect(requiresOperator('downgrade', 'automatic_detection')).toBe(true)
    expect(requiresOperator('downgrade', 'per_row_operator')).toBe(false)
  })

  it('returns false for upgrades regardless of trigger', () => {
    const triggers: TriggeredBy[] = ['channel_rule', 'per_row_operator', 'automatic_detection']
    for (const t of triggers) {
      expect(requiresOperator('upgrade', t)).toBe(false)
    }
  })

  it('returns false for no_change', () => {
    expect(requiresOperator('no_change', 'channel_rule')).toBe(false)
  })
})

describe('[COMP:corrections/sensitivity-reclassification] cascadedSensitivity', () => {
  it('returns the higher of derived and source', () => {
    expect(cascadedSensitivity('public', 'internal')).toBe('internal')
    expect(cascadedSensitivity('internal', 'confidential')).toBe('confidential')
  })

  it('returns derived unchanged when source is equal or lower', () => {
    expect(cascadedSensitivity('confidential', 'internal')).toBe('confidential')
    expect(cascadedSensitivity('internal', 'internal')).toBe('internal')
    expect(cascadedSensitivity('internal', 'public')).toBe('internal')
  })
})

// ── reclassifyRowSensitivity ────────────────────────────────────────

describe('[COMP:corrections/sensitivity-reclassification] reclassifyRowSensitivity', () => {
  it('upgrades a row and cascades through one hop of derivations', async () => {
    const row = makeRowRepo({
      row: rowSnap({ primitive: 'memory', rowId: 'm-1', sensitivity: 'public' }),
      derivedBySource: {
        'memory:m-1': [
          { primitive: 'memory', rowId: 'm-2', sensitivity: 'public' },
          { primitive: 'task', rowId: 't-1', sensitivity: 'internal' }, // already above source
        ],
      },
    })
    const now = new Date('2026-05-14T10:00:00Z')
    const result = await reclassifyRowSensitivity(
      {
        primitive: 'memory',
        workspaceId: WS,
        rowId: 'm-1',
        newSensitivity: 'internal',
        actorUserId: ACTOR,
        reason: REASON,
        triggeredBy: 'per_row_operator',
      },
      depsWith({ row, now }),
    )
    expect(result).toEqual({
      rowId: 'm-1',
      primitive: 'memory',
      priorSensitivity: 'public',
      newSensitivity: 'internal',
      direction: 'upgrade',
      cascadeApplied: 1,
    })
    expect(row.applyRowReclassification).toHaveBeenCalledTimes(2)
    const calls = row.applyRowReclassification.mock.calls.map(c => c[0])
    expect(calls[0]).toMatchObject({
      primitive: 'memory',
      rowId: 'm-1',
      priorSensitivity: 'public',
      newSensitivity: 'internal',
      direction: 'upgrade',
    })
    expect(calls[1]).toMatchObject({
      primitive: 'memory',
      rowId: 'm-2',
      priorSensitivity: 'public',
      newSensitivity: 'internal',
      direction: 'upgrade',
    })
  })

  it('cascades recursively across multiple hops using MAX rule', async () => {
    const row = makeRowRepo({
      row: rowSnap({ primitive: 'episode', rowId: 'ep-1', sensitivity: 'public' }),
      derivedBySource: {
        'episode:ep-1': [{ primitive: 'memory', rowId: 'm-1', sensitivity: 'public' }],
        'memory:m-1': [{ primitive: 'memory', rowId: 'm-2', sensitivity: 'public' }],
      },
    })
    const result = await reclassifyRowSensitivity(
      {
        primitive: 'episode',
        workspaceId: WS,
        rowId: 'ep-1',
        newSensitivity: 'confidential',
        actorUserId: ACTOR,
        reason: REASON,
        triggeredBy: 'per_row_operator',
      },
      depsWith({ row }),
    )
    expect(result.cascadeApplied).toBe(2)
    expect(row.applyRowReclassification).toHaveBeenCalledTimes(3)
  })

  it('guards against cycles in the derivation graph', async () => {
    const row = makeRowRepo({
      row: rowSnap({ primitive: 'memory', rowId: 'm-1', sensitivity: 'public' }),
      derivedBySource: {
        'memory:m-1': [{ primitive: 'memory', rowId: 'm-2', sensitivity: 'public' }],
        'memory:m-2': [{ primitive: 'memory', rowId: 'm-1', sensitivity: 'public' }],
      },
    })
    const result = await reclassifyRowSensitivity(
      {
        primitive: 'memory',
        workspaceId: WS,
        rowId: 'm-1',
        newSensitivity: 'internal',
        actorUserId: ACTOR,
        reason: REASON,
        triggeredBy: 'per_row_operator',
      },
      depsWith({ row }),
    )
    expect(result.cascadeApplied).toBe(1)
    // Source m-1 + descendant m-2 = 2 total writes; cycle back to m-1 skipped.
    expect(row.applyRowReclassification).toHaveBeenCalledTimes(2)
  })

  it('applies downgrade with per_row_operator and does NOT cascade', async () => {
    const row = makeRowRepo({
      row: rowSnap({ primitive: 'memory', rowId: 'm-1', sensitivity: 'confidential' }),
      derivedBySource: {
        'memory:m-1': [
          { primitive: 'memory', rowId: 'm-2', sensitivity: 'confidential' },
        ],
      },
    })
    const result = await reclassifyRowSensitivity(
      {
        primitive: 'memory',
        workspaceId: WS,
        rowId: 'm-1',
        newSensitivity: 'internal',
        actorUserId: 'operator',
        reason: REASON,
        triggeredBy: 'per_row_operator',
      },
      depsWith({ row }),
    )
    expect(result.direction).toBe('downgrade')
    expect(result.cascadeApplied).toBe(0)
    expect(row.applyRowReclassification).toHaveBeenCalledTimes(1)
    expect(row.findDerivedRows).not.toHaveBeenCalled()
  })

  it('refuses downgrade with channel_rule', async () => {
    const row = makeRowRepo({
      row: rowSnap({ sensitivity: 'confidential' }),
    })
    await expectError(
      reclassifyRowSensitivity(
        {
          primitive: 'memory',
          workspaceId: WS,
          rowId: 'm-1',
          newSensitivity: 'internal',
          actorUserId: ACTOR,
          reason: REASON,
          triggeredBy: 'channel_rule',
          ruleId: 'rule-1',
        },
        depsWith({ row }),
      ),
      SensitivityReclassificationError,
      'downgrade_requires_operator',
    )
    expect(row.applyRowReclassification).not.toHaveBeenCalled()
  })

  it('refuses downgrade with automatic_detection', async () => {
    const row = makeRowRepo({ row: rowSnap({ sensitivity: 'confidential' }) })
    await expectError(
      reclassifyRowSensitivity(
        {
          primitive: 'memory',
          workspaceId: WS,
          rowId: 'm-1',
          newSensitivity: 'internal',
          actorUserId: ACTOR,
          reason: REASON,
          triggeredBy: 'automatic_detection',
        },
        depsWith({ row }),
      ),
      SensitivityReclassificationError,
      'downgrade_requires_operator',
    )
  })

  it('rejects no_change when new matches current', async () => {
    const row = makeRowRepo({ row: rowSnap({ sensitivity: 'internal' }) })
    await expectError(
      reclassifyRowSensitivity(
        {
          primitive: 'memory',
          workspaceId: WS,
          rowId: 'm-1',
          newSensitivity: 'internal',
          actorUserId: ACTOR,
          reason: REASON,
          triggeredBy: 'per_row_operator',
        },
        depsWith({ row }),
      ),
      SensitivityReclassificationError,
      'no_change',
    )
    expect(row.applyRowReclassification).not.toHaveBeenCalled()
  })

  it('rejects row_not_found', async () => {
    const row = makeRowRepo({ row: null })
    await expectError(
      reclassifyRowSensitivity(
        {
          primitive: 'memory',
          workspaceId: WS,
          rowId: 'm-1',
          newSensitivity: 'internal',
          actorUserId: ACTOR,
          reason: REASON,
          triggeredBy: 'per_row_operator',
        },
        depsWith({ row }),
      ),
      SensitivityReclassificationError,
      'row_not_found',
    )
  })

  it('rejects workspace_mismatch', async () => {
    const row = makeRowRepo({ row: rowSnap({ workspaceId: 'ws-2' }) })
    await expectError(
      reclassifyRowSensitivity(
        {
          primitive: 'memory',
          workspaceId: WS,
          rowId: 'm-1',
          newSensitivity: 'internal',
          actorUserId: ACTOR,
          reason: REASON,
          triggeredBy: 'per_row_operator',
        },
        depsWith({ row }),
      ),
      SensitivityReclassificationError,
      'workspace_mismatch',
    )
  })

  it('rejects reason_required', async () => {
    const row = makeRowRepo()
    await expectError(
      reclassifyRowSensitivity(
        {
          primitive: 'memory',
          workspaceId: WS,
          rowId: 'm-1',
          newSensitivity: 'confidential',
          actorUserId: ACTOR,
          reason: '',
          triggeredBy: 'per_row_operator',
        },
        depsWith({ row }),
      ),
      SensitivityReclassificationError,
      'reason_required',
    )
  })

  it('rejects rule_id_required_for_channel_rule', async () => {
    const row = makeRowRepo({ row: rowSnap({ sensitivity: 'public' }) })
    await expectError(
      reclassifyRowSensitivity(
        {
          primitive: 'memory',
          workspaceId: WS,
          rowId: 'm-1',
          newSensitivity: 'internal',
          actorUserId: ACTOR,
          reason: REASON,
          triggeredBy: 'channel_rule',
        },
        depsWith({ row }),
      ),
      SensitivityReclassificationError,
      'rule_id_required_for_channel_rule',
    )
  })
})

// ── supersedeChannelSensitivityRule ────────────────────────────────

describe('[COMP:corrections/sensitivity-reclassification] supersedeChannelSensitivityRule', () => {
  const newRuleSeed = {
    sourceKind: 'slack',
    sourceRefMatch: { channel: 'C123' },
    defaultSensitivity: 'confidential' as Sensitivity,
  }

  it('inserts a superseding rule without retroactive walk', async () => {
    const ruleW = makeRuleRepo()
    const row = makeRowRepo()
    const now = new Date('2026-05-14T13:00:00Z')
    const result = await supersedeChannelSensitivityRule(
      {
        workspaceId: WS,
        priorRuleId: 'rule-prior',
        newRule: newRuleSeed,
        actorUserId: ACTOR,
        reason: REASON,
        applyRetroactively: false,
      },
      depsWith({ row, rule: ruleW, now }),
    )
    expect(result).toEqual({
      priorRuleId: 'rule-prior',
      newRuleId: 'rule-new',
      retroactiveReclassifications: 0,
    })
    expect(ruleW.insertSupersedingRule).toHaveBeenCalledTimes(1)
    expect(ruleW.findRowsUnderRuleScope).not.toHaveBeenCalled()
    expect(row.applyRowReclassification).not.toHaveBeenCalled()
  })

  it('walks rule scope and reclassifies on retroactive upgrade', async () => {
    const scopedRows: RowSensitivitySnapshot[] = [
      rowSnap({ primitive: 'memory', rowId: 'm-1', sensitivity: 'internal' }),
      rowSnap({ primitive: 'memory', rowId: 'm-2', sensitivity: 'internal' }),
    ]
    const ruleW = makeRuleRepo({ scopedRows })
    const row = makeRowRepo({
      row: rowSnap({ sensitivity: 'internal' }),
    })
    // Override readRowForReclassification to map each rowId to its snap.
    const rowMap = new Map(scopedRows.map(r => [r.rowId, r]))
    ;(row.readRowForReclassification as Mock).mockImplementation(
      async (_p: ReclassifiablePrimitive, _ws: string, id: string) =>
        rowMap.get(id) ?? null,
    )

    const result = await supersedeChannelSensitivityRule(
      {
        workspaceId: WS,
        priorRuleId: 'rule-prior',
        newRule: newRuleSeed,
        actorUserId: ACTOR,
        reason: REASON,
        applyRetroactively: true,
      },
      depsWith({ row, rule: ruleW }),
    )
    expect(result.retroactiveReclassifications).toBe(2)
    expect(row.applyRowReclassification).toHaveBeenCalledTimes(2)
    for (const call of row.applyRowReclassification.mock.calls) {
      expect(call[0]).toMatchObject({
        newSensitivity: 'confidential',
        direction: 'upgrade',
        triggeredBy: 'channel_rule',
        ruleId: 'rule-new',
      })
    }
  })

  it('refuses retroactive downgrade', async () => {
    const ruleW = makeRuleRepo({
      rule: rule({ defaultSensitivity: 'confidential' }),
    })
    const row = makeRowRepo()
    await expectError(
      supersedeChannelSensitivityRule(
        {
          workspaceId: WS,
          priorRuleId: 'rule-prior',
          newRule: { ...newRuleSeed, defaultSensitivity: 'internal' },
          actorUserId: ACTOR,
          reason: REASON,
          applyRetroactively: true,
        },
        depsWith({ row, rule: ruleW }),
      ),
      ChannelRuleSupersessionError,
      'retroactive_downgrade_refused',
    )
    expect(ruleW.insertSupersedingRule).not.toHaveBeenCalled()
  })

  it('succeeds with zero reclassifications on retroactive no-change', async () => {
    const ruleW = makeRuleRepo()
    const row = makeRowRepo()
    const result = await supersedeChannelSensitivityRule(
      {
        workspaceId: WS,
        priorRuleId: 'rule-prior',
        newRule: { ...newRuleSeed, defaultSensitivity: 'internal' },
        actorUserId: ACTOR,
        reason: REASON,
        applyRetroactively: true,
      },
      depsWith({ row, rule: ruleW }),
    )
    expect(result.retroactiveReclassifications).toBe(0)
    expect(ruleW.findRowsUnderRuleScope).not.toHaveBeenCalled()
  })

  it('rejects rule_not_found', async () => {
    const ruleW = makeRuleRepo({ rule: null })
    const row = makeRowRepo()
    await expectError(
      supersedeChannelSensitivityRule(
        {
          workspaceId: WS,
          priorRuleId: 'missing',
          newRule: newRuleSeed,
          actorUserId: ACTOR,
          reason: REASON,
          applyRetroactively: false,
        },
        depsWith({ row, rule: ruleW }),
      ),
      ChannelRuleSupersessionError,
      'rule_not_found',
    )
  })

  it('rejects workspace_mismatch on prior rule', async () => {
    const ruleW = makeRuleRepo({ rule: rule({ workspaceId: 'ws-2' }) })
    const row = makeRowRepo()
    await expectError(
      supersedeChannelSensitivityRule(
        {
          workspaceId: WS,
          priorRuleId: 'rule-prior',
          newRule: newRuleSeed,
          actorUserId: ACTOR,
          reason: REASON,
          applyRetroactively: false,
        },
        depsWith({ row, rule: ruleW }),
      ),
      ChannelRuleSupersessionError,
      'workspace_mismatch',
    )
  })

  it('rejects rule_already_superseded', async () => {
    const ruleW = makeRuleRepo({
      rule: rule({ supersededAt: new Date('2026-04-01'), supersededBy: 'other' }),
    })
    const row = makeRowRepo()
    await expectError(
      supersedeChannelSensitivityRule(
        {
          workspaceId: WS,
          priorRuleId: 'rule-prior',
          newRule: newRuleSeed,
          actorUserId: ACTOR,
          reason: REASON,
          applyRetroactively: false,
        },
        depsWith({ row, rule: ruleW }),
      ),
      ChannelRuleSupersessionError,
      'rule_already_superseded',
    )
  })

  it('rejects reason_required', async () => {
    const ruleW = makeRuleRepo()
    const row = makeRowRepo()
    await expectError(
      supersedeChannelSensitivityRule(
        {
          workspaceId: WS,
          priorRuleId: 'rule-prior',
          newRule: newRuleSeed,
          actorUserId: ACTOR,
          reason: '',
          applyRetroactively: false,
        },
        depsWith({ row, rule: ruleW }),
      ),
      ChannelRuleSupersessionError,
      'reason_required',
    )
  })

  it('rejects when ruleRepo is missing from deps', async () => {
    const row = makeRowRepo()
    await expectError(
      supersedeChannelSensitivityRule(
        {
          workspaceId: WS,
          priorRuleId: 'rule-prior',
          newRule: newRuleSeed,
          actorUserId: ACTOR,
          reason: REASON,
          applyRetroactively: false,
        },
        { rowRepo: row.repo },
      ),
      ChannelRuleSupersessionError,
      'rule_not_found',
    )
  })
})
