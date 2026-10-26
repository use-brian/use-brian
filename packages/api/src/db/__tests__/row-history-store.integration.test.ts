import { describe, it, expect, afterAll, afterEach, beforeEach } from 'vitest'
import { ContextScopeAccumulator, createCorrectionTools, executionToolContext, type AccessContext, type RetrievalActor } from '@use-brian/core'
import { getAppPool, getPool, runWithAgentAccess } from '../client.js'
import * as store from '../row-history-store.js'
import * as tasksDb from '../tasks.js'
import * as crm from '../crm.js'
import * as entities from '../entities-store.js'
import { createDbMemoryStore } from '../memory-store.js'
import { createMemoryRetractionStore } from '../retraction-store.js'
import { createSoftDeleteStore } from '../soft-delete-store.js'
import { createSensitivityReclassificationStore } from '../sensitivity-reclassification-store.js'
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
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000'

afterAll(async () => { await getAppPool().end(); await pool.end() })

describe.sequential('[COMP:corrections/row-history] unified getRowHistory dispatch', () => {
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
    credential = Object.freeze({ userId, sessionId: auth.id, authVersion: auth.authVersion })
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
      credentialCurrent: async () => !!await authSessionStore.validateAccess(credential) })
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

  // CRM aliases share the canonical entity walker. Canonical supersession
  // creates their audited physical chain through the existing writer.

  it('companies: the companies primitive walks the entity supersession chain', async () => {
    const c1 = await withNativeAccess(() => crm.createCompany(userId, { workspaceId, name: 'CoA' }))
    const c2 = (await withNativeAccess(() => entities.supersedeEntity(userId,c1.id,{displayName:'CoB',attributes:{}})))!

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
    const c2 = (await withNativeAccess(() => entities.supersedeEntity(userId,c1.id,{displayName:'PersonB',attributes:{}})))!

    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(await actor(), { primitive: 'contacts', row_id: c1.id })
    expect(result!.data.chain).toHaveLength(2)
    expect(result!.data.chain[0].display).toMatchObject({ kind: 'person', displayName: 'PersonA' })
    expect(result!.data.chain[1].display).toMatchObject({ kind: 'person', displayName: 'PersonB' })
    expect(result!.data.current_id).toBe(c2.id)
  })

  it('deals: the deals primitive walks the entity chain (kind=deal)', async () => {
    const d1 = await withNativeAccess(() => crm.createDeal(userId, { workspaceId, stage: 'qualified' }))
    const d2 = (await withNativeAccess(() => entities.supersedeEntity(userId,d1.id,{attributes:{stage:'proposal'}})))!

    const factory = store.createDbRowHistoryStore()
    const result = await factory.getRowHistory(await actor(), { primitive: 'deals', row_id: d1.id })
    expect(result!.data.chain.map((r) => r.id)).toEqual([d1.id, d2.id])
    expect(result!.data.chain[0].status).toBe('superseded')
    expect(result!.data.chain[1].status).toBe('active')
    expect(result!.data.chain.every((r) => r.display.kind === 'deal')).toBe(true)
    expect(result!.data.current_id).toBe(d2.id)
  })
})
