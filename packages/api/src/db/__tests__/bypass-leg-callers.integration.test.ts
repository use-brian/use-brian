/**
 * The six app-pool callers that relied on the permissive default-true
 * `app.system_bypass` legs, and the two owner-side setters, after the caller
 * fixes of decision 11 (step one) and migration 8293 (step two).
 *
 * Every case runs on one pooled app connection (`PG_POOL_MAX=1`) in two states
 * of the same backend: fresh (the setting was never set, so the default-true
 * form read it as true) and after the product's own `readAdmissionPolicy`
 * committed a transaction-local elevation (the setting then reads `''`). A
 * non-member is refused and a current member is admitted in both states, so
 * the outcome no longer depends on which pooled connection a request reaches.
 *
 * Spec: docs/architecture/platform/database-schema.md, "Default-true bypass
 * legs retired (8293)". Audit receipt:
 * docs/plans/evidence/oss-chat-replacement/canonical-publication/m6-bypass-policy-audit.md
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
process.env.PG_POOL_MAX = '1'
const { getAppPool, getPool } = await import('../client.js')
const { readAdmissionPolicy } = await import('../../workspace-access/admission-policy-read.js')
const { createRealtimeThreadTargetStore } = await import('../realtime-thread-target-store.js')
const { createBrandStore } = await import('../brand-store.js')
const { resolveBrandContext } = await import('../../brand/prompt-context.js')
const { createDbSkillStore } = await import('../skill-store.js')
const { boundScopeSource } = await import('@use-brian/agent-runtime/security/source-evidence.js')
const { createDbCrmEmailDraftStore, CrmEmailDraftAnchorConflictError } = await import('../crm-email-drafts.js')
const { createDbCrmOperationsStore } = await import('../crm-operations-store.js')

const pool = getPool()
const app = getAppPool()
afterAll(async () => { await app.end(); await pool.end() })

type State = 'fresh' | 'elevated'
const STATES: readonly State[] = ['fresh', 'elevated']

const appPid = async () => (await app.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
const sessionBypass = async () => (await app.query("SELECT current_setting('app.system_bypass',true) AS v")).rows[0].v as string | null

/** Put the single pooled app connection into `state` and prove which state it is in. */
async function enter(state: State, workspaceId: string): Promise<number> {
  if (state === 'fresh') {
    const c = await app.connect(); await c.query('SELECT 1'); c.release(true)
    expect(await sessionBypass()).toBeNull()
  } else {
    const c = await app.connect()
    try { await c.query('BEGIN'); await readAdmissionPolicy(c, workspaceId); await c.query('COMMIT') } finally { c.release() }
    expect(await sessionBypass()).toBe('')
  }
  return appPid()
}

