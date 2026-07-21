import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import pg from 'pg'
import type {
  LLMProvider,
  Message,
  ProviderSession,
  RetrievalActor,
  SessionOptions,
  StreamChunk,
  Tool,
  WorkspaceDirectoryStore,
} from '@use-brian/core'
import { createCrmTools, createTaskTools, createDocTools } from '@use-brian/core'

/**
 * DB-integration proof of the REAL structural-synthesis engine
 * (`synthesizeFromSource`) against the local `Use Brian` Postgres, driven by a
 * scripted mock provider. This is the closest local proof of recording-to-brain's
 * end-to-end behaviour: it wires the production deps (real saved-view / crm / task
 * / workflow-run stores, the real `searchRecording` source tool over seeded
 * `transcript_segments`, the real core save* + doc tools) and asserts the
 * DB-observable outcomes the live ingest seam produces. It skips ONLY the GCS
 * upload + Gemini transcription front-end (the separate, already-shipped substrate)
 * — segments are seeded directly via `insertTranscriptSegments`.
 *
 * Component tag: [COMP:api/synthesize] (integration). Mirrors the
 * transcript-segments retrieval integration test's connect/skip/seed pattern and
 * smoke.ts's scripted-provider shape.
 *
 * Requires a local `Use Brian` DB with the recording + CRM + saved_views
 * migrations applied. Skips silently when the DB is unavailable or a required
 * table is missing.
 *
 * NOTE on `source`: the synthesis save* tools write `source='extracted'` (see
 * synthesize.ts header + recording-synthesizer.ts) so synthesis-captured rows
 * surface in Brain Reviews (`?includeExtracted=true`). The synthesizers build the
 * CRM/task tools with `{ writeSource: 'extracted' }`, which threads through
 * `CrmStore.createCompany` into the fresh-insert `INSERT INTO entities`
 * (kind='company') — post CRM→entity unification (mig 296) a company IS an
 * entities row, there is no separate `companies` table (packages/api/src/db/crm.ts).
 * This test mirrors that wiring and asserts the DB-observable `source='extracted'`.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      // Every table the engine + its assertions touch must exist. Post
      // CRM→entity unification (mig 296) a company IS an `entities` row
      // (kind='company'); there is no separate `companies` table to probe.
      await client.query('SELECT id FROM transcript_segments LIMIT 1')
      await client.query('SELECT id, anchor_key FROM saved_views LIMIT 1')
      await client.query('SELECT id, source FROM entities LIMIT 1')
      await client.query('SELECT id FROM episodes LIMIT 1')
    } finally {
      client.release()
    }
    pool = p
    return true
  } catch {
    await p.end().catch(() => {})
    return false
  }
}

const ok = await canConnect()
const describeIf = ok ? describe : describe.skip

afterAll(async () => {
  if (pool) await pool.end()
})

// ── Seeding helpers (mirror transcript-segments + crm-store integration tests) ──

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'synth-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'synth-test-ws', 'test', $1, false)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function addMember(client: pg.PoolClient, workspaceId: string, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'owner')`,
    [workspaceId, userId],
  )
}

async function makeAssistant(client: pg.PoolClient, ownerId: string, workspaceId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO assistants (id, name, owner_user_id, workspace_id)
     VALUES (gen_random_uuid(), 'synth-test-assistant', $1, $2)
     RETURNING id`,
    [ownerId, workspaceId],
  )
  return r.rows[0].id
}

/** The recording's provenance Episode (the `recording_id` FK target for segments). */
async function makeRecordingEpisode(client: pg.PoolClient, workspaceId: string, userId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO episodes (id, source_kind, source_ref, occurred_at, workspace_id, created_by_user_id, user_id)
     VALUES (gen_random_uuid(), 'recording', '{"name":"call.m4a"}'::jsonb, now(), $1, $2, $2)
     RETURNING id`,
    [workspaceId, userId],
  )
  return r.rows[0].id
}

// A short transcript that names a company so `searchRecording` (ILIKE arm) returns it.
const SAMPLE = [
  {
    startMs: 0,
    endMs: 9000,
    speaker: 'Priya',
    text: 'The renewal call with Acme went well, but their procurement team flagged the Q3 pricing as a real blocker for signing.',
  },
  {
    startMs: 9000,
    endMs: 18000,
    speaker: 'Sam',
    text: 'Right. Acme wants a revised proposal with a small discount before they will commit; let us get them a number by Friday.',
  },
]

// ── Scripted mock provider (smoke.ts shape) ─────────────────────────────────
//
// Stateful mode (synthesizeFromSource does not set `stateless`), so the loop
// calls provider.createSession() then session.send() once per turn. Each send
// yields one turn's chunk script. The turns, in order, drive the real engine:
//   turn 1 → searchRecording({ query: 'company' })   (real DB read)
//   turn 2 → saveCompany({ name: 'Acme', notes })    (real CRM write, source=...)
//   turn 3 → getCurrentPage({ pageId }) then patchPage(append heading + text)
//   turn 4 → closing text "Done." + end_turn
//
// Tool-call ids must be unique per call. patchPage's input carries the brief
// page id (pinned via context.docViewId → anchorPageId), the page version it
// just read (1), and `add` ops whose blocks use a plain `text` field (the doc
// markdown normalizer lifts it) with the id omitted (the server mints one).

function scriptTurns(pageId: string): StreamChunk[][] {
  const turn1: StreamChunk[] = [
    { type: 'message_start', model: 'mock-model' },
    { type: 'tool_use_start', id: 'call_search', name: 'searchRecording' },
    { type: 'tool_use_delta', id: 'call_search', input: '{"query":"company"}' },
    { type: 'tool_use_end', id: 'call_search' },
    { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 40, outputTokens: 12 } },
  ]
  const turn2: StreamChunk[] = [
    { type: 'message_start', model: 'mock-model' },
    { type: 'tool_use_start', id: 'call_company', name: 'saveCompany' },
    {
      type: 'tool_use_delta',
      id: 'call_company',
      input: JSON.stringify({ name: 'Acme', tags: ['recording-synthesis'] }),
    },
    { type: 'tool_use_end', id: 'call_company' },
    { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 60, outputTokens: 18 } },
  ]
  const turn3: StreamChunk[] = [
    { type: 'message_start', model: 'mock-model' },
    { type: 'tool_use_start', id: 'call_getpage', name: 'getCurrentPage' },
    { type: 'tool_use_delta', id: 'call_getpage', input: JSON.stringify({ pageId }) },
    { type: 'tool_use_end', id: 'call_getpage' },
    { type: 'tool_use_start', id: 'call_patch', name: 'patchPage' },
    {
      type: 'tool_use_delta',
      id: 'call_patch',
      input: JSON.stringify({
        pageId,
        expectedVersion: 1,
        ops: [
          { op: 'add', block: { kind: 'heading', level: 2, text: 'Acme renewal' } },
          {
            op: 'add',
            block: {
              kind: 'text',
              text: 'Procurement flagged Q3 pricing as a blocker; revised proposal with a discount due Friday (around 0:09).',
            },
          },
        ],
      }),
    },
    { type: 'tool_use_end', id: 'call_patch' },
    { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 80, outputTokens: 30 } },
  ]
  const turn4: StreamChunk[] = [
    { type: 'message_start', model: 'mock-model' },
    { type: 'text_delta', text: 'Done. Logged Acme and authored the brief.' },
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 90, outputTokens: 10 } },
  ]
  return [turn1, turn2, turn3, turn4]
}

function mockProvider(pageId: string): LLMProvider {
  const turns = scriptTurns(pageId)
  let turn = 0
  function makeStream(): AsyncIterable<StreamChunk> {
    const chunks = turns[Math.min(turn, turns.length - 1)]
    turn++
    return (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  }
  const session: ProviderSession = {
    send(_messages: Message[]) {
      return makeStream()
    },
  }
  return {
    name: 'mock',
    models: ['mock-model'],
    stream: () => makeStream(),
    createSession: (_options: SessionOptions) => session,
  }
}

describeIf('[COMP:api/synthesize] structural-synthesis engine (integration)', () => {
  let synth: typeof import('../synthesize.js')
  let segStore: typeof import('../../db/transcript-segments-store.js')
  let savedViewStoreMod: typeof import('../../db/saved-views-store.js')
  let crmStoreMod: typeof import('../../db/crm-store.js')
  let taskStoreMod: typeof import('../../db/tasks-store.js')
  let workflowStoreMod: typeof import('../../db/workflow-store.js')
  let docPageStoreMod: typeof import('../../db/doc-page-store.js')
  let recordingToolMod: typeof import('../../recordings/recording-search-tool.js')

  let userId: string
  let workspaceId: string
  let assistantId: string
  let recordingId: string

  // Track ids for cleanup so the suite is self-contained.
  const createdWorkspaces: string[] = []
  const createdUsers: string[] = []

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    synth = await import('../synthesize.js')
    segStore = await import('../../db/transcript-segments-store.js')
    savedViewStoreMod = await import('../../db/saved-views-store.js')
    crmStoreMod = await import('../../db/crm-store.js')
    taskStoreMod = await import('../../db/tasks-store.js')
    workflowStoreMod = await import('../../db/workflow-store.js')
    docPageStoreMod = await import('../../db/doc-page-store.js')
    recordingToolMod = await import('../../recordings/recording-search-tool.js')
  })

  afterEach(async () => {
    // Tear down by cascading workspace + user deletes (FK ON DELETE CASCADE
    // sweeps episodes / transcript_segments / entities / saved_views).
    const client = await pool!.connect()
    try {
      for (const ws of createdWorkspaces) {
        await client.query('DELETE FROM workspaces WHERE id = $1', [ws]).catch(() => {})
      }
      for (const u of createdUsers) {
        await client.query('DELETE FROM users WHERE id = $1', [u]).catch(() => {})
      }
    } finally {
      client.release()
    }
    createdWorkspaces.length = 0
    createdUsers.length = 0
  })

  async function seed(): Promise<void> {
    const client = await pool!.connect()
    try {
      userId = await makeUser(client)
      createdUsers.push(userId)
      workspaceId = await makeWorkspace(client, userId)
      createdWorkspaces.push(workspaceId)
      await addMember(client, workspaceId, userId)
      assistantId = await makeAssistant(client, userId, workspaceId)
      recordingId = await makeRecordingEpisode(client, workspaceId, userId)
    } finally {
      client.release()
    }
    // Seed the recording's transcript segments (workspace-shared via the assistant).
    const n = await segStore.insertTranscriptSegments({
      recordingId,
      workspaceId,
      createdByUserId: userId,
      visibility: { userId: null, assistantId },
      sensitivity: 'internal',
      segments: segStore.segmentTranscript(SAMPLE),
    })
    expect(n).toBeGreaterThan(0)
  }

  /** Build the REAL engine deps, mirroring createRecordingSynthesizer's wiring. */
  function buildDeps(captured: Array<Record<string, unknown>>): import('../synthesize.js').SynthesizeDeps {
    const savedViewStore = savedViewStoreMod.createDbSavedViewStore()
    const crmStore = crmStoreMod.createDbCrmStore()
    const taskStore = taskStoreMod.createDbTaskStore()
    const workflowRunStore = workflowStoreMod.createDbWorkflowRunStore()
    const docPageStore = docPageStoreMod.createDbDocPageStore()

    const actor: RetrievalActor = {
      workspaceId,
      userId,
      assistantId,
      assistantKind: 'standard',
      clearance: 'internal',
      compartments: null,
    }
    const sourceTool = recordingToolMod.createSearchRecordingTool({ recordingId, actor })

    // patchPage / getCurrentPage are PINNED to the brief page via anchorPageId.
    // renderPage is excluded (it mints a duplicate page, orphaning the page-first
    // brief) — exactly as the production synthesizer does.
    const buildDocTools = (anchorPageId: string): Map<string, Tool> => {
      const toolset = createDocTools({
        savedViewStore,
        docPageStore,
        taskStore,
        crmStore,
        workflowRunStore,
        // The workspaceDirectory is only used by mention tools / data-block
        // resolution, not patchPage; a minimal stub suffices here.
        workspaceDirectory: { batchGet: async () => new Map() } as unknown as WorkspaceDirectoryStore,
        anchorPageId,
      })
      return new Map<string, Tool>(
        Object.entries(toolset).filter(([name]) => name !== 'renderPage'),
      )
    }

    // Mirror the production synthesizer wiring: synthesis-captured rows are
    // stamped `source='extracted'` so they surface in Brain Reviews.
    const crm = createCrmTools(crmStore, { writeSource: 'extracted' })
    const tasks = createTaskTools(taskStore, { writeSource: 'extracted' })
    const brainWriteTools = new Map<string, Tool>([
      ['saveCompany', crm.saveCompany],
      ['saveContact', crm.saveContact],
      ['saveDeal', crm.saveDeal],
      ['saveTask', tasks.saveTask],
    ])

    return {
      provider: mockProvider('PLACEHOLDER'), // replaced per-test once pageId is known
      model: 'mock-model',
      sourceTool,
      buildDocTools,
      brainWriteTools,
      savedViewStore,
      usageStore: {
        recordUsage: async (p) => {
          captured.push(p as unknown as Record<string, unknown>)
        },
      },
    }
  }

  async function readAnchorPageId(anchorKey: string): Promise<string | null> {
    const client = await pool!.connect()
    try {
      const r = await client.query<{ id: string }>(
        'SELECT id FROM saved_views WHERE workspace_id = $1 AND anchor_key = $2',
        [workspaceId, anchorKey],
      )
      return r.rows[0]?.id ?? null
    } finally {
      client.release()
    }
  }

  async function countAnchorPages(anchorKey: string): Promise<number> {
    const client = await pool!.connect()
    try {
      const r = await client.query<{ c: string }>(
        'SELECT count(*)::text AS c FROM saved_views WHERE workspace_id = $1 AND anchor_key = $2',
        [workspaceId, anchorKey],
      )
      return Number(r.rows[0].c)
    } finally {
      client.release()
    }
  }

  /** Read the company entity row (entities table) the save* path wrote. */
  async function readCompanyEntity(
    name: string,
  ): Promise<{ id: string; source: string; kind: string; displayName: string } | null> {
    const client = await pool!.connect()
    try {
      const r = await client.query(
        `SELECT id, source, kind, display_name AS "displayName"
           FROM entities
          WHERE workspace_id = $1 AND kind = 'company' AND lower(display_name) = lower($2)
          ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, name],
      )
      return r.rows[0] ?? null
    } finally {
      client.release()
    }
  }

  /** Read the brief page's blocks so we can prove patchPage actually authored it. */
  async function readPageBlockText(pageId: string): Promise<string> {
    const client = await pool!.connect()
    try {
      const r = await client.query<{ page: { blocks?: unknown[] } | null }>(
        'SELECT page FROM saved_views WHERE id = $1',
        [pageId],
      )
      return JSON.stringify(r.rows[0]?.page ?? {})
    } finally {
      client.release()
    }
  }

  it('runs the real engine end-to-end and writes the page-first brief, the company, and COGS', async () => {
    await seed()
    const anchorKey = `recording-synthesis:${recordingId}`
    const captured: Array<Record<string, unknown>> = []
    const deps = buildDeps(captured)

    // The brief page is created page-first by the engine BEFORE the loop, so we
    // can't know its id up front to script patchPage's `pageId`. Resolve it via
    // the anchor key the moment the engine creates it (it calls createDraft
    // synchronously before queryLoop), by rebuilding the provider lazily. The
    // engine creates the page on `savedViewStore.createDraft`; we intercept by
    // pre-creating nothing and instead pinning patchPage to the page id the
    // engine assigns — which equals context.docViewId / anchorPageId, the same
    // id buildDocTools(pageId) is called with. We capture that id through the
    // doc-tools factory.
    let resolvedPageId = ''
    const innerBuild = deps.buildDocTools
    deps.buildDocTools = (anchorPageId: string) => {
      resolvedPageId = anchorPageId
      // Now that we know the brief page id, the provider can target it.
      ;(deps as { provider: LLMProvider }).provider = mockProvider(anchorPageId)
      return innerBuild(anchorPageId)
    }

    const result = await synth.synthesizeFromSource(
      {
        kind: 'recording',
        sourceId: recordingId,
        workspaceId,
        userId,
        assistantId,
        assistantKind: 'standard',
        sensitivity: 'internal',
      },
      {
        kind: 'skill',
        slug: 'my-blueprint',
        body: 'Capture the call: pull each concern with searchRecording, then saveCompany for the account and author a short brief on the page.',
        title: 'Account brief',
      },
      { anchorKey },
      deps,
    )

    // ── result shape ──
    expect(result.pageId).not.toBeNull()
    expect(resolvedPageId).toBe(result.pageId)
    expect(result.summary).toContain('Done')
    // searchRecording + saveCompany + getCurrentPage + patchPage = 4 tool calls.
    expect(result.toolCallCount).toBeGreaterThanOrEqual(3)
    expect(result.truncated).toBe(false)

    // ── (1) a saved_views row exists on the anchor key (the page-first brief) ──
    const pageId = await readAnchorPageId(anchorKey)
    expect(pageId).toBe(result.pageId)

    // ── the brief page was actually authored in place by patchPage ──
    const pageJson = await readPageBlockText(result.pageId!)
    expect(pageJson).toContain('Acme renewal')

    // ── (2) the company "Acme" was written by the real save* path ──
    // Post CRM→entity unification (mig 296) a company IS an `entities` row
    // (kind='company'); there is no separate `companies` table. The entity
    // read proves existence + source='extracted' — the same facts the old
    // `companies`-table read asserted, plus kind + display_name.
    const entity = await readCompanyEntity('Acme')
    expect(entity).not.toBeNull()
    expect(entity!.kind).toBe('company')
    expect(entity!.displayName).toBe('Acme')
    // Synthesis writes `source='extracted'` (via the synthesizer's
    // `{ writeSource: 'extracted' }`, threaded through createCompany's
    // fresh-insert), so the captured entity surfaces in Brain Reviews
    // (`?includeExtracted=true`).
    expect(entity!.source).toBe('extracted')

    // ── (3) synthesis COGS recorded as overhead (out of credit derivation) ──
    const overhead = captured.find((c) => c.source === 'overhead:synthesis')
    expect(overhead).toBeDefined()
    expect(overhead).toMatchObject({
      source: 'overhead:synthesis',
      triggerKey: 'structural_synthesis',
      sessionId: null,
      model: 'mock-model',
    })
  })

  it('is idempotent on the anchor key — a second run reuses the same brief page', async () => {
    await seed()
    const anchorKey = `recording-synthesis:${recordingId}`

    async function runOnce(): Promise<string | null> {
      const captured: Array<Record<string, unknown>> = []
      const deps = buildDeps(captured)
      const innerBuild = deps.buildDocTools
      deps.buildDocTools = (anchorPageId: string) => {
        ;(deps as { provider: LLMProvider }).provider = mockProvider(anchorPageId)
        return innerBuild(anchorPageId)
      }
      const res = await synth.synthesizeFromSource(
        {
          kind: 'recording',
          sourceId: recordingId,
          workspaceId,
          userId,
          assistantId,
          assistantKind: 'standard',
          sensitivity: 'internal',
        },
        { kind: 'skill', slug: 'my-blueprint', body: 'Short recipe.', title: 'Account brief' },
        { anchorKey },
        deps,
      )
      return res.pageId
    }

    const firstPage = await runOnce()
    expect(firstPage).not.toBeNull()
    expect(await countAnchorPages(anchorKey)).toBe(1)

    const secondPage = await runOnce()
    expect(secondPage).toBe(firstPage) // same page reused, not a new draft
    expect(await countAnchorPages(anchorKey)).toBe(1) // still exactly one
  })
})
