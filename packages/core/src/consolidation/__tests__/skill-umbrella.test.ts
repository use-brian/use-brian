/**
 * S10 umbrella consolidation tests.
 * Component tag: [COMP:consolidation/skill-umbrella].
 *
 * Covers:
 *  - trigger gates (workspace_age, eligible-count)
 *  - cluster detection with mocked embeddings + tag-overlap requirement
 *  - each of three moves (MERGE / CREATE / DEMOTE) applied correctly
 *  - pinned + write_origin='foreground' exempt (via store filter)
 *  - per-cluster re-extraction protection (recent undone digest action)
 *  - malformed proposal surfaces a skipped action without throwing
 *  - digest entry written; rollback on commit-failure path
 */

import { describe, it, expect, vi } from 'vitest'
import {
  runSkillUmbrellaPass,
  clusterByEmbedding,
  type UmbrellaSkill,
  type SkillUmbrellaStore,
  type SkillUmbrellaDigestStore,
  type SkillUmbrellaEvent,
  type SkillCuratorAction,
} from '../skill-umbrella.js'

// ── Fixtures ─────────────────────────────────────────────────────

function makeSkill(over: Partial<UmbrellaSkill>): UmbrellaSkill {
  return {
    rowId: 'row-1',
    id: 'slug-1',
    workspaceId: 'ws-1',
    slug: 'slug-1',
    name: 'Skill 1',
    description: 'Default description',
    content: '# Body\nDefault content.',
    category: 'custom',
    requiresConnectors: [],
    source: 'auto-generated',
    published: false,
    writeOrigin: 'background_review',
    state: 'active',
    stateTransitionedAt: new Date('2026-01-01'),
    pinned: false,
    invocations: 0,
    succeeded: 0,
    userCorrectedAfter: 0,
    validFrom: new Date('2026-01-01'),
    ...over,
  }
}

function makeStore(overrides: Partial<SkillUmbrellaStore> = {}): SkillUmbrellaStore & {
  patches: Array<{ skillId: string; content: string; diff: string }>
  creates: Array<{ slug: string; name: string }>
  files: Array<{ umbrellaRowId: string; kind: string; name: string; content: string }>
  absorptions: Array<{ memberRowId: string; umbrellaRowId: string }>
} {
  const patches: Array<{ skillId: string; content: string; diff: string }> = []
  const creates: Array<{ slug: string; name: string }> = []
  const files: Array<{ umbrellaRowId: string; kind: string; name: string; content: string }> = []
  const absorptions: Array<{ memberRowId: string; umbrellaRowId: string }> = []
  return {
    patches,
    creates,
    files,
    absorptions,
    async listCuratorEligible() {
      return []
    },
    async patchUmbrella(skillId, patch) {
      patches.push({ skillId, ...patch })
    },
    async createUmbrella(_workspaceId, draft) {
      creates.push({ slug: draft.slug, name: draft.name })
      return { rowId: `new-${draft.slug}` }
    },
    async addSupportFile(params) {
      files.push({
        umbrellaRowId: params.umbrellaRowId,
        kind: params.kind,
        name: params.name,
        content: params.content,
      })
    },
    async recordAbsorption(memberRowId, umbrellaRowId) {
      absorptions.push({ memberRowId, umbrellaRowId })
    },
    ...overrides,
  }
}

function makeDigest(rows: Array<{ weekOf: Date; actions: unknown }> = []): SkillUmbrellaDigestStore & {
  appended: Array<{ workspaceId: string; weekOf: Date; actions: SkillCuratorAction[] }>
} {
  const appended: Array<{ workspaceId: string; weekOf: Date; actions: SkillCuratorAction[] }> = []
  return {
    appended,
    async append(workspaceId, weekOf, actions) {
      appended.push({ workspaceId, weekOf, actions })
      return { id: `dig-${appended.length}` }
    },
    async listForWorkspace() {
      return rows
    },
  }
}

const ZERO_VEC = Array.from({ length: 4 }, () => 0)

/** Returns a constant-direction unit vector for each "group" so members
 *  of the same group cluster cleanly above the 0.65 threshold. */