async function workspaceFixture() {
  const owner = randomUUID(), outsider = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID(), sessionId = randomUUID()
  for (const id of [owner, outsider]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Bypass caller fixture',$2)", [workspaceId, owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, owner])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind) VALUES($1,'Fixture assistant',$2,$3,'standard')", [assistantId, workspaceId, owner])
  await pool.query("INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id,workspace_id) VALUES($1,$2,$3,'web','fixture',$4)", [sessionId, assistantId, owner, workspaceId])
  return { owner, outsider, workspaceId, assistantId, sessionId }
}
type Fixture = Awaited<ReturnType<typeof workspaceFixture>>
const dropWorkspaces = async (...ids: string[]) => { for (const id of ids) await pool.query('DELETE FROM workspaces WHERE id=$1', [id]).catch(() => {}) }

describe('[COMP:api/realtime-thread-target-store] membership predicate on set, list and remove', () => {
  it('refuses a non-member and admits the member identically on a fresh and an elevated connection', async () => {
    const f = await workspaceFixture(), store = createRealtimeThreadTargetStore()
    const expiresAt = new Date(Date.now() + 3_600_000)
    const seeded = (await pool.query<{ id: string }>(`INSERT INTO realtime_thread_targets(workspace_id,assistant_id,channel_type,conversation_ref,thread_ref,task_ids,expires_at,created_by_user_id)
      VALUES($1,$2,'slack','C-fixture','T-seed','{}',$3,$4) RETURNING id`, [f.workspaceId, f.assistantId, expiresAt, f.owner])).rows[0].id
    const input = (userId: string, threadRef: string) => ({ workspaceId: f.workspaceId, assistantId: f.assistantId, channelType: 'slack',
      conversationRef: 'C-fixture', threadRef, taskIds: [], contextText: 'Fictional context', expiresAt, createdByUserId: userId })
    const pids = new Set<number>()
    for (const state of STATES) {
      pids.add(await enter(state, f.workspaceId))
      expect(await store.list(f.outsider, { workspaceId: f.workspaceId, assistantId: f.assistantId, includeExpired: true }), state).toEqual([])
      expect(await store.remove(f.outsider, { id: seeded, workspaceId: f.workspaceId, assistantId: f.assistantId }), state).toBe(false)
      await expect(store.set(f.outsider, input(f.outsider, `T-outsider-${state}`)), state).rejects.toThrow(/not a current member/)
      const own = await store.set(f.owner, input(f.owner, `T-owner-${state}`))
      expect(own, state).toMatchObject({ workspaceId: f.workspaceId, threadRef: `T-owner-${state}` })
      expect((await store.list(f.owner, { workspaceId: f.workspaceId, assistantId: f.assistantId, includeExpired: true })).map(t => t.id), state)
        .toEqual(expect.arrayContaining([seeded, own.id]))
      expect(await store.remove(f.owner, { id: own.id, workspaceId: f.workspaceId, assistantId: f.assistantId }), state).toBe(true)
    }
    expect(pids.size).toBe(1)
    const rows = (await pool.query('SELECT id,created_by_user_id FROM realtime_thread_targets WHERE workspace_id=$1', [f.workspaceId])).rows
    expect(rows).toEqual([{ id: seeded, created_by_user_id: f.owner }])
    await dropWorkspaces(f.workspaceId)
  })
})

describe('[COMP:brand/store] membership predicate on get and saveDraft, including the public-turn owner principal', () => {
  it('returns no brand to a non-member and the brand to the member on a fresh and an elevated connection', async () => {
    const f = await workspaceFixture(), store = createBrandStore()
    const created = await store.create(f.owner, f.workspaceId, { slug: 'fictional-brand', name: 'Fictional Brand' })
    expect(await store.approve(f.owner, f.workspaceId, created.id, f.owner)).not.toBeNull()
    const draftOf = async () => (await pool.query('SELECT draft FROM workspace_brands WHERE id=$1', [created.id])).rows[0].draft
    const pids = new Set<number>()
    for (const state of STATES) {
      pids.add(await enter(state, f.workspaceId))
      expect(await store.get(f.outsider, f.workspaceId), state).toBeNull()
      expect(await store.get(f.outsider, f.workspaceId, { id: created.id }), state).toBeNull()
      const before = await draftOf()
      expect(await store.saveDraft(f.outsider, f.workspaceId, created.id, created.draft!), state).toBeNull()
      expect(await draftOf(), state).toEqual(before)
      // routes/public-turn.ts binds workspaces.owner_user_id through resolveBrandContext.
      expect(await resolveBrandContext({ userId: f.outsider, workspaceId: f.workspaceId, hasCapability: true, logLabel: 'fixture' }), state).toBeNull()
      expect(await resolveBrandContext({ userId: f.owner, workspaceId: f.workspaceId, hasCapability: true, logLabel: 'fixture' }), state).toContain('Fictional Brand')
      expect(await store.get(f.owner, f.workspaceId), state).toMatchObject({ id: created.id, activeVersion: 1 })
    }
    expect(pids.size).toBe(1)
    // A departed owner, the public-turn proxy principal, is refused the same way on both states.
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.owner])
    for (const state of STATES) {
      await enter(state, f.workspaceId)
      expect(await resolveBrandContext({ userId: f.owner, workspaceId: f.workspaceId, hasCapability: true, logLabel: 'fixture' }), state).toBeNull()
    }
    await dropWorkspaces(f.workspaceId)
  })
})

