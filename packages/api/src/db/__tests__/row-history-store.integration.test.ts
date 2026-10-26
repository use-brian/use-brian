import { describe, it, expect, afterAll, afterEach, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { ContextScopeAccumulator, boundScopeSources, createCorrectionTools, executionToolContext, mergeEntities, type AccessContext, type RetrievalActor } from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease, runWithAgentAccess } from '../client.js'
import * as store from '../row-history-store.js'
import * as tasksDb from '../tasks.js'
import * as crm from '../crm.js'
import * as entities from '../entities-store.js'
import { createDbMemoryStore } from '../memory-store.js'
import { createMemoryRetractionStore } from '../retraction-store.js'
import { createSoftDeleteStore } from '../soft-delete-store.js'
import { createSensitivityReclassificationStore } from '../sensitivity-reclassification-store.js'
import { readRetainedContextFrame, writeRetainedContextFrame } from '../session-context-revisions.js'
import { createEntityMergeStore } from '../entity-merge-store.js'
import { authSessionStore } from '../auth-session-store.js'
import { createPersonalWebSession } from '../sessions.js'
import { findAssistantById } from '../users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'

/** Unified D.7 history over maintained writers and actual native-session authority.
 * Run through scripts/crm/local-fixture.mjs with --runtime-role app_user.
 * A missing disposable fixture fails rather than skipping an ambient database.
 */
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
const memoryStore = createDbMemoryStore()
const mergeRepo = createEntityMergeStore()
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000'

afterAll(async () => { await getAppPool().end(); await pool.end() })