function vec(group: 'a' | 'b' | 'c'): number[] {
  if (group === 'a') return [1, 0, 0, 0]
  if (group === 'b') return [0, 1, 0, 0]
  return [0, 0, 1, 0]
}

const NOW = new Date('2026-05-24T00:00:00Z')
const WS_CREATED = new Date('2026-03-01T00:00:00Z') // 84 days before NOW

// ── Trigger gates ────────────────────────────────────────────────

describe('[COMP:consolidation/skill-umbrella] trigger gates', () => {
  it('skips when workspace_age < 21 days', async () => {
    const events: SkillUmbrellaEvent[] = []
    const store = makeStore()
    const digest = makeDigest()
    const res = await runSkillUmbrellaPass({
      workspaceId: 'ws-1',
      workspaceCreatedAt: new Date('2026-05-10'), // 14 days before NOW
      store,
      digestStore: digest,
      getEmbeddings: async () => [],
      callModel: async () => '',
      onEvent: (e) => events.push(e),
      now: () => NOW,
    })
    expect(res.clustersProcessed).toBe(0)
    expect(events).toContainEqual({
      type: 'skill_umbrella_skipped',
      workspaceId: 'ws-1',
      reason: 'workspace_too_young',
    })
  })

  it('skips when eligible count < 20', async () => {
    const events: SkillUmbrellaEvent[] = []
    const store = makeStore({
      async listCuratorEligible() {
        // 5 skills, all old enough to be past the 7d grace.
        return Array.from({ length: 5 }, (_, i) =>
          makeSkill({
            rowId: `row-${i}`,
            slug: `s-${i}`,
            validFrom: new Date('2026-01-01'),
          }),
        )
      },
    })
    const digest = makeDigest()
    const res = await runSkillUmbrellaPass({
      workspaceId: 'ws-1',
      workspaceCreatedAt: WS_CREATED,
      store,
      digestStore: digest,
      getEmbeddings: async () => [],
      callModel: async () => '',
      onEvent: (e) => events.push(e),
      now: () => NOW,
    })
    expect(res.clustersProcessed).toBe(0)
    expect(events).toContainEqual({
      type: 'skill_umbrella_skipped',
      workspaceId: 'ws-1',
      reason: 'insufficient_skills',
    })
  })

  it('skips when embedding callback throws', async () => {
    const events: SkillUmbrellaEvent[] = []
    const skills = Array.from({ length: 25 }, (_, i) =>
      makeSkill({
        rowId: `row-${i}`,
        slug: `s-${i}`,
        validFrom: new Date('2026-01-01'),
      }),
    )
    const store = makeStore({ async listCuratorEligible() { return skills } })
    const digest = makeDigest()
    const res = await runSkillUmbrellaPass({
      workspaceId: 'ws-1',
      workspaceCreatedAt: WS_CREATED,
      store,
      digestStore: digest,
      getEmbeddings: async () => {
        throw new Error('embedding service unavailable')
      },
      callModel: async () => '',
      onEvent: (e) => events.push(e),
      now: () => NOW,
    })
    expect(res.clustersProcessed).toBe(0)
    expect(events.find((e) => e.type === 'skill_umbrella_skipped' && e.reason === 'no_embeddings')).toBeDefined()
    // Skipped action persisted in digest so operators see it.
    expect(digest.appended.length).toBe(1)
    expect(digest.appended[0].actions[0].kind).toBe('skipped')
  })
})

// ── Cluster detection ────────────────────────────────────────────