describe('[COMP:api/skill-store] runtime source receipt only for a current member', () => {
  it('reads community skills for a non-member without any receipt and gives the member the receipt, on both states', async () => {
    const f = await workspaceFixture()
    const insert = (slug: string, induction: string, origin: string) => pool.query(`INSERT INTO workspace_skills(workspace_id,author_id,slug,name,description,content,sensitivity,induction_source,write_origin,published,source)
      VALUES($1,$2,$3,$3,'Fixture skill','Fixture content','public',$4,$5,true,'community')`, [f.workspaceId, f.owner, slug, induction, origin])
    // An authored skill gets its root revision on insert (8220); a self-induced one has none.
    const receipted = 'fictional-authored', plain = 'fictional-induced'
    await insert(receipted, 'authored', 'foreground')
    await insert(plain, 'self', 'background_review')
    const revisions = (await pool.query('SELECT slug,scope_revision_id FROM workspace_skills WHERE workspace_id=$1', [f.workspaceId])).rows
    const revision = revisions.find(r => r.slug === receipted)!.scope_revision_id
    expect(revision).toBeTruthy()
    expect(revisions.find(r => r.slug === plain)!.scope_revision_id).toBeNull()
    const store = createDbSkillStore()
    // SkillContent.id is the slug.
    const read = async (userId: string) => new Map((await store.listForWorkspaceContent(f.workspaceId, userId)).map(s => [s.id, s]))
    const pids = new Set<number>()
    for (const state of STATES) {
      pids.add(await enter(state, f.workspaceId))
      const outsider = await read(f.outsider)
      // The community row without a receipt stays readable across workspaces and binds no source.
      expect(outsider.get(plain), state).toBeDefined()
      expect(boundScopeSource(outsider.get(plain)!), state).toBeUndefined()
      // A receipted row is hidden from a non-member by the restrictive workspace_skills_scope_holding
      // policy (602): its revision is member-only once no default-true leg admits it.
      expect(outsider.has(receipted), state).toBe(false)
      const member = await read(f.owner)
      expect(boundScopeSource(member.get(receipted)!), state).toMatchObject({ resourceKind: 'workspace_skill_revision', resourceId: revision, workspaceId: f.workspaceId })
      expect(boundScopeSource(member.get(plain)!), state).toBeUndefined()
    }
    expect(pids.size).toBe(1)
    await dropWorkspaces(f.workspaceId)
  })
})