describe.sequential('[COMP:brain/row-history-store][COMP:corrections/retraction-store] unified getRowHistory dispatch', () => {
  let fixture: Awaited<ReturnType<typeof persistentContextFixture>>
  let userId: string
  let assistantId: string
  let workspaceId: string
  let nativeSession: Awaited<ReturnType<typeof createPersonalWebSession>>
  let credential: { userId: string; sessionId: string; authVersion: number }

  beforeEach(async () => {
    fixture = await persistentContextFixture()
    userId = fixture.ownerId; assistantId = fixture.assistantId; workspaceId = fixture.workspaceId
    const auth = await authSessionStore.create(userId, { deviceLabel: 'Fictional history device', userAgent: 'Fixture', ipAddress: '127.0.0.1' })
    if (!auth) throw new Error('Missing actual history authentication session')
    credential = { userId, sessionId: auth.id, authVersion: auth.authVersion }
    nativeSession = await createPersonalWebSession({ assistantId, userId, workspaceId, channelType: 'web', channelId: crypto.randomUUID(), appOrigin: 'chat' },
      { actorUserId: userId, authSessionId: auth.id, authVersion: auth.authVersion })
  })
  afterEach(async () => { await fixture?.cleanup() })

  // Resolve every operation anew; previous reads or writes never become an allow cache.
  async function authority() {
    const assistant = await findAssistantById(assistantId)
    if (!assistant) throw new Error('Missing actual history assistant')
    const resolved = await resolveExecutionContextSystem({ userId, workspaceId, assistant, memberMode: 'member', sharedAudience: false,
      session: nativeSession, sessionAuthority: nativeSession,
      identity: { kind: 'attended', principal: { kind: 'workspace_member', userId, authenticationKind: 'native_session' } },
      ownership: { kind: 'workspace', workspaceId },
      lifecycle: { sessionId: nativeSession.id, sessionPersisted: true, channelType: 'web', channelId: nativeSession.channelId, abortSignal: new AbortController().signal },
      nativeSessionCredential: credential })
    return { execution: resolved.executionContext, accumulator: new ContextScopeAccumulator() }
  }
  async function actor(): Promise<RetrievalActor> {
    const current = await authority()
    return { ...current.execution.security.access, authority: current }
  }
  async function withNativeAccess<T>(action: (access: AccessContext) => Promise<T>): Promise<T> {
    const current = await authority()
    return runWithAgentAccess(current.execution.security.access, () => action(current.execution.security.access))
  }
  async function withNativeTransaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const current = await authority(), client = await getAppPool().connect()
    try {
      return await runWithAgentAccess(current.execution.security.access, async () => {
        await current.execution.security.authority.assertCurrent()
        await client.query('BEGIN'); await applyRLSGucs(client, userId)
        const result = await action(client)
        await current.execution.security.authority.assertCurrent()
        await client.query('COMMIT')
        return result
      })
    } finally { await rollbackAndRelease(client) }
  }
  async function createMemory(params: Omit<Parameters<typeof memoryStore.create>[0], 'authority'>) {
    const current = await authority()
    return memoryStore.create({ ...params, workspaceId, authority: current })
  }
  async function updateMemory(id: string, updates: { summary: string }) {
    const current = await authority(), access = current.execution.security.access
    const prior = await memoryStore.getById(access, id, current)
    expect(prior).not.toBeNull()
    const next = await memoryStore.update(id, updates, access, { authority: current, expectedVersion: prior!.scopeVersion!, writeFields: ['summary'] })
    expect(next).not.toBeNull()
    return next
  }
  async function retractUsingTool(memoryId: string, current?: Awaited<ReturnType<typeof authority>>) {
    const host = current ?? await authority()
    const tools = createCorrectionTools({ retraction: createMemoryRetractionStore(), softDelete: createSoftDeleteStore(),
      reclassify: createSensitivityReclassificationStore(), resolveWorkspaceRole: async (id, workspace) =>
        (await pool.query("SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [workspace, id])).rows[0]?.role ?? null })
    return tools.find(tool => tool.name === 'retractMemory')!.execute({ memory_id: memoryId, reason: 'Fictional history correction' },
      { ...executionToolContext(host.execution, { appId: 'fictional-history' }), scopeAccumulator: host.accumulator })
  }
  async function mergeForHistory(mergedId: string, survivingId: string) {
    const merged = await withNativeAccess(() => mergeEntities({ workspaceId, survivingId, mergedId, actorUserId: userId,
      reason: 'Fictional history duplicate review', mode: 'survivor-wins', cascade: false }, { repo: mergeRepo }))
    expect(merged).toMatchObject({ workspaceId, survivingId, mergedId })
    return merged
  }

  it('rejects unknown primitive names', async () => {
    const factory = store.createDbRowHistoryStore()
    await expect(
      factory.getRowHistory(await actor(), {
        // @ts-expect-error — testing runtime validation of bad input
        primitive: 'bogus',
        row_id: UNKNOWN_UUID,
      }),
    ).rejects.toThrow(/unknown primitive/)
  })

  it('rejects non-UUID row_id', async () => {
    const factory = store.createDbRowHistoryStore()
    await expect(
      factory.getRowHistory(await actor(), { primitive: 'memories', row_id: 'not-a-uuid' }),
    ).rejects.toThrow(/row_id/)
  })

  it('returns null when the chain is empty (id unknown)', async () => {
    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(await actor(), {
      primitive: 'memories',
      row_id: UNKNOWN_UUID,
    })
    expect(result).toBeNull()
  })

  it('memories: single-version chain + status=active + authorship surfaced', async () => {
    const m = await createMemory({
      assistantId, userId,
 summary: 'Solo memory', sensitivity: 'internal',
      createdByUserId: userId, createdByAssistantId: assistantId,
    })
    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(await actor(), { primitive: 'memories', row_id: m.id })
    expect(result).not.toBeNull()
    expect(result!.api_version).toBe('v1')
    expect(result!.data.chain).toHaveLength(1)
    const v = result!.data.chain[0]
    expect(v.id).toBe(m.id)
    expect(v.primitive).toBe('memories')
    expect(v.status).toBe('active')
    expect(v.valid_to).toBeNull()
    expect(v.superseded_by).toBeNull()
    expect(v.retracted_at).toBeNull()
    expect(v.created_by_user_id).toBe(userId)
    expect(v.created_by_assistant_id).toBe(assistantId)
    expect(v.display).toMatchObject({ summary: 'Solo memory' })
    expect(result!.data.current_id).toBe(m.id)
  })

  it('memories: three-version chain in chronological order with correct statuses', async () => {
    const v1 = await createMemory({
      assistantId, userId,
 summary: 'V1', sensitivity: 'internal', createdByUserId: userId,
    })
    const v2 = await updateMemory(v1.id, { summary: 'V2' })
    const v3 = await updateMemory(v2!.id, { summary: 'V3' })

    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(await actor(), { primitive: 'memories', row_id: v2!.id })
    expect(result).not.toBeNull()
    const chain = result!.data.chain
    expect(chain.map((r) => r.display.summary)).toEqual(['V1', 'V2', 'V3'])
    expect(chain[0].status).toBe('superseded')
    expect(chain[1].status).toBe('superseded')
    expect(chain[2].status).toBe('active')
    expect(chain[0].superseded_by).toBe(v2!.id)
    expect(chain[1].superseded_by).toBe(v3!.id)
    expect(chain[2].valid_to).toBeNull()
    expect(result!.data.current_id).toBe(v3!.id)
  })

  it('memories: mid-chain id returns the same chain as head id', async () => {
    const v1 = await createMemory({
      assistantId, userId,
 summary: 'V1', sensitivity: 'internal', createdByUserId: userId,
    })
    const v2 = await updateMemory(v1.id, { summary: 'V2' })
    const v3 = await updateMemory(v2!.id, { summary: 'V3' })

    const factory = store.createDbRowHistoryStore()
    const fromMid = await factory.getRowHistory(await actor(), { primitive: 'memories', row_id: v2!.id })
    const fromHead = await factory.getRowHistory(await actor(), { primitive: 'memories', row_id: v3!.id })
    expect(fromMid!.data.chain.map((r) => r.id)).toEqual(
      fromHead!.data.chain.map((r) => r.id),
    )
    expect(fromMid!.data.current_id).toBe(v3!.id)
    expect(fromHead!.data.current_id).toBe(v3!.id)
  })

  it('memories: include_retracted=false drops retracted versions', async () => {
    const v1 = await createMemory({
      assistantId, userId,
 summary: 'V1', sensitivity: 'internal', createdByUserId: userId,
    })
    const v2 = await updateMemory(v1.id, { summary: 'V2' })
    const toolResult = await retractUsingTool(v2!.id)
    expect(toolResult.isError, JSON.stringify(toolResult)).not.toBe(true)
    const retracted = { memoryId: (toolResult.data as { memoryId: string }).memoryId,
      retractedAt: new Date((toolResult.data as { retractedAt: string }).retractedAt) }
    expect(retracted.memoryId).toBe(v2!.id)
    expect(retracted.retractedAt).toBeInstanceOf(Date)

    const factory = store.createDbRowHistoryStore()
    const withRetracted = await factory.getRowHistory(await actor(), {
      primitive: 'memories', row_id: v1.id,
    })
    expect(withRetracted!.data.chain).toHaveLength(2)
    expect(withRetracted!.data.chain[1].status).toBe('retracted')

    const withoutRetracted = await factory.getRowHistory(await actor(), {
      primitive: 'memories', row_id: v1.id, include_retracted: false,
    })
    expect(withoutRetracted!.data.chain).toHaveLength(1)
    expect(withoutRetracted!.data.chain[0].id).toBe(v1.id)
  })

  it('memories: canonical retraction commits an immutable receipt, rejects forgery and reports postcommit uncertainty honestly', async () => {
    const original = await createMemory({ assistantId, userId, summary: 'Fictional original fact', sensitivity: 'internal', createdByUserId: userId })
    const memory = (await updateMemory(original.id, { summary: 'Fictional withdrawn fact' }))!
    const unrelated = await createMemory({ assistantId, userId, summary: 'Fictional unrelated fact', sensitivity: 'internal', createdByUserId: userId })
    const childHost = await authority(), parent = await memoryStore.getById(childHost.execution.security.access, memory.id, childHost)
    expect(parent).not.toBeNull(); childHost.accumulator.note({ sources: boundScopeSources(parent!) })
    const child = await memoryStore.create({ assistantId, userId, workspaceId, summary: 'Fictional derived child', sensitivity: 'internal', createdByUserId: userId, authority: childHost })
    const current = await authority(), access = current.execution.security.access
    const extra = await memoryStore.getById(access, unrelated.id, current)
    expect(extra).not.toBeNull(); current.accumulator.note({ sources: boundScopeSources(extra!) })
    const vectorBefore = (await pool.query('SELECT search_vector::text AS vector FROM memories WHERE id=$1', [memory.id])).rows[0].vector
    const observed = await memoryStore.getById(access, memory.id, current)
    expect(observed).not.toBeNull()
    const sources = boundScopeSources(observed!); current.accumulator.note({ sources })
    const result = await retractUsingTool(memory.id, current)
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(result.data).toEqual({ memoryId: memory.id, retractedAt: expect.any(String) })
    const row = (await pool.query('SELECT summary,retracted_at,valid_to,scope_version::text AS version,search_vector::text AS vector FROM memories WHERE id=$1', [memory.id])).rows[0]
    expect(row).toMatchObject({ summary: 'Fictional withdrawn fact', retracted_at: expect.any(Date), valid_to: expect.any(Date), version: String(Number(memory.scopeVersion) + 1) })
    expect(row.vector).toBe(vectorBefore)
    expect((await pool.query("SELECT has_function_privilege('app_user','retract_admitted_native_memory(uuid,uuid,text,uuid,uuid,text,text,timestamptz)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false)
    const receipt = (await pool.query("SELECT id,native_memory_transition AS transition FROM correction_audit WHERE workspace_id=$1 AND row_id=$2 AND native_memory_transition IS NOT NULL", [workspaceId, memory.id])).rows[0]
    expect(receipt.transition).toMatchObject({ kind: 'native_memory_retract_v1', priorVersion: memory.scopeVersion, resultVersion: row.version,
      actorId: userId, assistantId, sessionId: nativeSession.id, writeFields: ['retracted_at', 'retracted_reason', 'retracted_by', 'valid_to'], contextFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      reasonEvidence: expect.objectContaining({ sensitivity: 'internal', sources: expect.arrayContaining([expect.objectContaining({ resourceKind: 'memory', resourceId: unrelated.id, version: unrelated.scopeVersion })]) }),
      originalRoots: expect.arrayContaining([{ kind: 'memory', id: memory.id, version: memory.scopeVersion }, { kind: 'memory', id: unrelated.id, version: unrelated.scopeVersion }]) })
    await expect(withNativeTransaction(client => client.query(`INSERT INTO correction_audit(workspace_id,action,primitive,row_id,actor_user_id,native_memory_transition)
      VALUES($1,'retract','memory',$2,$3,'{"kind":"native_memory_retract_v1"}')`, [workspaceId, memory.id, userId]))).rejects.toThrow('scope_evidence_immutable')
    await expect(pool.query("UPDATE correction_audit SET reason='Forged replacement' WHERE id=$1", [receipt.id])).rejects.toThrow('scope_evidence_immutable')
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1', [child.id])).rows[0].scope_held).toBe(true)
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1', [unrelated.id])).rows[0].scope_held).toBe(false)
    expect((await pool.query('SELECT summary FROM memories WHERE id=$1', [original.id])).rows[0].summary).toBe('Fictional original fact')
    expect((await pool.query("SELECT read_scope_source($1,'correction_audit',$2) AS source", [workspaceId, receipt.id])).rows[0].source).toBeNull()
    await expect(readRetainedContextFrame(await authority(), sources, async () => 'An old fact must not be reused')).rejects.toThrow()
    const heldHost = await authority()
    await expect(memoryStore.getById(heldHost.execution.security.access, memory.id, heldHost)).rejects.toMatchObject({ code: 'scope_source_changed' })
    await pool.query(`UPDATE correction_audit SET reason='Personal data erased',row_snapshot='{"erased":true}',detail='{"erased":true}' WHERE id=$1`, [receipt.id])
    expect((await pool.query("SELECT read_scope_source($1,'correction_audit',$2) AS source", [workspaceId, receipt.id])).rows[0].source).toBeNull()

    const uncertainMemory = await createMemory({ assistantId, userId, summary: 'Fictional uncertain correction', sensitivity: 'internal', createdByUserId: userId })
    const uncertainHost = await authority(), originals = new Map<PoolClient, PoolClient['query']>(), dispatched = new WeakSet<PoolClient>()
    let revoked = 0
    const trace = (client: PoolClient) => {
      if (originals.has(client)) return
      const original = client.query; originals.set(client, original)
      client.query = function (...args: unknown[]) {
        const sql = typeof args[0] === 'string' ? args[0] : ''
        if (sql.includes('SELECT retract_admitted_native_memory(')) dispatched.add(client)
        const pending = Reflect.apply(original, client, args)
        if (sql === 'COMMIT' && dispatched.has(client)) {
          dispatched.delete(client)
          return Promise.resolve(pending).then(async value => { revoked++; expect(await authSessionStore.revokeForUser(userId, credential.sessionId)).toBe(true); return value })
        }
        return pending
      } as typeof client.query
    }
    getAppPool().on('acquire', trace)
    let uncertain
    try { uncertain = await retractUsingTool(uncertainMemory.id, uncertainHost) }
    finally { getAppPool().off('acquire', trace); for (const [client, original] of originals) client.query = original }
    expect(revoked).toBe(1)
    expect(uncertain!.isError).toBe(true)
    expect(String(uncertain!.data)).toContain('may have committed')
    expect(String(uncertain!.data)).toContain('Do not repeat')
    expect(String(uncertain!.data)).not.toMatch(/nothing was saved|nothing changed|Fictional uncertain correction/i)
    expect((await pool.query('SELECT retracted_at FROM memories WHERE id=$1', [uncertainMemory.id])).rows[0].retracted_at).toBeInstanceOf(Date)
    expect((await pool.query('SELECT id FROM correction_audit WHERE workspace_id=$1 AND row_id=$2 AND native_memory_transition IS NOT NULL', [workspaceId, uncertainMemory.id])).rows).toHaveLength(1)
  })

  it('memories: canonical retraction refuses stale versions, actor changes and lifecycle WRITE contraction without a partial receipt', async () => {
    const original = await createMemory({ assistantId, userId, summary: 'Fictional earlier fact', sensitivity: 'internal', createdByUserId: userId })
    const memory = (await updateMemory(original.id, { summary: 'Fictional unchanged fact' }))!
    const childHost = await authority(), parent = await memoryStore.getById(childHost.execution.security.access, memory.id, childHost)
    expect(parent).not.toBeNull(); childHost.accumulator.note({ sources: boundScopeSources(parent!) })
    const child = await memoryStore.create({ assistantId, userId, workspaceId, summary: 'Fictional rollback child', sensitivity: 'internal', createdByUserId: userId, authority: childHost })
    const current = await authority(), repo = createMemoryRetractionStore()
    const input = { workspaceId, memoryId: memory.id, retractedBy: userId, reason: 'Fictional denied correction', now: new Date(), operation: { authority: current, expectedVersion: memory.scopeVersion! } }
    const snapshot = async () => (await pool.query('SELECT id,summary,retracted_at,valid_to,scope_version,scope_held,search_vector::text AS vector FROM memories WHERE id=ANY($1::uuid[]) ORDER BY id', [[memory.id, child.id]])).rows
    const before = await snapshot()
    await expect(repo.applySoftRetract({ ...input, retractedBy: fixture.firstId })).rejects.toMatchObject({ code: 'scope_evidence_missing' })
    const actual = await memoryStore.getById(current.execution.security.access, memory.id, current)
    expect(actual).not.toBeNull(); current.accumulator.note({ sources: boundScopeSources(actual!) })
    const reasonInputs = JSON.stringify(current.accumulator.evidence)
    await expect(writeRetainedContextFrame(current, current.accumulator.evidence.sources ?? [], client => client.query('SELECT retract_admitted_native_memory($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
      [workspaceId, memory.id, '0', assistantId, nativeSession.id, 'a'.repeat(64), input.reason, input.now, reasonInputs]))).rejects.toThrow('scope_source_changed')
    await expect(writeRetainedContextFrame(current, current.accumulator.evidence.sources ?? [], async client => {
      const receipt = await client.query('SELECT retract_admitted_native_memory($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) AS receipt',
        [workspaceId, memory.id, memory.scopeVersion, assistantId, nativeSession.id, 'a'.repeat(64), input.reason, input.now, reasonInputs])
      expect(receipt.rows[0].receipt).toBeTruthy()
      throw new Error('Fictional transaction rollback after the canonical correction')
    })).rejects.toThrow('Fictional transaction rollback')
    expect(await snapshot()).toEqual(before)
    expect((await pool.query('SELECT id FROM correction_audit WHERE workspace_id=$1 AND row_id=$2', [workspaceId, memory.id])).rows).toEqual([])
    const restricted = await createMemory({ assistantId, userId, summary: 'Fictional restricted reason input', sensitivity: 'confidential', createdByUserId: userId })
    const restrictedHost = await authority(), restrictedRead = await memoryStore.getById(restrictedHost.execution.security.access, restricted.id, restrictedHost)
    expect(restrictedRead).not.toBeNull(); restrictedHost.accumulator.note({ sources: boundScopeSources(restrictedRead!) })
    await expect(repo.applySoftRetract({ ...input, operation: { authority: restrictedHost, expectedVersion: memory.scopeVersion! } })).rejects.toMatchObject({ code: 'scope_visibility_incompatible' })
    const scalarHost = await authority(); scalarHost.accumulator.note({ sensitivity: 'confidential' })
    await expect(repo.applySoftRetract({ ...input, operation: { authority: scalarHost, expectedVersion: memory.scopeVersion! } })).rejects.toMatchObject({ code: 'scope_visibility_incompatible' })
    expect(await snapshot()).toEqual(before)
    expect((await pool.query('SELECT id FROM correction_audit WHERE workspace_id=$1 AND row_id=$2', [workspaceId, memory.id])).rows).toEqual([])
    let registered = false
    try {
      await pool.query(`CREATE FUNCTION fixture_retraction_catalog(w uuid,o jsonb,t text) RETURNS jsonb
       LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
       SELECT jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','1','policyVersion','1',
        'fieldKeys',application_memory_field_keys(),'fields',(SELECT jsonb_agg(jsonb_build_object('key',key,'read','[]'::jsonb,
         'write',CASE WHEN key='retracted_reason' THEN '[["editor"]]'::jsonb ELSE '[]'::jsonb END,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb) ORDER BY key) FROM unnest(application_memory_field_keys()) key),
        'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb)) $$;
       CREATE FUNCTION fixture_retraction_reader(w uuid,o jsonb,t text,i text) RETURNS jsonb
       LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
       SELECT (fixture_retraction_catalog(w,o,t)-'scope')||jsonb_build_object('recordVersion',m.scope_version::text,'source',read_scope_source(w,'memory',m.id)) FROM memories m WHERE m.workspace_id=w AND m.id=i::uuid $$;
       REVOKE ALL ON FUNCTION fixture_retraction_catalog(uuid,jsonb,text),fixture_retraction_reader(uuid,jsonb,text,text) FROM PUBLIC;
       INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader)
        VALUES('native','1',ARRAY['editor'],'fixture_retraction_reader(uuid,jsonb,text,text)'::regprocedure,'fixture_retraction_catalog(uuid,jsonb,text)'::regprocedure)`)
      registered = true
      await pool.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,'{"kind":"native","moduleKey":"native"}','memory','native')`, [workspaceId])
      await pool.query(`INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,'editor',$2)`, [workspaceId, userId])
      // A catalog registration invalidates previous field evidence. Create this
      // exact-field revocation target under the installed contract and grant.
      const fieldTarget = await createMemory({ assistantId, userId, summary: 'Fictional field policy target', sensitivity: 'internal', createdByUserId: userId })
      const fieldBefore = (await pool.query('SELECT retracted_at,valid_to,scope_version,scope_held FROM memories WHERE id=$1', [fieldTarget.id])).rows[0]
      const granted = await repo.readMemoryForRetraction(workspaceId, fieldTarget.id, await authority())
      expect(granted?.scopeVersion).toBe(fieldTarget.scopeVersion)
      const fieldMask = await withNativeTransaction(client => client.query(`SELECT read_native_application_field_mask($1,'{"kind":"native","moduleKey":"native"}','memory',$2,$3) AS mask`, [workspaceId, fieldTarget.id, granted!.scopeVersion]))
      expect(fieldMask.rows[0].mask.writeFields).toEqual(expect.arrayContaining(['retracted_at', 'retracted_reason', 'retracted_by', 'valid_to']))
      await pool.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND module_key='native'", [workspaceId])
      await expect(repo.applySoftRetract({ ...input, memoryId: fieldTarget.id, operation: { authority: await authority(), expectedVersion: granted!.scopeVersion! } })).rejects.toThrow('scope_operation_denied')
      expect((await pool.query('SELECT retracted_at,valid_to,scope_version,scope_held FROM memories WHERE id=$1', [fieldTarget.id])).rows[0]).toEqual(fieldBefore)
      expect(await snapshot()).toEqual(before)
      expect((await pool.query('SELECT id FROM correction_audit WHERE workspace_id=$1 AND row_id=ANY($2::uuid[])', [workspaceId, [memory.id,fieldTarget.id]])).rows).toEqual([])
    } finally {
      await pool.query("DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND module_key='native'", [workspaceId])
      await pool.query("DELETE FROM application_native_role_assignments WHERE workspace_id=$1 AND module_key='native'", [workspaceId])
      if (registered) await pool.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
      await pool.query('DROP FUNCTION IF EXISTS fixture_retraction_reader(uuid,jsonb,text,text);DROP FUNCTION IF EXISTS fixture_retraction_catalog(uuid,jsonb,text)')
    }
  })

  it('memories: as_of clamps the chain and identifies the version active at the pivot', async () => {
    const v1 = await createMemory({
      assistantId, userId,
 summary: 'V1', sensitivity: 'internal', createdByUserId: userId,
    })
    await new Promise((r) => setTimeout(r, 30))
    const v2 = await updateMemory(v1.id, { summary: 'V2' })
    // Pivot between v1 creation and v2 creation — v1 should look like the head.
    const v2Row = await pool.query<{ valid_from: Date }>(
      `SELECT valid_from FROM memories WHERE id = $1`,
      [v2!.id],
    )
    const pivot = new Date(v2Row.rows[0].valid_from.getTime() - 10).toISOString()

    const factory = store.createDbRowHistoryStore()
    const snapshot = await factory.getRowHistory(await actor(), {
      primitive: 'memories', row_id: v1.id, as_of: pivot,
    })
    expect(snapshot!.data.chain.map((r) => r.id)).toEqual([v1.id])
    expect(snapshot!.data.current_id).toBe(v1.id)
  })

  it('memories: invalid as_of throws a typed error', async () => {
    const factory = store.createDbRowHistoryStore()
    await expect(
      factory.getRowHistory(await actor(), {
        primitive: 'memories', row_id: UNKNOWN_UUID, as_of: 'not-a-date',
      }),
    ).rejects.toThrow(/as_of/)
  })

  it('tasks: superseded chain with display fields', async () => {
    const t1 = await withNativeAccess(access => tasksDb.createTask(userId, {
      workspaceId, title: 'T1', status: 'todo', access,
    }))
    const t2 = await withNativeAccess(access => tasksDb.updateTask(userId, t1.id, { title: 'T2' }, undefined, { access }))
    const t3 = await withNativeAccess(access => tasksDb.updateTask(userId, t2!.id, { status: 'done' }, undefined, { access }))

    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(await actor(), { primitive: 'tasks', row_id: t1.id })
    expect(result).not.toBeNull()
    const chain = result!.data.chain
    expect(chain.map((r) => r.id)).toEqual([t1.id, t2!.id, t3!.id])
    expect(chain[0].status).toBe('superseded')
    expect(chain[2].status).toBe('active')
    expect(chain[2].display).toMatchObject({ title: 'T2', status: 'done' })
    expect(result!.data.current_id).toBe(t3!.id)
    expect(chain.every((r) => r.created_by_user_id === userId)).toBe(true)
  })

  it('workspace_files: history with sensitivity tags carried through', async () => {
    const files = await import('../workspace-files.js')
    const f1 = await withNativeAccess(access => files.createWorkspaceFile(userId, {
      workspaceId,
      path: '/draft.md',
      parentPath: '/',
      name: 'draft.md',
      mime: 'text/markdown',
      sizeBytes: 10,
      storageUri: 'gs://bucket/draft.md-v1',
      title: 'Draft v1',
      tags: ['draft'],
      sensitivity: 'internal',
      // WU-4.5 authorship enforcement requires this on every insert.
      createdByUserId: userId,
    }, { access }))
    // Rename variant — the history chain is what this test asserts, so the
    // successor moves paths. (Path-stable supersession is exercised in
    // workspace-files-supersession.integration.test.ts.)
    const f2 = await withNativeAccess(access => files.supersedeWorkspaceFile(userId, workspaceId, f1.id, {
      editorUserId: userId,
      storageUri: 'gs://bucket/draft.md-v2',
      sizeBytes: 12,
      path: '/draft-v2.md',
      name: 'draft-v2.md',
      title: 'Draft v2',
      tags: ['draft'],
    }, access))

    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(await actor(), {
      primitive: 'workspace_files', row_id: f1.id,
    })
    expect(result).not.toBeNull()
    const chain = result!.data.chain
    expect(chain).toHaveLength(2)
    expect(chain[0].status).toBe('superseded')
    expect(chain[1].status).toBe('active')
    expect(chain[1].display).toMatchObject({ title: 'Draft v2' })
    expect(result!.data.current_id).toBe(f2!.id)
  })

  it('entities: maintained supersession chain walks correctly', async () => {
    const e1 = await withNativeAccess(() => entities.createEntity({
      kind: 'project', displayName: 'Fictional project v1', workspaceId, userId,
      createdByUserId: userId, source: 'user',
    }))
    const e2 = (await withNativeAccess(() => entities.supersedeEntity(userId, e1.id,
      { displayName: 'Fictional project v2', attributes: e1.attributes })))!
    expect(e2).not.toBeNull()

    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(await actor(), { primitive: 'entities', row_id: e1.id })
    expect(result).not.toBeNull()
    const chain = result!.data.chain
    expect(chain.map((r) => r.id)).toEqual([e1.id, e2.id])
    expect(chain[0].status).toBe('superseded')
    expect(chain[1].status).toBe('active')
    expect(chain[0].superseded_by).toBe(e2.id)
    expect(chain[0].display).toMatchObject({ kind: 'project', displayName: 'Fictional project v1' })
    expect(result!.data.current_id).toBe(e2.id)
  })

  // CRM aliases share the canonical entity walker. Canonical duplicate merge,
  // rather than an owner-forged edge, creates the audited supersession chain.

  it('companies: the companies primitive walks the entity supersession chain', async () => {
    const c1 = await withNativeAccess(() => crm.createCompany(userId, { workspaceId, name: 'CoA' }))
    const c2 = await withNativeAccess(() => crm.createCompany(userId, { workspaceId, name: 'CoB' }))
    await mergeForHistory(c1.id, c2.id)

    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(await actor(), { primitive: 'companies', row_id: c1.id })
    expect(result).not.toBeNull()
    const chain = result!.data.chain
    expect(chain.map((r) => r.id)).toEqual([c1.id, c2.id])
    expect(chain[0].status).toBe('superseded')
    expect(chain[1].status).toBe('active')
    expect(chain[0].display).toMatchObject({ kind: 'company', displayName: 'CoA' })
    expect(chain[1].display).toMatchObject({ kind: 'company', displayName: 'CoB' })
    expect(result!.data.current_id).toBe(c2.id)
  })

  it('contacts: the contacts primitive walks the entity chain (kind=person)', async () => {
    const c1 = await withNativeAccess(() => crm.createContact(userId, { workspaceId, name: 'PersonA' }))
    const c2 = await withNativeAccess(() => crm.createContact(userId, { workspaceId, name: 'PersonB' }))
    await mergeForHistory(c1.id, c2.id)

    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(await actor(), { primitive: 'contacts', row_id: c1.id })
    expect(result!.data.chain).toHaveLength(2)
    expect(result!.data.chain[0].display).toMatchObject({ kind: 'person', displayName: 'PersonA' })
    expect(result!.data.chain[1].display).toMatchObject({ kind: 'person', displayName: 'PersonB' })
    expect(result!.data.current_id).toBe(c2.id)
  })

  it('deals: the deals primitive walks the entity chain (kind=deal)', async () => {
    const d1 = await withNativeAccess(() => crm.createDeal(userId, { workspaceId, stage: 'qualified' }))
    const d2 = await withNativeAccess(() => crm.createDeal(userId, { workspaceId, stage: 'proposal' }))
    await mergeForHistory(d1.id, d2.id)

    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(await actor(), { primitive: 'deals', row_id: d1.id })
    expect(result!.data.chain.map((r) => r.id)).toEqual([d1.id, d2.id])
    expect(result!.data.chain[0].status).toBe('superseded')
    expect(result!.data.chain[1].status).toBe('active')
    expect(result!.data.chain.every((r) => r.display.kind === 'deal')).toBe(true)
    expect(result!.data.current_id).toBe(d2.id)
  })
})