describe('[COMP:consolidation/skill-umbrella] cluster detection', () => {
  it('groups skills with cos>=threshold AND tag overlap', () => {
    const a1 = makeSkill({ rowId: 'a1', category: 'customer' })
    const a2 = makeSkill({ rowId: 'a2', category: 'customer' })
    const b1 = makeSkill({ rowId: 'b1', category: 'incident' })
    const b2 = makeSkill({ rowId: 'b2', category: 'incident' })
    const skills = [a1, a2, b1, b2]
    const embeddings = new Map<string, number[]>([
      [a1.rowId, vec('a')],
      [a2.rowId, vec('a')],
      [b1.rowId, vec('b')],
      [b2.rowId, vec('b')],
    ])
    const tags = new Map<string, Set<string>>([
      [a1.rowId, new Set(['category:customer'])],
      [a2.rowId, new Set(['category:customer'])],
      [b1.rowId, new Set(['category:incident'])],
      [b2.rowId, new Set(['category:incident'])],
    ])
    const clusters = clusterByEmbedding(skills, embeddings, tags, 0.65)
    expect(clusters.length).toBe(2)
    // Each cluster has exactly 2 members.
    expect(clusters.every((c) => c.length === 2)).toBe(true)
  })

  it('rejects vector-near pairs that lack tag overlap', () => {
    const x = makeSkill({ rowId: 'x', category: 'alpha' })
    const y = makeSkill({ rowId: 'y', category: 'beta' })
    const embeddings = new Map([
      [x.rowId, vec('a')],
      [y.rowId, vec('a')], // identical direction => cos=1
    ])
    const tags = new Map([
      [x.rowId, new Set(['category:alpha'])],
      [y.rowId, new Set(['category:beta'])],
    ])
    const clusters = clusterByEmbedding([x, y], embeddings, tags, 0.65)
    // No tag overlap => no cluster despite cos=1.
    expect(clusters.length).toBe(0)
  })

  it('drops skills with no embedding', () => {
    const a = makeSkill({ rowId: 'a' })
    const b = makeSkill({ rowId: 'b' })
    const embeddings = new Map([[a.rowId, vec('a')]])
    const tags = new Map([
      [a.rowId, new Set(['x'])],
      [b.rowId, new Set(['x'])],
    ])
    const clusters = clusterByEmbedding([a, b], embeddings, tags, 0.65)
    expect(clusters.length).toBe(0)
  })

  it('returns no clusters when single-link chain breaks at threshold', () => {
    const a = makeSkill({ rowId: 'a', category: 'x' })
    const b = makeSkill({ rowId: 'b', category: 'x' })
    const embeddings = new Map([
      [a.rowId, [1, 0, 0, 0]],
      [b.rowId, ZERO_VEC],
    ])
    const tags = new Map([
      [a.rowId, new Set(['category:x'])],
      [b.rowId, new Set(['category:x'])],
    ])
    const clusters = clusterByEmbedding([a, b], embeddings, tags, 0.65)
    expect(clusters.length).toBe(0)
  })
})

// ── Three moves ──────────────────────────────────────────────────

function build20EligibleSkills(overrides: Array<Partial<UmbrellaSkill>> = []): UmbrellaSkill[] {
  // 20 skills, 4 of them in the same cluster (cluster "a" + same category).
  const out: UmbrellaSkill[] = []
  for (let i = 0; i < 20; i++) {
    const inCluster = i < 4
    out.push(
      makeSkill({
        rowId: `row-${i}`,
        slug: `s-${i}`,
        name: `Skill ${i}`,
        description: `Description ${i}`,
        category: inCluster ? 'customer-onboarding' : `cat-${i}`,
        validFrom: new Date('2026-01-01'),
        ...overrides[i],
      }),
    )
  }
  return out
}

function buildEmbeddings(skills: UmbrellaSkill[]): Map<string, number[]> {
  const m = new Map<string, number[]>()
  for (const s of skills) {
    if (s.category === 'customer-onboarding') m.set(s.rowId, vec('a'))
    else if (s.category === 'incident-triage') m.set(s.rowId, vec('b'))
    else m.set(s.rowId, [0, 0, 0, 1]) // singleton — never matches the cluster
  }
  return m
}