describe('[COMP:crm/email-drafts] membership row FOR SHARE, member reads and same-workspace anchors', () => {
  const draftInput = (f: Fixture, userId: string, workspaceId = f.workspaceId) => ({ workspaceId, userId,
    assistantId: f.assistantId, sessionId: f.sessionId, to: ['person@example.test'], subject: 'Fictional follow-up', body: 'Fictional body' })

  it('refuses a non-member without writing and admits the member on a fresh and an elevated connection', async () => {
    const f = await workspaceFixture(), store = createDbCrmEmailDraftStore()
    const written = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM crm_email_drafts WHERE workspace_id=$1) AS drafts,
      (SELECT count(*)::int FROM crm_email_draft_versions WHERE workspace_id=$1) AS versions,
      (SELECT count(*)::int FROM crm_email_draft_session_anchors WHERE workspace_id=$1) AS anchors`, [f.workspaceId])).rows[0]
    const pids = new Set<number>()
    const own: string[] = []
    for (const state of STATES) {
      pids.add(await enter(state, f.workspaceId))
      const before = await written()
      expect(await store.saveRevision(draftInput(f, f.outsider)), state).toBeNull()
      expect(await written(), state).toEqual(before)
      const saved = await store.saveRevision(draftInput(f, f.owner))
      expect(saved, state).toMatchObject({ workspaceId: f.workspaceId, createdByUserId: f.owner })
      own.push(saved!.id)
      expect(await store.list({ workspaceId: f.workspaceId, userId: f.outsider }), state).toEqual([])
      expect(await store.getById({ workspaceId: f.workspaceId, userId: f.outsider, draftId: saved!.id }), state).toBeNull()
      expect(await store.getActiveForSession({ workspaceId: f.workspaceId, userId: f.outsider, sessionId: f.sessionId }), state).toBeNull()
      expect((await store.list({ workspaceId: f.workspaceId, userId: f.owner })).map(d => d.id).sort(), state).toEqual([...own].sort())
      expect(await store.getActiveForSession({ workspaceId: f.workspaceId, userId: f.owner, sessionId: f.sessionId }), state).toMatchObject({ id: saved!.id })
    }
    expect(pids.size).toBe(1)
    await dropWorkspaces(f.workspaceId)
  })

  it('never moves an anchor into another workspace, for a departed member or a member of both', async () => {
    const left = await workspaceFixture(), store = createDbCrmEmailDraftStore()
    const target = randomUUID()
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Bypass caller target',$2)", [target, left.owner])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member'),($3,$2,'member'),($3,$4,'owner')",
      [left.workspaceId, left.outsider, target, left.owner])
    await enter('fresh', left.workspaceId)
    expect(await store.saveRevision(draftInput(left, left.outsider))).toMatchObject({ workspaceId: left.workspaceId })
    const anchor = async () => (await pool.query('SELECT workspace_id FROM crm_email_draft_session_anchors WHERE session_id=$1', [left.sessionId])).rows
    const targetDrafts = async () => (await pool.query('SELECT count(*)::int AS n FROM crm_email_drafts WHERE workspace_id=$1', [target])).rows[0].n
    for (const state of STATES) {
      await enter(state, target)
      // A member of both workspaces: the anchor stays and the whole save rolls back.
      await expect(store.saveRevision(draftInput(left, left.owner, target)), state).rejects.toBeInstanceOf(CrmEmailDraftAnchorConflictError)
      expect(await anchor(), state).toEqual([{ workspace_id: left.workspaceId }])
      expect(await targetDrafts(), state).toBe(0)
    }
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [left.workspaceId, left.outsider])
    for (const state of STATES) {
      await enter(state, target)
      // Departed from the anchor's workspace, still a member of the target: refused, not moved.
      await expect(store.saveRevision(draftInput(left, left.outsider, target)), state).rejects.toBeInstanceOf(CrmEmailDraftAnchorConflictError)
      expect(await anchor(), state).toEqual([{ workspace_id: left.workspaceId }])
      expect(await targetDrafts(), state).toBe(0)
    }
    await dropWorkspaces(left.workspaceId, target)
  })
})

describe('[COMP:crm/operations-store] the system transaction elevates only an owner connection', () => {
  it('refuses an app-pool construction before any statement and admits the owner pool, before and after an elevation', async () => {
    const f = await workspaceFixture()
    const context = { workspaceId: f.workspaceId, actor: { kind: 'user' as const, userId: f.owner },
      authority: { role: 'owner' as const, canWrite: true, canConfigure: true, trustedIdentitySources: [] } }
    const ownerPid = async () => (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
    for (const state of STATES) {
      await enter(state, f.workspaceId)
      const fn = vi.fn(async () => 'ran')
      await expect(createDbCrmOperationsStore(app).transaction(context as never, fn), state).rejects.toMatchObject({ code: 'not_authorized' })
      expect(fn, state).not.toHaveBeenCalled()
      expect(await sessionBypass(), state).toBe(state === 'fresh' ? null : '')
      const seen = await createDbCrmOperationsStore(pool).transaction(context as never, async (tx) => {
        const { client } = tx.commercial()
        return (await client.query("SELECT current_setting('app.system_bypass',true) AS v")).rows[0].v
      })
      expect(seen, state).toBe('true')
      if (state === 'elevated') {
        // The owner connection after its own committed elevation is admitted the same way.
        const c = await pool.connect()
        try { await c.query('BEGIN'); await readAdmissionPolicy(c, f.workspaceId); await c.query('COMMIT') } finally { c.release() }
        expect(await ownerPid()).toBeGreaterThan(0)
        expect(await createDbCrmOperationsStore(pool).transaction(context as never, async () => 'ran')).toBe('ran')
      }
    }
    await dropWorkspaces(f.workspaceId)
  })
})

describe('[COMP:crm/invoice-preparation] the issue attempt lease elevates only an owner connection', () => {
  it('leases on the owner pool and refuses when the lease pool is the app role', async () => {
    const f = await workspaceFixture()
    const { processCrmIssueAttempts } = await import('../../crm-operations/commercial-preparations.js')
    // No attempt is queued, so a passing role assertion leases nothing and returns 0.
    expect(await processCrmIssueAttempts({} as never, {} as never, { attemptId: randomUUID(), limit: 1 })).toBe(0)

    vi.resetModules()
    vi.doMock('../client.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../client.js')>()
      return { ...actual, getPool: actual.getAppPool }
    })
    try {
      const swapped = await import('../../crm-operations/commercial-preparations.js')
      const swappedClient = await import('../client.js')
      for (const state of STATES) {
        const c = await swappedClient.getAppPool().connect()
        try {
          if (state === 'elevated') { await c.query('BEGIN'); await readAdmissionPolicy(c, f.workspaceId); await c.query('COMMIT') }
          expect((await c.query("SELECT current_user AS role")).rows[0].role).not.toBe((await pool.query('SELECT current_user AS role')).rows[0].role)
        } finally { c.release() }
        await expect(swapped.processCrmIssueAttempts({} as never, {} as never, { attemptId: randomUUID(), limit: 1 }), state)
          .rejects.toThrow(/requires the owner connection/)
      }
      await swappedClient.getAppPool().end()
    } finally { vi.doUnmock('../client.js'); vi.resetModules() }
    await dropWorkspaces(f.workspaceId)
  })
})
