/**
 * Task admission gate tests.
 *
 * Spec: docs/architecture/features/task-guardrails.md
 *
 * The similarity fixtures are the REAL production duplicates from workspace
 * 3ccdb5fe (2026-07-27), with their measured pg_trgm scores. They are the
 * calibration for the thresholds, so a threshold change that breaks the
 * separation breaks these tests.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  HELD_CANDIDATE_TTL_DAYS,
  DROPPED_CANDIDATE_TTL_DAYS,
  admitTask,
  buildTaskPolicyPromptBlock,
  evaluateTaskAdmission,
  matchesPredicate,
  normalizeTaskTitle,
  proposeRuleFromTombstones,
  significantTokens,
  unsatisfiedRequirement,
  validateRulePredicate,
  verifyTaskEvidenceQuote,
  type ScoredTask,
  type ScoredTombstone,
  type TaskAdmissionCandidate,
  type RecordCandidateInput,
  type TaskAdmissionPort,
  type TaskRuleRecord,
  type TaskReadinessAssessment,
  type TaskTombstoneRecord,
} from '../admission.js'

function candidate(over: Partial<TaskAdmissionCandidate> = {}): TaskAdmissionCandidate {
  return {
    workspaceId: 'ws-1',
    title: 'Revise daily standup workflow',
    lane: 'extracted',
    sourceKind: 'slack_thread',
    ...over,
  }
}

function rule(over: Partial<TaskRuleRecord> = {}): TaskRuleRecord {
  return {
    id: 'rule-1',
    workspaceId: 'ws-1',
    status: 'active',
    effect: 'deny',
    predicate: {},
    nlClause: null,
    reason: null,
    origin: 'user',
    createdAt: new Date('2026-07-27T00:00:00Z'),
    ...over,
  }
}

function tombstone(over: Partial<TaskTombstoneRecord> = {}): TaskTombstoneRecord {
  return {
    id: 'tomb-1',
    workspaceId: 'ws-1',
    title: 'List tasks',
    titleNorm: 'list tasks',
    reason: 'this was me asking you to do something, not a work item',
    sourceKind: 'slack_thread',
    lane: 'extracted',
    createdAt: new Date('2026-07-27T09:00:00Z'),
    ...over,
  }
}

function quality(over: Partial<TaskReadinessAssessment> = {}): TaskReadinessAssessment {
  return {
    classification: 'ready',
    evidenceQuote: 'Ship the pricing page update by Friday',
    evidenceVerified: true,
    commitment: 'explicit',
    objective: 'Ship the pricing page update',
    target: 'Pricing page',
    description: 'Update the pricing page and ship it by Friday. Done when the updated page is live.',
    startingPointKind: 'discoverable',
    startingPoint: 'Open the pricing page project and locate the current page implementation.',
    completionSignal: 'The updated pricing page is live.',
    missing: [],
    explanation: 'Explicit assignment with a resolvable target and completion signal.',
    ...over,
  }
}

const NO_MATCHES = { tombstoneMatches: [] as ScoredTombstone[], taskMatches: [] as ScoredTask[] }

describe('[COMP:tasks/admission] normalizeTaskTitle', () => {
  it('folds case, punctuation and whitespace so the 07-27 duplicates collapse', () => {
    expect(normalizeTaskTitle('Integrate Shopify')).toBe('integrate shopify')
    expect(normalizeTaskTitle('integrate shopify')).toBe('integrate shopify')
    expect(normalizeTaskTitle('Change to Gemini Flash 3.6 for max')).toBe(
      'change to gemini flash 3 6 for max',
    )
  })

  it('keeps CJK characters — the extractor writes non-Latin titles too', () => {
    expect(normalizeTaskTitle('跟進價錢')).toBe('跟進價錢')
  })

  it('keeps the leading verb, which is the only thing separating opposite tasks', () => {
    // "review the deck" and "delete the deck" must not normalize together.
    expect(normalizeTaskTitle('Review the deck')).not.toBe(normalizeTaskTitle('Delete the deck'))
  })

  it('returns empty for a title with no word characters', () => {
    expect(normalizeTaskTitle('!!! ???')).toBe('')
  })
})

describe('[COMP:tasks/admission] significantTokens', () => {
  it('drops stopwords and short tokens so proposed rules stay narrow', () => {
    expect(significantTokens('revise the daily standup workflow')).toEqual([
      'revise',
      'daily',
      'standup',
      'workflow',
    ])
  })
})

describe('[COMP:tasks/admission] matchesPredicate', () => {
  it('ANDs conditions and ORs within a condition', () => {
    const p = { source_kinds: ['slack_thread', 'web_chat'], lanes: ['extracted' as const] }
    expect(matchesPredicate(p, candidate())).toBe(true)
    expect(matchesPredicate(p, candidate({ sourceKind: 'github_sync' }))).toBe(false)
    expect(matchesPredicate(p, candidate({ lane: 'assistant' }))).toBe(false)
  })

  it('treats an absent condition as "don\'t care"', () => {
    expect(matchesPredicate({}, candidate())).toBe(true)
  })

  it('matches title_matches against the NORMALIZED title', () => {
    // Raw title has different case + punctuation than the needle.
    expect(
      matchesPredicate({ title_matches: ['standup'] }, candidate({ title: 'Revise THE Standup!' })),
    ).toBe(true)
    expect(matchesPredicate({ title_matches: ['shopify'] }, candidate())).toBe(false)
  })

  it('does not match a source_kinds rule against a candidate with no source', () => {
    expect(
      matchesPredicate({ source_kinds: ['slack_thread'] }, candidate({ sourceKind: null })),
    ).toBe(false)
  })
})

describe('[COMP:tasks/admission] validateRulePredicate', () => {
  it('rejects a deny rule with no conditions — it would block every task', () => {
    expect(validateRulePredicate('deny', {})).toMatch(/at least one condition/)
  })

  it('rejects a require rule with no requirements — it would be a no-op', () => {
    expect(validateRulePredicate('require', { source_kinds: ['slack_thread'] })).toMatch(
      /at least one requirement/,
    )
  })

  it('accepts well-formed rules', () => {
    expect(validateRulePredicate('deny', { title_matches: ['standup'] })).toBeNull()
    expect(validateRulePredicate('require', { require: ['assignee'] })).toBeNull()
    expect(validateRulePredicate('require', { require: ['agent_ready'] })).toBeNull()
  })
})

describe('[COMP:tasks/admission] unsatisfiedRequirement', () => {
  it('reports the first missing field', () => {
    expect(unsatisfiedRequirement({ require: ['assignee'] }, candidate())).toBe('assignee')
    expect(unsatisfiedRequirement({ require: ['due'] }, candidate())).toBe('due')
  })

  it('returns null when satisfied', () => {
    expect(
      unsatisfiedRequirement(
        { require: ['assignee', 'due'] },
        candidate({ assigneeId: 'm-1', due: new Date() }),
      ),
    ).toBeNull()
    expect(
      unsatisfiedRequirement(
        { require: ['description', 'resolved_target', 'explicit_commitment', 'completion_signal', 'agent_ready'] },
        candidate({ quality: quality() }),
      ),
    ).toBeNull()
  })

  it('enforces workspace readiness requirements deterministically', () => {
    expect(
      unsatisfiedRequirement(
        { require: ['agent_ready'] },
        candidate({ quality: quality({ completionSignal: null }) }),
      ),
    ).toBe('agent_ready')
  })
})

describe('[COMP:tasks/admission] grounded evidence', () => {
  it('accepts only a quote present in the source after whitespace canonicalisation', () => {
    expect(
      verifyTaskEvidenceQuote('Ashley: Ship the pricing page\nupdate by Friday', 'Ship the pricing page update by Friday'),
    ).toBe(true)
    expect(verifyTaskEvidenceQuote('Ashley: maybe later', 'Ship the pricing page')).toBe(false)
  })
})

describe('[COMP:tasks/admission] evaluateTaskAdmission — decision table', () => {
  it('allows a clean candidate', () => {
    expect(evaluateTaskAdmission({ candidate: candidate(), rules: [], ...NO_MATCHES })).toEqual({
      outcome: 'allow',
    })
  })

  it('drops the production slop shape "pull a group" when the grounded commitment is hedged', () => {
    const decision = evaluateTaskAdmission({
      candidate: candidate({
        title: 'Pull a group',
        quality: quality({
          classification: 'not_a_task',
          evidenceQuote: 'i pull a group maybe',
          commitment: 'hedged',
          objective: null,
          target: null,
          description: null,
          startingPointKind: 'missing',
          startingPoint: null,
          completionSignal: null,
          missing: ['commitment', 'objective', 'target', 'description', 'starting_point', 'completion_signal'],
          explanation: 'The speaker hedged with "maybe" and did not identify the group or purpose.',
        }),
      }),
      rules: [],
      ...NO_MATCHES,
    })
    expect(decision.outcome).toBe('drop')
    if (decision.outcome === 'drop') expect(decision.reasonCode).toBe('not_a_task')
  })

  it('holds a real but underspecified commitment instead of creating slop', () => {
    const decision = evaluateTaskAdmission({
      candidate: candidate({
        title: 'Pull a group',
        quality: quality({
          classification: 'needs_spec',
          objective: 'Pull a group',
          target: null,
          description: null,
          startingPointKind: 'missing',
          startingPoint: null,
          completionSignal: null,
          missing: ['target', 'description', 'starting_point', 'completion_signal'],
          explanation: 'The commitment is explicit but the intended group and success condition are missing.',
        }),
      }),
      rules: [],
      ...NO_MATCHES,
    })
    expect(decision.outcome).toBe('hold')
    if (decision.outcome === 'hold') expect(decision.reasonCode).toBe('needs_spec')
  })

  it('fails closed when the judge evidence cannot be verified', () => {
    const decision = evaluateTaskAdmission({
      candidate: candidate({ quality: quality({ evidenceVerified: false, missing: ['evidence'] }) }),
      rules: [],
      ...NO_MATCHES,
    })
    expect(decision.outcome).toBe('hold')
    if (decision.outcome === 'hold') expect(decision.reasonCode).toBe('quality_unverified')
  })

  it('allows a grounded agent-ready automatic task', () => {
    expect(
      evaluateTaskAdmission({
        candidate: candidate({ quality: quality() }),
        rules: [],
        ...NO_MATCHES,
      }),
    ).toEqual({ outcome: 'allow' })
  })

  it('drops a tombstoned title and quotes the user\'s own reason back', () => {
    const decision = evaluateTaskAdmission({
      candidate: candidate({ title: 'List tasks' }),
      rules: [],
      tombstoneMatches: [{ tombstone: tombstone(), similarity: 1.0 }],
      taskMatches: [],
    })
    expect(decision.outcome).toBe('drop')
    if (decision.outcome === 'drop') {
      expect(decision.reasonCode).toBe('tombstoned')
      expect(decision.matchedTombstoneId).toBe('tomb-1')
      expect(decision.explanation).toContain('not a work item')
    }
  })

  it('ignores a tombstone below the match threshold', () => {
    const decision = evaluateTaskAdmission({
      candidate: candidate(),
      rules: [],
      tombstoneMatches: [{ tombstone: tombstone(), similarity: 0.5 }],
      taskMatches: [],
    })
    expect(decision.outcome).toBe('allow')
  })

  it('drops on a matching deny rule and names the clause for relay', () => {
    const decision = evaluateTaskAdmission({
      candidate: candidate(),
      rules: [
        rule({
          predicate: { title_matches: ['standup'] },
          nlClause: "Don't create tasks from standup chatter",
        }),
      ],
      ...NO_MATCHES,
    })
    expect(decision.outcome).toBe('drop')
    if (decision.outcome === 'drop') {
      expect(decision.reasonCode).toBe('rule')
      expect(decision.explanation).toContain('standup chatter')
    }
  })

  it('ignores a non-matching deny rule', () => {
    const decision = evaluateTaskAdmission({
      candidate: candidate(),
      rules: [rule({ predicate: { source_kinds: ['github_sync'] } })],
      ...NO_MATCHES,
    })
    expect(decision.outcome).toBe('allow')
  })

  it('holds when a require rule is unsatisfied', () => {
    const decision = evaluateTaskAdmission({
      candidate: candidate(),
      rules: [rule({ effect: 'require', predicate: { require: ['assignee'] } })],
      ...NO_MATCHES,
    })
    expect(decision.outcome).toBe('hold')
    if (decision.outcome === 'hold') expect(decision.reasonCode).toBe('rule_requires')
  })

  it('allows when the require rule is satisfied', () => {
    const decision = evaluateTaskAdmission({
      candidate: candidate({ assigneeId: 'm-1' }),
      rules: [rule({ effect: 'require', predicate: { require: ['assignee'] } })],
      ...NO_MATCHES,
    })
    expect(decision.outcome).toBe('allow')
  })

  // ── Calibration against the real 2026-07-27 duplicates ────────────────────

  it('drops an exact-modulo-case duplicate (measured 1.00)', () => {
    const decision = evaluateTaskAdmission({
      candidate: candidate({ title: 'Integrate Shopify' }),
      rules: [],
      tombstoneMatches: [],
      taskMatches: [{ id: 'task-9', title: 'integrate shopify', similarity: 1.0 }],
    })
    expect(decision.outcome).toBe('drop')
    if (decision.outcome === 'drop') {
      expect(decision.reasonCode).toBe('duplicate')
      expect(decision.matchedTaskId).toBe('task-9')
    }
  })

  it('drops the "Revise (the) daily standup workflow" pair (measured 0.88)', () => {
    const decision = evaluateTaskAdmission({
      candidate: candidate({ title: 'Revise the daily standup workflow' }),
      rules: [],
      tombstoneMatches: [],
      taskMatches: [{ id: 'task-3', title: 'Revise daily standup workflow', similarity: 0.88 }],
    })
    expect(decision.outcome).toBe('drop')
  })

  it('HOLDS a differently-worded true duplicate rather than dropping it (measured 0.67)', () => {
    // 'Fix GitHub integration 401…' vs 'Resolve GitHub connector 401…' — a real
    // duplicate, but too far from the 0.59 non-duplicate below to drop safely.
    const decision = evaluateTaskAdmission({
      candidate: candidate({
        title: "Fix GitHub integration 401 'Bad credentials' error to restore automated development summaries",
      }),
      rules: [],
      tombstoneMatches: [],
      taskMatches: [
        {
          id: 'task-7',
          title:
            'Resolve GitHub connector 401 Bad Credentials error to resume automated development summaries',
          similarity: 0.67,
        },
      ],
    })
    expect(decision.outcome).toBe('hold')
    if (decision.outcome === 'hold') expect(decision.reasonCode).toBe('near_duplicate')
  })

  it('ALLOWS two distinct tasks that share a sentence template (measured 0.59)', () => {
    // The regression that matters: 'Start trial with Erwin (mostly Teams
    // integration)' and '…Ashley (mostly Shopify integration)' are different
    // work. A single threshold low enough to catch 0.67 would eat this.
    const decision = evaluateTaskAdmission({
      candidate: candidate({ title: 'Start trial with Erwin (mostly Teams integration)' }),
      rules: [],
      tombstoneMatches: [],
      taskMatches: [
        {
          id: 'task-5',
          title: 'Start trial with Ashley (mostly Shopify integration)',
          similarity: 0.59,
        },
      ],
    })
    expect(decision.outcome).toBe('allow')
  })

  it('checks tombstones before rules before duplicates', () => {
    // All three fire; the tombstone (an explicit human "no") must win.
    const decision = evaluateTaskAdmission({
      candidate: candidate(),
      rules: [rule({ predicate: {}, nlClause: 'rule' })],
      tombstoneMatches: [{ tombstone: tombstone(), similarity: 0.9 }],
      taskMatches: [{ id: 'task-1', title: 'x', similarity: 1.0 }],
    })
    expect(decision.outcome === 'drop' && decision.reasonCode).toBe('tombstoned')
  })

  it('picks the highest-scoring match when several are above threshold', () => {
    const decision = evaluateTaskAdmission({
      candidate: candidate(),
      rules: [],
      tombstoneMatches: [],
      taskMatches: [
        { id: 'low', title: 'a', similarity: 0.7 },
        { id: 'high', title: 'b', similarity: 0.95 },
      ],
    })
    expect(decision.outcome === 'drop' && decision.matchedTaskId).toBe('high')
  })
})

describe('[COMP:tasks/admission] admitTask — lane asymmetry', () => {
  function port(over: Partial<TaskAdmissionPort> = {}): TaskAdmissionPort {
    return {
      listActiveRules: vi.fn(async () => []),
      findSimilarTombstones: vi.fn(async () => []),
      findSimilarTasks: vi.fn(async () => []),
      recordCandidate: vi.fn(async () => {}),
      ...over,
    }
  }

  it('records a held candidate with the 14-day TTL on the extracted lane', async () => {
    const recordCandidate = vi.fn(async (_input: RecordCandidateInput) => {})
    const now = new Date('2026-07-27T09:00:00Z')
    const result = await admitTask(
      port({
        recordCandidate,
        findSimilarTasks: async () => [{ id: 't-1', title: 'similar', similarity: 0.7 }],
      }),
      candidate(),
      now,
    )

    expect(result.admitted).toBe(false)
    expect(result.outcome).toBe('hold')
    expect(recordCandidate).toHaveBeenCalledOnce()
    const arg = recordCandidate.mock.calls[0][0]
    expect(arg.status).toBe('pending')
    expect(arg.reasonCode).toBe('near_duplicate')
    expect(arg.similarity).toBe(0.7)
    expect(arg.expiresAt.getTime()).toBe(
      now.getTime() + HELD_CANDIDATE_TTL_DAYS * 86_400_000,
    )
  })

  it('records a dropped candidate with the 90-day audit TTL', async () => {
    const recordCandidate = vi.fn(async (_input: RecordCandidateInput) => {})
    const now = new Date('2026-07-27T09:00:00Z')
    await admitTask(
      port({
        recordCandidate,
        findSimilarTasks: async () => [{ id: 't-1', title: 'dup', similarity: 0.95 }],
      }),
      candidate(),
      now,
    )
    const arg = recordCandidate.mock.calls[0][0]
    expect(arg.status).toBe('dropped')
    expect(arg.expiresAt.getTime()).toBe(
      now.getTime() + DROPPED_CANDIDATE_TTL_DAYS * 86_400_000,
    )
  })

  it('collapses a hold to allow-with-warning on the assistant lane', async () => {
    // The user asked directly — a review tray would be a non-answer.
    const recordCandidate = vi.fn(async (_input: RecordCandidateInput) => {})
    const result = await admitTask(
      port({
        recordCandidate,
        findSimilarTasks: async () => [{ id: 't-1', title: 'similar', similarity: 0.7 }],
      }),
      candidate({ lane: 'assistant' }),
    )
    expect(result.admitted).toBe(true)
    expect(result.outcome).toBe('allow')
    expect(result.outcome === 'allow' && result.warning?.matchedTaskId).toBe('t-1')
    expect(recordCandidate).not.toHaveBeenCalled()
  })

  it('still drops on the assistant lane when the user already rejected it', async () => {
    const result = await admitTask(
      port({
        findSimilarTombstones: async () => [{ tombstone: tombstone(), similarity: 0.9 }],
      }),
      candidate({ lane: 'assistant' }),
    )
    expect(result.admitted).toBe(false)
  })

  it('only filters on ACTIVE rules — a proposed rule is inert', async () => {
    const result = await admitTask(
      port({
        listActiveRules: async () => [
          rule({ status: 'proposed', predicate: { title_matches: ['standup'] } }),
        ],
      }),
      candidate(),
    )
    expect(result.admitted).toBe(true)
  })

  it('allows an empty title without touching the database', async () => {
    const listActiveRules = vi.fn(async () => [])
    const result = await admitTask(port({ listActiveRules }), candidate({ title: '???' }))
    expect(result.admitted).toBe(true)
    expect(listActiveRules).not.toHaveBeenCalled()
  })

  it('never loses the task when the audit write fails', async () => {
    // Losing an audit row beats losing a user's work; a recordCandidate throw
    // must not propagate.
    const result = await admitTask(
      port({
        recordCandidate: async () => {
          throw new Error('db down')
        },
        findSimilarTasks: async () => [{ id: 't-1', title: 'dup', similarity: 0.95 }],
      }),
      candidate(),
    )
    expect(result.admitted).toBe(false)
    expect(result.outcome).toBe('drop')
  })
})

describe('[COMP:tasks/admission] buildTaskPolicyPromptBlock', () => {
  it('returns empty when the workspace has stated no policy', () => {
    // Byte-identical prompt for every workspace that has not opted in.
    expect(buildTaskPolicyPromptBlock([], [])).toBe('')
  })

  it('renders active clauses and recent rejections as negative examples', () => {
    const block = buildTaskPolicyPromptBlock(
      [rule({ nlClause: "Don't create tasks from standup acknowledgements" })],
      [tombstone()],
    )
    expect(block).toContain("Don't create tasks from standup acknowledgements")
    expect(block).toContain('Rejected: "List tasks"')
    expect(block).toContain('not a work item')
  })

  it('renders a shared bulk-delete reason only once', () => {
    const shared = 'Slack discussion about existing work is not a new task'
    const block = buildTaskPolicyPromptBlock(
      [
        rule({ id: 'r1', nlClause: shared }),
        rule({ id: 'r2', nlClause: shared }),
        rule({ id: 'r3', nlClause: 'Do not turn acknowledgements into tasks' }),
      ],
      [],
    )
    expect(block.match(new RegExp(shared, 'g'))).toHaveLength(1)
    expect(block).toContain('Do not turn acknowledgements into tasks')
  })

  it('shows relevant open tasks as already tracked work', () => {
    const block = buildTaskPolicyPromptBlock([], [], [
      { id: 'task-1', title: 'Integrate Teams', similarity: 0.875 },
    ])
    expect(block).toContain('Already-tracked open tasks relevant to this source')
    expect(block).toContain('Already tracked: "Integrate Teams"')
    expect(block).toContain('is not a new task')
  })

  it('skips rules that are not active or have no sentence', () => {
    expect(
      buildTaskPolicyPromptBlock(
        [
          rule({ status: 'proposed', nlClause: 'proposed clause' }),
          rule({ id: 'r2', nlClause: null }),
        ],
        [],
      ),
    ).toBe('')
  })

  it('caps the block so it cannot become a second system prompt', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      tombstone({ id: `t${i}`, title: `title ${i}`, reason: `reason ${i}` }),
    )
    const block = buildTaskPolicyPromptBlock([], many)
    expect(block.match(/Rejected:/g)).toHaveLength(8)

    const openTasks = Array.from({ length: 30 }, (_, i) => ({
      id: `task-${i}`,
      title: `Task ${i}`,
      similarity: 0.8,
    }))
    const trackedBlock = buildTaskPolicyPromptBlock([], [], openTasks)
    expect(trackedBlock.match(/Already tracked:/g)).toHaveLength(8)
  })
})

describe('[COMP:tasks/admission] proposeRuleFromTombstones', () => {
  const sim = (a: string, b: string) => {
    const at = new Set(a.split(' '))
    const bt = new Set(b.split(' '))
    const shared = [...at].filter((t) => bt.has(t)).length
    return shared / Math.max(at.size, bt.size)
  }

  const standup = (id: string, title: string) =>
    tombstone({ id, title, titleNorm: normalizeTaskTitle(title) })

  it('proposes nothing below the threshold of three', () => {
    const trigger = standup('t1', 'Revise daily standup workflow')
    expect(proposeRuleFromTombstones(trigger, [standup('t2', 'Revise daily standup')], sim)).toBeNull()
  })

  it('proposes a scoped rule from a tight cluster of three', () => {
    const trigger = standup('t1', 'Revise daily standup workflow')
    const proposal = proposeRuleFromTombstones(
      trigger,
      [
        standup('t2', 'Revise daily standup notes'),
        standup('t3', 'Revise daily standup agenda'),
      ],
      sim,
    )
    expect(proposal).not.toBeNull()
    expect(proposal!.predicate.source_kinds).toEqual(['slack_thread'])
    expect(proposal!.predicate.title_matches).toEqual(
      expect.arrayContaining(['standup', 'daily', 'revise']),
    )
    expect(proposal!.tombstoneIds).toHaveLength(3)
  })

  it('refuses to guess when the cluster shares fewer than two content words', () => {
    // Three rejections with nothing in common must not become a rule that
    // suppresses an entire source.
    const trigger = standup('t1', 'Upgrade the billing plan')
    const proposal = proposeRuleFromTombstones(
      trigger,
      [standup('t2', 'Upgrade something else'), standup('t3', 'Upgrade whatever')],
      () => 1,
    )
    expect(proposal).toBeNull()
  })

  it('does not cluster across different sources', () => {
    const trigger = standup('t1', 'Revise daily standup workflow')
    const proposal = proposeRuleFromTombstones(
      trigger,
      [
        { ...standup('t2', 'Revise daily standup notes'), sourceKind: 'github_sync' },
        { ...standup('t3', 'Revise daily standup agenda'), sourceKind: 'web_chat' },
      ],
      sim,
    )
    expect(proposal).toBeNull()
  })

  it('proposes nothing when the trigger has no source kind to scope to', () => {
    const trigger = { ...standup('t1', 'Revise daily standup workflow'), sourceKind: null }
    expect(proposeRuleFromTombstones(trigger, [], sim)).toBeNull()
  })
})