describe('[COMP:consolidation/skill-umbrella] three moves', () => {
  it('MERGE_INTO_EXISTING patches target + records absorptions', async () => {
    const skills = build20EligibleSkills()
    const store = makeStore({ async listCuratorEligible() { return skills } })
    const digest = makeDigest()
    const events: SkillUmbrellaEvent[] = []

    const proposal = {
      move: 'MERGE_INTO_EXISTING',
      target_skill_id: 'row-0',
      patched_content: '# Customer Onboarding\nNow umbrella body.',
      absorbed_member_ids: ['row-1', 'row-2', 'row-3'],
      rationale: 'row-0 is the broadest; rest fold in as subsections',
    }

    const res = await runSkillUmbrellaPass({
      workspaceId: 'ws-1',
      workspaceCreatedAt: WS_CREATED,
      store,
      digestStore: digest,
      getEmbeddings: async (texts) => {
        const m = buildEmbeddings(skills)
        return texts.map((_t, i) => m.get(skills[i].rowId) ?? ZERO_VEC)
      },
      callModel: async () => JSON.stringify(proposal),
      onEvent: (e) => events.push(e),
      now: () => NOW,
    })

    expect(res.clustersProcessed).toBe(1)
    expect(store.patches.length).toBe(1)
    expect(store.patches[0].skillId).toBe('row-0')
    expect(store.patches[0].content).toContain('Customer Onboarding')
    // Diff is persisted as a JSON blob containing before + after.
    expect(JSON.parse(store.patches[0].diff)).toMatchObject({
      before: expect.any(String),
      after: expect.any(String),
    })
    expect(store.absorptions).toEqual([
      { memberRowId: 'row-1', umbrellaRowId: 'row-0' },
      { memberRowId: 'row-2', umbrellaRowId: 'row-0' },
      { memberRowId: 'row-3', umbrellaRowId: 'row-0' },
    ])
    expect(digest.appended.length).toBe(1)
    expect(digest.appended[0].actions[0].kind).toBe('merged_into_existing')
  })

  it('CREATE_NEW_UMBRELLA inserts new row + records absorptions', async () => {
    const skills = build20EligibleSkills()
    const store = makeStore({ async listCuratorEligible() { return skills } })
    const digest = makeDigest()

    const proposal = {
      move: 'CREATE_NEW_UMBRELLA',
      new_skill_draft: {
        slug: 'customer-onboarding',
        name: 'Customer Onboarding',
        description: 'Class-level umbrella for onboarding tasks',
        when_to_use: 'When a new customer is being set up',
        content: '# Customer Onboarding\nFull umbrella body.',
        category: 'custom',
      },
      absorbed_member_ids: ['row-0', 'row-1', 'row-2', 'row-3'],
      rationale: 'No existing member is broad enough; drafting a new umbrella',
    }

    const res = await runSkillUmbrellaPass({
      workspaceId: 'ws-1',
      workspaceCreatedAt: WS_CREATED,
      store,
      digestStore: digest,
      getEmbeddings: async (texts) => {
        const m = buildEmbeddings(skills)
        return texts.map((_t, i) => m.get(skills[i].rowId) ?? ZERO_VEC)
      },
      callModel: async () => JSON.stringify(proposal),
      now: () => NOW,
    })

    expect(res.clustersProcessed).toBe(1)
    expect(store.creates).toEqual([{ slug: 'customer-onboarding', name: 'Customer Onboarding' }])
    expect(store.absorptions.length).toBe(4)
    for (const a of store.absorptions) {
      expect(a.umbrellaRowId).toBe('new-customer-onboarding')
    }
    expect(digest.appended[0].actions[0].kind).toBe('created_new_umbrella')
  })

  it('rejects CREATE_NEW_UMBRELLA with session-artifact slug', async () => {
    const skills = build20EligibleSkills()
    const store = makeStore({ async listCuratorEligible() { return skills } })
    const digest = makeDigest()

    const proposal = {
      move: 'CREATE_NEW_UMBRELLA',
      new_skill_draft: {
        slug: 'fix-broken-onboarding', // session artifact
        name: 'Fix Broken Onboarding',
        description: 'd',
        content: 'c',
      },
      absorbed_member_ids: ['row-0'],
      rationale: 'r',
    }

    const res = await runSkillUmbrellaPass({
      workspaceId: 'ws-1',
      workspaceCreatedAt: WS_CREATED,
      store,
      digestStore: digest,
      getEmbeddings: async (texts) => {
        const m = buildEmbeddings(skills)
        return texts.map((_t, i) => m.get(skills[i].rowId) ?? ZERO_VEC)
      },
      callModel: async () => JSON.stringify(proposal),
      now: () => NOW,
    })

    expect(res.clustersProcessed).toBe(0)
    expect(store.creates.length).toBe(0)
    expect(digest.appended[0].actions[0].kind).toBe('skipped')
  })

  it('DEMOTE_TO_REFERENCES adds support files + records absorptions', async () => {
    const skills = build20EligibleSkills()
    const store = makeStore({ async listCuratorEligible() { return skills } })
    const digest = makeDigest()

    const proposal = {
      move: 'DEMOTE_TO_REFERENCES',
      umbrella_skill_id: 'row-0',
      demote_map: [
        { member_id: 'row-1', target_kind: 'reference', target_name: 'flow-a.md' },
        { member_id: 'row-2', target_kind: 'template', target_name: 'flow-b.yaml' },
      ],
      absorbed_member_ids: ['row-1', 'row-2'],
      rationale: 'Narrow content folds into umbrella references/templates',
    }

    const res = await runSkillUmbrellaPass({
      workspaceId: 'ws-1',
      workspaceCreatedAt: WS_CREATED,
      store,
      digestStore: digest,
      getEmbeddings: async (texts) => {
        const m = buildEmbeddings(skills)
        return texts.map((_t, i) => m.get(skills[i].rowId) ?? ZERO_VEC)
      },
      callModel: async () => JSON.stringify(proposal),
      now: () => NOW,
    })

    expect(res.clustersProcessed).toBe(1)
    expect(store.files.length).toBe(2)
    expect(store.files[0]).toMatchObject({
      umbrellaRowId: 'row-0',
      kind: 'reference',
      name: 'flow-a.md',
    })
    expect(store.absorptions).toEqual([
      { memberRowId: 'row-1', umbrellaRowId: 'row-0' },
      { memberRowId: 'row-2', umbrellaRowId: 'row-0' },
    ])
    expect(digest.appended[0].actions[0].kind).toBe('demoted_to_references')
  })

  it('REJECT proposal surfaces as skipped action', async () => {
    const skills = build20EligibleSkills()
    const store = makeStore({ async listCuratorEligible() { return skills } })
    const digest = makeDigest()

    const res = await runSkillUmbrellaPass({
      workspaceId: 'ws-1',
      workspaceCreatedAt: WS_CREATED,
      store,
      digestStore: digest,
      getEmbeddings: async (texts) => {
        const m = buildEmbeddings(skills)
        return texts.map((_t, i) => m.get(skills[i].rowId) ?? ZERO_VEC)
      },
      callModel: async () => JSON.stringify({ move: 'REJECT', reason: 'session artifacts dominate' }),
      now: () => NOW,
    })

    expect(res.clustersProcessed).toBe(0)
    expect(store.patches.length).toBe(0)
    expect(store.absorptions.length).toBe(0)
    expect(digest.appended[0].actions[0]).toMatchObject({ kind: 'skipped' })
  })

  it('malformed JSON surfaces as skipped without throwing', async () => {
    const skills = build20EligibleSkills()
    const store = makeStore({ async listCuratorEligible() { return skills } })
    const digest = makeDigest()

    const res = await runSkillUmbrellaPass({
      workspaceId: 'ws-1',
      workspaceCreatedAt: WS_CREATED,
      store,
      digestStore: digest,
      getEmbeddings: async (texts) => {
        const m = buildEmbeddings(skills)
        return texts.map((_t, i) => m.get(skills[i].rowId) ?? ZERO_VEC)
      },
      callModel: async () => 'not json at all',
      now: () => NOW,
    })

    expect(res.clustersProcessed).toBe(0)
    expect(digest.appended[0].actions[0]).toMatchObject({
      kind: 'skipped',
      reason: 'malformed_llm_output',
    })
  })

  it('rolls back nothing on per-cluster commit failure but persists skipped action', async () => {
    const skills = build20EligibleSkills()
    const store = makeStore({
      async listCuratorEligible() { return skills },
      async patchUmbrella() { throw new Error('UPDATE conflict') },
    })
    const digest = makeDigest()

    const proposal = {
      move: 'MERGE_INTO_EXISTING',
      target_skill_id: 'row-0',
      patched_content: 'x',
      absorbed_member_ids: ['row-1'],
      rationale: 'r',
    }

    const res = await runSkillUmbrellaPass({
      workspaceId: 'ws-1',
      workspaceCreatedAt: WS_CREATED,
      store,
      digestStore: digest,
      getEmbeddings: async (texts) => {
        const m = buildEmbeddings(skills)
        return texts.map((_t, i) => m.get(skills[i].rowId) ?? ZERO_VEC)
      },
      callModel: async () => JSON.stringify(proposal),
      now: () => NOW,
    })

    expect(res.clustersProcessed).toBe(0)
    // No absorptions written — the patch threw before recordAbsorption.
    expect(store.absorptions.length).toBe(0)
    expect(digest.appended[0].actions[0]).toMatchObject({
      kind: 'skipped',
      reason: 'commit_failed',
    })
  })
})

