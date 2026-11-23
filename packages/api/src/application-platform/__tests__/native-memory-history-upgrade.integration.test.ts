import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import pg from 'pg'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { getAppPool, getPool } from '../../db/client.js'
import { createMemory, getMemoryHistory, updateMemory } from '../../db/memories.js'
import { readRetainedQueryFrame } from '../../db/session-context-revisions.js'
import { createPersonalWebSession } from '../../db/sessions.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'

const phase = process.env.BRIAN_MEMORY_HISTORY_UPGRADE_PHASE
const checkpoint = process.env.BRIAN_MEMORY_HISTORY_UPGRADE_CHECKPOINT
if (phase || checkpoint) {
  const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
  await assertLocalFixture()
  if (!checkpoint || (phase !== 'seed' && phase !== 'read')) throw new Error('Run scripts/crm/memory-history-upgrade.mjs')
}
type Seed = { workspaceId: string; userId: string; assistantId: string; ids: string[] }
const pool = getPool()
afterAll(async () => {
  if (phase) { await getAppPool().end(); await pool.end() }
})

describe.skipIf(!phase)('[COMP:corrections/row-history] 99-version legacy upgrade', () => {
  it.skipIf(phase !== 'seed')('writes 99 admissible versions on the historical schema', async () => {
    expect((await pool.query("SELECT to_regprocedure('public.require_conversation_record_retention_current()') AS guard")).rows[0].guard).toBeNull()
    const [workspaceId,userId,assistantId] = [randomUUID(),randomUUID(),randomUUID()]
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional Memory upgrade',$2,false)", [workspaceId,userId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspaceId,userId])
    await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional upgrade assistant',$2,$3,'primary','confidential')", [assistantId,userId,workspaceId])
    const access = { workspaceId,userId,assistantId,assistantKind:'primary' as const }
    let head = await createMemory({ ...access,summary:'Fictional history',sensitivity:'internal',createdByUserId:userId })
    const ids = [head.id]
    for (let version = 2; version <= 99; version++) {
      const next = await updateMemory(head.id,{},access)
      if (!next) throw new Error(`Historical memory writer did not return version ${version}`)
      head = next
      ids.push(head.id)
    }
    const seed: Seed = { workspaceId,userId,assistantId,ids }
    await writeFile(checkpoint!,JSON.stringify(seed),{ mode: 0o600 })
  },120_000)

  it.skipIf(phase !== 'read')('retains all 99 versions with the same scalar observations and bounded projection queries', async () => {
    const { workspaceId,userId,assistantId,ids } = JSON.parse(await readFile(checkpoint!,'utf8')) as Seed
    const auth = await authSessionStore.create(userId,{deviceLabel:'Fictional upgrade device',userAgent:'Fixture',ipAddress:'127.0.0.1'})
    if (!auth) throw new Error('The upgrade fixture requires an actual device session')
    const credential = { userId,sessionId:auth.id,authVersion:auth.authVersion }
    const session = await createPersonalWebSession({assistantId,userId,workspaceId,channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
      { actorUserId:userId,authSessionId:auth.id,authVersion:auth.authVersion })
    const assistant = await findAssistantById(assistantId)
    if (!assistant) throw new Error('The upgrade fixture requires the original assistant')
    const { executionContext:execution } = await resolveExecutionContextSystem({
      userId,workspaceId,assistant,memberMode:'member',sharedAudience:false,session,sessionAuthority:session,
      identity:{kind:'attended',principal:{kind:'workspace_member',userId,authenticationKind:'native_session'}},ownership:{kind:'workspace',workspaceId},
      lifecycle:{sessionId:session.id,sessionPersisted:true,channelType:'web',channelId:session.channelId,abortSignal:new AbortController().signal},
      credentialCurrent:async()=>!!await authSessionStore.validateAccess(credential),
    })
    const sourceId = ids[49]
    const expected = await getMemoryHistory(sourceId)
    expect(expected.chain.map(row=>row.id)).toEqual(ids)
    const statements = vi.spyOn(pg.Client.prototype,'query')
    const host = () => ({execution,accumulator:new ContextScopeAccumulator()})
    let actual
    try {
      const started = performance.now()
      actual = await getMemoryHistory(sourceId,execution.security.access,host())
      expect(actual).toEqual(expected)
      const projections = statements.mock.calls.filter(call=>String(call[0]).includes('read_native_memory_history_projection('))
      expect(projections.map(([,params])=>(params as [string,string[],string[]])[1].length)).toEqual([...Array(12).fill(8),3])
      const evidenceBatches = statements.mock.calls.filter(call=>String(call[0]).includes('SELECT capture_conversation_preparation('))
      expect(evidenceBatches.length).toBeGreaterThan(0)
      for (const [,params] of evidenceBatches) {
        const cohorts = JSON.parse((params as [string,string])[1]) as unknown[][]
        expect(cohorts.length).toBeLessThanOrEqual(8)
        expect(cohorts.every(cohort=>cohort.length===1)).toBe(true)
      }
      const scalarEvidence = statements.mock.calls.filter(([sql,params])=>String(sql).includes('SELECT capture_conversation_evidence(')
        && (JSON.parse((params as [string,string])[1]) as unknown[]).length===1)
      expect(scalarEvidence).toEqual([])
      console.log(JSON.stringify({ versions:actual.chain.length,projectionStatements:projections.length,
        purposeProofStatements:evidenceBatches.length,elapsedMs:Math.round(performance.now()-started) }))
    } finally { statements.mockRestore() }
    await readRetainedQueryFrame(host(),[],async client=>{
      const sources: ScopeSource[] = []
      for (const row of actual.chain) {
        const scalar = (await client.query('SELECT read_native_memory_history_projection($1,$2,$3) AS value',
          [workspaceId,row.id,row.scopeVersion])).rows[0].value
        expect(scalar.row).toMatchObject({id:row.id,summary:row.summary,workspace_id:workspaceId})
        expect(scalar.sources).toEqual(boundScopeSources(row))
        sources.push(...scalar.sources)
      }
      return {value:true,sources}
    })
  },240_000)
})