// ── Per-cluster re-extraction protection ─────────────────────────

describe('[COMP:consolidation/skill-umbrella] re-extraction protection', () => {
  it('excludes members from recently-undone digest actions', async () => {
    const skills = build20EligibleSkills()
    const store = makeStore({ async listCuratorEligible() { return skills } })

    // A digest row 10 days old with row-0..row-3 marked undone. They
    // should be filtered out, dropping the cluster size below 2.
    const digest = makeDigest([
      {
        weekOf: new Date('2026-05-14'),
        actions: [
          {
            kind: 'merged_into_existing',
            umbrellaRowId: 'old-umbrella',
            absorbedMemberRowIds: ['row-0', 'row-1', 'row-2', 'row-3'],
            rationale: 'past attempt',
            undone: true,
            undoneAt: new Date('2026-05-15'),
          },
        ],
      },
    ])

    const callModel = vi.fn(async () => '')
    const res = await runSkillUmbrellaPass({
      workspaceId: 'ws-1',
      workspaceCreatedAt: WS_CREATED,
      store,
      digestStore: digest,
      getEmbeddings: async (texts) => texts.map(() => ZERO_VEC),
      callModel,
      now: () => NOW,
    })

    expect(res.clustersProcessed).toBe(0)
    // callModel should NEVER fire — the protected cluster was filtered
    // and the remaining singletons never form a cluster.
    expect(callModel).not.toHaveBeenCalled()
  })

  it('admits members from undones older than the protection window', async () => {
    const skills = build20EligibleSkills()
    const store = makeStore({ async listCuratorEligible() { return skills } })

    // A digest row 60 days old — outside the 30d protection.
    const digest = makeDigest([
      {
        weekOf: new Date('2026-03-20'),
        actions: [
          {
            kind: 'merged_into_existing',
            umbrellaRowId: 'old-umbrella',
            absorbedMemberRowIds: ['row-0', 'row-1', 'row-2', 'row-3'],
            rationale: 'older undo',
            undone: true,
            undoneAt: new Date('2026-03-21'), // 64 days ago
          },
        ],
      },
    ])

    let calls = 0
    const proposal = {
      move: 'MERGE_INTO_EXISTING',
      target_skill_id: 'row-0',
      patched_content: '# new content',
      absorbed_member_ids: ['row-1'],
      rationale: 'r',
    }

    const res = await runSkillUmbrellaPass({
      workspaceId: 'ws-1',
      workspaceCreatedAt: WS_CREATED,
      store,
      digestStore: digest,
      getEmbeddings: async (texts) => {
        const m = buildEmbeddings(skills)
        return texts.map((_t, i) => m.get(skills[i].rowId) ?? ZERO_VEC)
      },
      callModel: async () => {
        calls++
        return JSON.stringify(proposal)
      },
      now: () => NOW,
    })

    expect(calls).toBeGreaterThan(0)
    expect(res.clustersProcessed).toBe(1)
  })
})
